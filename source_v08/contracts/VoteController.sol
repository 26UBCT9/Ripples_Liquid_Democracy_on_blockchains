// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

interface ICitizenRegistry {
    function isCitizen(address account) external view returns (bool);
}

interface IDelegationRegistry {
    function getPastDelegate(address voter, uint8 topicId, uint48 timepoint) external view returns (address);
    function getPastInboundWeight(address delegatee, uint8 topicId, uint48 timepoint) external view returns (uint256);
}

/// @title VoteController
/// @notice Voting papers, direct live ballots (public and anonymous), and the
///         order-independent one-hop-override tally.
///
/// Lifecycle (v0.8): a paper is LIVE the moment it is created.
///   Voting (creation -> votingEnd): cast ballots at any time, public or
///     anonymous. Ballots are tallied immediately; results are live and
///     publicly visible while voting runs (an accepted trade-off: usability
///     over tally secrecy).
///   Ended: the tally is final; anyone may finalize.
///
/// The delegation snapshot is the second BEFORE creation: a paper counts the
/// standing delegations as they were when it was published. Delegation changes
/// made afterwards apply from the next paper onwards.
///
/// Topics (fixed ids 0..7):
/// 0 Economy & Public Finance, 1 Health & Social Welfare,
/// 2 Education, Research & Culture, 3 Environment, Energy & Transport,
/// 4 Foreign Affairs & Defence, 5 Migration & Integration,
/// 6 Security, Justice & Civil Rights, 7 Society, Family & Ethics.
contract VoteController is ERC2771Context, AccessControl {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    uint8 public constant NUM_TOPICS = 8;

    enum Phase {
        Voting,
        Ended,
        Cancelled
    }

    struct Paper {
        string title;
        uint48 snapshot; // delegation snapshot: one second before creation
        uint48 votingEnd;
        bool cancelled;
        bool finalized;
        uint256[] matterIds;
    }

    struct Matter {
        uint256 paperId;
        uint8 topicId;
        string text;
        uint128 yes;
        uint128 no;
    }

    struct MatterInput {
        uint8 topicId;
        string text;
    }

    ICitizenRegistry public immutable citizens;
    IDelegationRegistry public immutable delegations;
    ISemaphore public immutable semaphore;

    uint256 public paperCount;
    uint256 public matterCount;
    mapping(uint256 => Paper) private _papers;
    mapping(uint256 => Matter) private _matters;

    // paper => topic => semaphore group id + 1 (0 means: topic not on this paper)
    mapping(uint256 => mapping(uint8 => uint256)) private _groupIdPlusOne;

    // paper => topic => voter registered for anonymous voting (public info by design)
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public anonMode;

    // paper => topic => voter has cast at least one public ballot. Blocks a later
    // switch into anonymity for the same topic, which could double a ballot.
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public hasPublicBallot;

    // matter => voter => already voted publicly
    mapping(uint256 => mapping(address => bool)) public publicVoted;

    // Tally bookkeeping for the order-independent override arithmetic:
    // matter => delegate => encoded cast choice (0 unset, 1 yes, 2 no)
    mapping(uint256 => mapping(address => uint8)) public delegateChoice;
    // matter => delegate => nr of their snapshot delegators who voted themselves
    mapping(uint256 => mapping(address => uint256)) public overrideCount;

    event PaperCreated(uint256 indexed paperId, string title, uint48 snapshot, uint48 votingEnd);
    event MatterCreated(uint256 indexed paperId, uint256 indexed matterId, uint8 indexed topicId, string text);
    event PaperCancelled(uint256 indexed paperId);
    event PaperFinalized(uint256 indexed paperId);
    event AnonymousRegistered(uint256 indexed paperId, uint8 indexed topicId, address indexed voter);
    event PublicVote(uint256 indexed matterId, address indexed voter, bool choice, uint256 weightAdded);
    event AnonymousVote(uint256 indexed matterId, bool choice);

    constructor(
        address trustedForwarder,
        address admin,
        address citizenRegistry,
        address delegationRegistry,
        address semaphore_
    ) ERC2771Context(trustedForwarder) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CREATOR_ROLE, admin);
        citizens = ICitizenRegistry(citizenRegistry);
        delegations = IDelegationRegistry(delegationRegistry);
        semaphore = ISemaphore(semaphore_);
    }

    // ------------------------------------------------------------ government

    /// @notice Create a voting paper with its matters in one atomic call.
    ///         Voting opens immediately and the tally is live. A Semaphore
    ///         group is created for every distinct topic present.
    function createPaper(
        string calldata title,
        uint48 votingEnd,
        MatterInput[] calldata matters
    ) external onlyRole(CREATOR_ROLE) returns (uint256 paperId) {
        require(matters.length > 0, "no matters");
        require(block.timestamp < votingEnd, "bad deadline");

        paperId = ++paperCount;
        Paper storage p = _papers[paperId];
        p.title = title;
        // One second before creation: always strictly in the past, so the
        // checkpointed registries can be queried immediately and consistently.
        p.snapshot = uint48(block.timestamp - 1);
        p.votingEnd = votingEnd;

        emit PaperCreated(paperId, title, p.snapshot, votingEnd);

        for (uint256 i = 0; i < matters.length; i++) {
            uint8 topicId = matters[i].topicId;
            require(topicId < NUM_TOPICS, "bad topic");
            uint256 matterId = ++matterCount;
            Matter storage m = _matters[matterId];
            m.paperId = paperId;
            m.topicId = topicId;
            m.text = matters[i].text;
            p.matterIds.push(matterId);

            if (_groupIdPlusOne[paperId][topicId] == 0) {
                uint256 groupId = semaphore.createGroup();
                _groupIdPlusOne[paperId][topicId] = groupId + 1;
            }
            emit MatterCreated(paperId, matterId, topicId, matters[i].text);
        }
    }

    function cancel(uint256 paperId) external onlyRole(CREATOR_ROLE) {
        require(_papers[paperId].votingEnd != 0, "no paper");
        _papers[paperId].cancelled = true;
        emit PaperCancelled(paperId);
    }

    /// @notice Freeze the result once the voting window has passed. Callable by anyone.
    function finalize(uint256 paperId) external {
        require(phaseOf(paperId) == Phase.Ended, "not ended");
        Paper storage p = _papers[paperId];
        require(!p.finalized, "already finalized");
        p.finalized = true;
        emit PaperFinalized(paperId);
    }

    // ------------------------------------------------------ anonymity opt-in

    /// @notice Opt into anonymous voting for one topic of one paper by
    ///         inserting a Semaphore identity commitment, any time during the
    ///         voting window. Requires (spec Rule 1, checked at the snapshot)
    ///         that the voter neither delegated the topic nor receives
    ///         delegations for it, and has not already voted publicly on it.
    function registerAnonymous(uint256 paperId, uint8 topicId, uint256 identityCommitment) external {
        address voter = _msgSender();
        require(phaseOf(paperId) == Phase.Voting, "not voting phase");
        require(citizens.isCitizen(voter), "not a citizen");
        uint256 g = _groupIdPlusOne[paperId][topicId];
        require(g != 0, "topic not on paper");
        require(!anonMode[paperId][topicId][voter], "already registered");
        require(!hasPublicBallot[paperId][topicId][voter], "already voted publicly this topic");

        uint48 snapshot = _papers[paperId].snapshot;
        require(delegations.getPastDelegate(voter, topicId, snapshot) == address(0), "delegated this topic");
        require(delegations.getPastInboundWeight(voter, topicId, snapshot) == 0, "is a delegate for this topic");

        anonMode[paperId][topicId][voter] = true;
        semaphore.addMember(g - 1, identityCommitment);
        emit AnonymousRegistered(paperId, topicId, voter);
    }

    // ---------------------------------------------------------------- voting

    /// @notice Cast a public ballot. Tallied immediately, including the
    ///         one-hop override arithmetic. O(1), order independent.
    function votePublic(uint256 matterId, bool choice) external {
        address voter = _msgSender();
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Voting, "not voting phase");
        require(citizens.isCitizen(voter), "not a citizen");
        require(!anonMode[m.paperId][m.topicId][voter], "registered anonymous for topic");
        require(!publicVoted[matterId][voter], "already voted");
        publicVoted[matterId][voter] = true;
        hasPublicBallot[m.paperId][m.topicId][voter] = true;

        uint48 snapshot = _papers[m.paperId].snapshot;
        address d = delegations.getPastDelegate(voter, m.topicId, snapshot);
        uint256 w = delegations.getPastInboundWeight(voter, m.topicId, snapshot);

        // Own vote, plus (as a delegate) the inbound weight that has not been
        // overridden yet. Later overrides subtract directly via delegateChoice.
        uint256 add = 1;
        if (w > 0) {
            add += w - overrideCount[matterId][voter];
            delegateChoice[matterId][voter] = choice ? 1 : 2;
        }
        _addTally(m, choice, add);

        // If the voter had delegated this topic, this ballot is the override.
        if (d != address(0)) {
            uint8 dc = delegateChoice[matterId][d];
            if (dc != 0) {
                _subTally(m, dc == 1, 1);
            } else {
                overrideCount[matterId][d] += 1;
            }
        }
        emit PublicVote(matterId, voter, choice, add);
    }

    /// @notice Cast an anonymous ballot (weight exactly 1, spec Rule 1). The
    ///         Semaphore proof authorizes the ballot (group membership + fresh
    ///         nullifier); the choice is bound into the proof as its message so
    ///         a relayer cannot flip it. Never submit this through the
    ///         forwarder with a voter signature.
    function voteAnonymous(uint256 matterId, ISemaphore.SemaphoreProof calldata proof, bool choice) external {
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Voting, "not voting phase");
        require(proof.scope == scopeOf(matterId), "wrong scope");
        require(proof.message == (choice ? 1 : 2), "message is not the choice");

        uint256 g = _groupIdPlusOne[m.paperId][m.topicId];
        // reverts on invalid proof, stale root, or reused nullifier
        semaphore.validateProof(g - 1, proof);

        _addTally(m, choice, 1);
        emit AnonymousVote(matterId, choice);
    }

    // ----------------------------------------------------------------- views

    function phaseOf(uint256 paperId) public view returns (Phase) {
        Paper storage p = _papers[paperId];
        require(p.votingEnd != 0, "no paper");
        if (p.cancelled) return Phase.Cancelled;
        if (block.timestamp <= p.votingEnd) return Phase.Voting;
        return Phase.Ended;
    }

    /// @notice The delegation snapshot timepoint of a paper (one second before
    ///         its creation).
    function snapshotOf(uint256 paperId) external view returns (uint48) {
        require(_papers[paperId].votingEnd != 0, "no paper");
        return _papers[paperId].snapshot;
    }

    function getPaper(uint256 paperId)
        external
        view
        returns (
            string memory title,
            uint48 snapshot,
            uint48 votingEnd,
            bool cancelled,
            bool finalized,
            uint256[] memory matterIds
        )
    {
        Paper storage p = _papers[paperId];
        require(p.votingEnd != 0, "no paper");
        return (p.title, p.snapshot, p.votingEnd, p.cancelled, p.finalized, p.matterIds);
    }

    function getMatter(uint256 matterId)
        external
        view
        returns (uint256 paperId, uint8 topicId, string memory text, uint128 yes, uint128 no)
    {
        Matter storage m = _requireMatter(matterId);
        return (m.paperId, m.topicId, m.text, m.yes, m.no);
    }

    /// @notice Semaphore group id for (paper, topic). Reverts if the topic is
    ///         not on the paper.
    function groupIdOf(uint256 paperId, uint8 topicId) external view returns (uint256) {
        uint256 g = _groupIdPlusOne[paperId][topicId];
        require(g != 0, "topic not on paper");
        return g - 1;
    }

    /// @notice Semaphore proof scope for a matter: one nullifier per identity
    ///         and matter, while the same identity can vote on every matter.
    function scopeOf(uint256 matterId) public view returns (uint256) {
        Matter storage m = _requireMatter(matterId);
        return uint256(keccak256(abi.encode(m.paperId, matterId)));
    }

    // ------------------------------------------------------------- internals

    function _requireMatter(uint256 matterId) private view returns (Matter storage m) {
        m = _matters[matterId];
        require(m.paperId != 0, "no matter");
    }

    function _addTally(Matter storage m, bool yes_, uint256 amount) private {
        if (yes_) m.yes += uint128(amount);
        else m.no += uint128(amount);
    }

    function _subTally(Matter storage m, bool yes_, uint256 amount) private {
        if (yes_) m.yes -= uint128(amount);
        else m.no -= uint128(amount);
    }

    // --------------------------------------------- ERC2771 / Context plumbing

    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}

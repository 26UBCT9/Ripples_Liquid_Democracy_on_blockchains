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
/// @notice Voting papers, commit-reveal ballots (public and anonymous), and the
///         order-independent one-hop-override tally.
///
/// Lifecycle (v0.5): a paper is LIVE the moment it is created.
///   Voting (creation -> votingEnd): commit public ballots, or opt into
///     anonymity for a topic and commit anonymous ballots, at any time.
///   Reveal (votingEnd -> revealEnd): ballots are opened and tallied.
///   Ended: result final, anyone may finalize.
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
        Reveal,
        Ended,
        Cancelled
    }

    struct Paper {
        string title;
        uint48 snapshot; // delegation snapshot: one second before creation
        uint48 votingEnd;
        uint48 revealEnd;
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

    // paper => topic => voter has at least one public commitment. Blocks a later
    // switch into anonymity for the same topic, which could double a ballot.
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public hasPublicBallot;

    // matter => voter => ballot commitment / reveal flag (public path)
    mapping(uint256 => mapping(address => bytes32)) public publicCommitOf;
    mapping(uint256 => mapping(address => bool)) public publicRevealed;

    // matter => anonymous ballot commitments / reveal flags (by index)
    mapping(uint256 => bytes32[]) private _anonCommits;
    mapping(uint256 => mapping(uint256 => bool)) public anonRevealed;

    // Tally bookkeeping for the order-independent override arithmetic:
    // matter => delegate => encoded revealed choice (0 unset, 1 yes, 2 no)
    mapping(uint256 => mapping(address => uint8)) public delegateChoice;
    // matter => delegate => nr of their snapshot delegators who revealed themselves
    mapping(uint256 => mapping(address => uint256)) public overrideCount;

    event PaperCreated(uint256 indexed paperId, string title, uint48 snapshot, uint48 votingEnd, uint48 revealEnd);
    event MatterCreated(uint256 indexed paperId, uint256 indexed matterId, uint8 indexed topicId, string text);
    event PaperCancelled(uint256 indexed paperId);
    event PaperFinalized(uint256 indexed paperId);
    event AnonymousRegistered(uint256 indexed paperId, uint8 indexed topicId, address indexed voter);
    event PublicCommit(uint256 indexed matterId, address indexed voter);
    event AnonymousCommit(uint256 indexed matterId, uint256 index, bytes32 commitment);
    event PublicReveal(uint256 indexed matterId, address indexed voter, bool choice, uint256 weightAdded);
    event AnonymousReveal(uint256 indexed matterId, uint256 index, bool choice);

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
    ///         Voting opens immediately. A Semaphore group is created for
    ///         every distinct topic present.
    function createPaper(
        string calldata title,
        uint48 votingEnd,
        uint48 revealEnd,
        MatterInput[] calldata matters
    ) external onlyRole(CREATOR_ROLE) returns (uint256 paperId) {
        require(matters.length > 0, "no matters");
        require(block.timestamp < votingEnd && votingEnd < revealEnd, "bad deadlines");

        paperId = ++paperCount;
        Paper storage p = _papers[paperId];
        p.title = title;
        // One second before creation: always strictly in the past, so the
        // checkpointed registries can be queried immediately and consistently.
        p.snapshot = uint48(block.timestamp - 1);
        p.votingEnd = votingEnd;
        p.revealEnd = revealEnd;

        emit PaperCreated(paperId, title, p.snapshot, votingEnd, revealEnd);

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

    /// @notice Freeze the result once the reveal window has passed. Callable by anyone.
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

    /// @notice Commit a public ballot: commitment = keccak256(abi.encode(matterId, voter, choice, salt)).
    function commitPublic(uint256 matterId, bytes32 commitment) external {
        address voter = _msgSender();
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Voting, "not voting phase");
        require(citizens.isCitizen(voter), "not a citizen");
        require(!anonMode[m.paperId][m.topicId][voter], "registered anonymous for topic");
        require(publicCommitOf[matterId][voter] == bytes32(0), "already committed");
        require(commitment != bytes32(0), "empty commitment");
        publicCommitOf[matterId][voter] = commitment;
        hasPublicBallot[m.paperId][m.topicId][voter] = true;
        emit PublicCommit(matterId, voter);
    }

    /// @notice Commit an anonymous ballot. The Semaphore proof authorizes the
    ///         ballot (group membership + fresh nullifier); the commitment is
    ///         bound into the proof as its message so a relayer cannot swap it.
    ///         Never submit this through the forwarder with a voter signature.
    ///         Commitment = keccak256(abi.encode(matterId, choice, salt)).
    function commitAnonymous(uint256 matterId, ISemaphore.SemaphoreProof calldata proof, bytes32 commitment) external {
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Voting, "not voting phase");
        require(commitment != bytes32(0), "empty commitment");
        require(proof.scope == scopeOf(matterId), "wrong scope");
        require(proof.message == uint256(commitment), "message is not the commitment");

        uint256 g = _groupIdPlusOne[m.paperId][m.topicId];
        // reverts on invalid proof, stale root, or reused nullifier
        semaphore.validateProof(g - 1, proof);

        _anonCommits[matterId].push(commitment);
        emit AnonymousCommit(matterId, _anonCommits[matterId].length - 1, commitment);
    }

    // ---------------------------------------------------------------- reveal

    /// @notice Reveal a public ballot and tally it, including the one-hop
    ///         override arithmetic. O(1) per reveal, order independent.
    function revealPublic(uint256 matterId, bool choice, bytes32 salt) external {
        address voter = _msgSender();
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Reveal, "not reveal phase");
        bytes32 c = publicCommitOf[matterId][voter];
        require(c != bytes32(0), "no commitment");
        require(!publicRevealed[matterId][voter], "already revealed");
        require(keccak256(abi.encode(matterId, voter, choice, salt)) == c, "reveal does not match commitment");
        publicRevealed[matterId][voter] = true;

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

        // If the voter had delegated this topic, this reveal is the override.
        if (d != address(0)) {
            uint8 dc = delegateChoice[matterId][d];
            if (dc != 0) {
                _subTally(m, dc == 1, 1);
            } else {
                overrideCount[matterId][d] += 1;
            }
        }
        emit PublicReveal(matterId, voter, choice, add);
    }

    /// @notice Reveal an anonymous ballot (weight exactly 1, spec Rule 1).
    ///         Permissionless: binding to a sender would deanonymize.
    function revealAnonymous(uint256 matterId, uint256 index, bool choice, bytes32 salt) external {
        Matter storage m = _requireMatter(matterId);
        require(phaseOf(m.paperId) == Phase.Reveal, "not reveal phase");
        require(index < _anonCommits[matterId].length, "bad index");
        require(!anonRevealed[matterId][index], "already revealed");
        require(keccak256(abi.encode(matterId, choice, salt)) == _anonCommits[matterId][index], "reveal does not match commitment");
        anonRevealed[matterId][index] = true;
        _addTally(m, choice, 1);
        emit AnonymousReveal(matterId, index, choice);
    }

    // ----------------------------------------------------------------- views

    function phaseOf(uint256 paperId) public view returns (Phase) {
        Paper storage p = _papers[paperId];
        require(p.votingEnd != 0, "no paper");
        if (p.cancelled) return Phase.Cancelled;
        uint256 t = block.timestamp;
        if (t <= p.votingEnd) return Phase.Voting;
        if (t <= p.revealEnd) return Phase.Reveal;
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
            uint48 revealEnd,
            bool cancelled,
            bool finalized,
            uint256[] memory matterIds
        )
    {
        Paper storage p = _papers[paperId];
        require(p.votingEnd != 0, "no paper");
        return (p.title, p.snapshot, p.votingEnd, p.revealEnd, p.cancelled, p.finalized, p.matterIds);
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

    function anonCommitCount(uint256 matterId) external view returns (uint256) {
        return _anonCommits[matterId].length;
    }

    function anonCommitAt(uint256 matterId, uint256 index) external view returns (bytes32) {
        return _anonCommits[matterId][index];
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

# Liquid Voting on Ethereum: Architecture Specification

Version 0.8. Changelog: v0.2 moved the delegation snapshot from paper creation to the end of a dedicated delegation window (section 3); v0.3 wired DelegationRegistry into the gasless meta transaction path (sections 4 and 7); v0.4 folded BallotManager into VoteController (section 4) so Semaphore groups are created atomically with the paper; v0.5 made papers live at creation, removed the delegation and registration windows, moved the snapshot to one second before creation (deliberately reverting the v0.2 trade off, section 3), added the same topic double ballot guard, and shipped M2 (real Semaphore v4 locally, browser proving) plus a frontend demo account switcher; v0.6 gated the frontend views by on chain role (section 8), added a quick issue roster to citizen administration, and replaced the Swiss ballot styling with a neutral design; v0.7 fixed proving for single member anonymity sets (tree depth clamped to at least 1), taught the relayer to decode custom errors into readable messages and to resync its nonce after a chain restart, and moved voting above delegations in the vote view; v0.8 removed commit and reveal entirely by team decision: ballots are cast directly and tallied live, results are publicly visible while voting runs, and the tally is final at votingEnd (sections 1, 3, 4, 5). Stack: Solidity 0.8.x, OpenZeppelin 5.x, Semaphore v4, Hardhat, React with web3.js, Node.js relayer. Networks: Hardhat local first, then Sepolia.

## 1. Locked design decisions

Anonymity level: unlinkable voting via Semaphore v4 zero knowledge group membership proofs. Delegation model: one hop with own vote override. Result visibility: live during the voting window (v0.8 decision). Earlier versions enforced secrecy until close via commit and reveal; the reveal step proved to be the dominant usability cost (a second interaction per matter, forgotten reveals silently becoming abstentions), so the team consciously traded tally secrecy for one step voting. The accepted risks are named in section 3.

Three composition rules resolve the conflicts between these choices.

**Rule 1: anonymity and delegation are mutually exclusive per topic.** A voter may register for anonymous voting on a topic only if, at the snapshot, they have no outgoing delegation for that topic and no incoming delegations for that topic. Two reasons. First, an anonymous ballot cannot be linked to its caster, so the contract could never subtract it from a delegate's tally, which would double count the voter. Second, a delegate voting anonymously with weight w would be instantly identifiable by that weight (weight fingerprinting). Consequence: the own vote override exists on the public path only, and delegates are public figures by design. This is also politically defensible: delegated power should be accountable.

**Rule 2 (v0.8): every ballot is cast directly and tallied immediately.** No commitments, no salts, no reveal window; the tally is live while voting runs and freezes at votingEnd. This deliberately unlocks the original commit and reveal decision. What is gained: one interaction per matter, no lost ballots from forgotten reveals, no salts to keep in a browser. What is knowingly accepted: anyone can watch the running tally, which enables bandwagon effects and strategic late voting. Keeping results genuinely secret until close on a public chain requires either commit and reveal (the previous design, retained in this document's history as the fallback) or threshold/timelock encryption, which is future work territory.

**Rule 3: anonymous transactions never carry the voter's signature.** Public actions (registration, delegation, public votes) travel as ERC 2771 meta transactions signed by the voter and relayed by the government wallet. Anonymous votes are sent to the relayer as raw payloads (proof plus choice) and submitted from the relayer's own account; the zero knowledge proof itself is the authorization, and it binds the choice as the proof message so the relayer cannot flip it. If anonymous payloads were wrapped in a meta transaction signed by the voter, that signature would deanonymize the ballot.

## 2. Trust model

What the chain provides: a publicly verifiable tally, tamper evident ballots, and vote once enforcement through nullifiers and per matter vote flags. What it does not provide: trustless eligibility. The government mints the citizen token, so Sybil resistance is exactly as good as the issuance process. The relayer is a censorship point (mitigation: every function is also callable directly by a voter paying their own gas) and a metadata observer (it sees IP addresses and timing; network level anonymity would need Tor or similar and is out of scope). Receipt freeness is not achieved on the public path: public voters can prove how they voted, which in theory enables vote buying. MACI is the known remedy and is listed as future work.

## 3. Voting paper lifecycle

Voting (from creation), then Ended. A paper is live and open for voting the moment the government publishes it; every ballot is tallied the moment it is cast, the running tally is publicly visible, and the result is final once votingEnd passes.

At creation the government defines title, matters (each with one of the eight fixed topic ids and a text or IPFS CID) and one deadline: votingEnd. There is no delegation window and no registration window (v0.5): delegations are standing state that voters maintain at any time, and each paper simply captures them as they stand at publication. Concretely `snapshot = creation time - 1 second`; the offset keeps the timepoint strictly in the past so the checkpointed registries answer immediately and consistently (their past lookups reject the current second). All delegation lookups for the paper use this snapshot. This deliberately reverts the v0.2 decision: v0.2 placed the snapshot after a delegation window so voters could react to the published matters, but a reaction window and instant voting are mutually exclusive, and liveness won. The trade off returns openly: a delegation set after publication applies from the next paper onwards, and the Vote view says so.

Anonymous voting needs no phase of its own. A voter opts in per topic at any point during the open voting window by inserting an identity commitment into the topic's Semaphore group, provided Rule 1 holds at the snapshot and the voter has not already voted publicly on that topic in this paper (the double ballot guard below). Semaphore v4 keeps a history of recent Merkle roots (default one hour), so proofs generated against a slightly stale root still verify while other members join mid vote. The cost of losing the fixed registration window is honest: an anonymous ballot cast early hides in a smaller set than one cast late, so the UI shows the current set size and warns when it is small.

Because opting into anonymity and voting publicly now share one window, ordering attacks must be excluded in both directions: `anonMode` blocks a later public ballot on the topic, and the `hasPublicBallot[paper][topic][voter]` flag, set on the first public ballot, blocks a later anonymous registration for the same topic. Without it a voter could vote publicly, then register and cast an unlinkable second ballot that nobody can attribute and subtract.

During Voting, ballots (public or anonymous) are accepted and tallied on the spot. After votingEnd the paper is Ended: no further ballots, the tally is the result, and finalize freezes it formally and emits an event the results view listens to.

## 4. Contracts

**CitizenRegistry.** Non transferable ERC 721 following ERC 5192 (Locked event, all transfer paths revert). `issue(address)` is restricted to `ISSUER_ROLE` and backs the manual citizen creation interface. An optional `revoke` covers loss of eligibility.

**DelegationRegistry.** Standing per topic delegations with checkpoints, the same pattern as ERC20Votes. `setDelegate(topicId, delegate)` and `clearDelegate(topicId)` append checkpoints for `delegateOf(voter, topic)` and adjust checkpointed `inboundWeight(delegate, topic)`, so `getPastDelegate` and `getPastInboundWeight` can be queried at any past timepoint. Run the checkpoints on the timestamp clock (ERC 6372) so they can be queried exactly at the phase boundary `snapshotTime`; never mix block based checkpoints with timestamp based phases. Constraints: the delegate must hold the citizen token, self delegation reverts. Like VoteController, the contract inherits `ERC2771Context` and resolves the voter through `_msgSender()` in every function (a single leftover `msg.sender` would attribute the delegation to the forwarder), so delegation changes ride the same gasless meta transaction path as votes. The trusted forwarder address is an immutable constructor argument, so deploy the Forwarder before every contract that trusts it. One hop semantics: inbound weight never flows onward. If your delegate has himself delegated the topic and never votes personally, your weight is simply unused, exactly as if your delegate had abstained.

**BallotManager (merged into VoteController, v0.4).** Paper storage and phase logic live inside VoteController: a paper and the Semaphore group of every topic on it must come into existence in one atomic call, and a separate manager would force cross contract calls at creation for no isolation benefit. The government facing API (createPaper with matters, cancel, finalize, phaseOf, snapshotOf) is unchanged.

**VoteController.** The core contract. It inherits `ERC2771Context`, holds the live tallies and the override logic, and talks to the canonical deployed Semaphore instance. Semaphore assigns sequential group ids at `createGroup()`; the controller stores the mapping and exposes it through `groupIdOf(paperId, topicId)`.

```solidity
function createPaper(string title, uint48 votingEnd, MatterInput[] matters) external;
// CREATOR_ROLE; voting opens immediately; snapshot = block.timestamp - 1;
// creates one Semaphore group per distinct topic on the paper, atomically

function registerAnonymous(uint paperId, uint8 topicId, uint identityCommitment) external;
// requires: SBT, phase == Voting (any time while voting is open), no outbound and
// no inbound delegation for this topic at the snapshot, not yet registered, and
// !hasPublicBallot[paper][topic][voter] (double ballot guard).
// effects: anonMode[paper][topic][voter] = true; Semaphore.addMember(groupId, commitment)

function votePublic(uint matterId, bool choice) external;
// requires: SBT, phase == Voting, !anonMode for the matter's topic, not voted yet.
// effects: tallies immediately incl. override arithmetic (section 5) and sets
// hasPublicBallot[paper][topic][voter]

function voteAnonymous(uint matterId, SemaphoreProof proof, bool choice) external;
// requires: phase == Voting; proof.message == (choice ? 1 : 2) so a relayer
// cannot flip the ballot; Semaphore.validateProof for group(paper, topic(matter))
// with scope = uint(keccak256(paperId, matterId)); Semaphore rejects reused
// nullifiers. Tallied immediately with weight 1

function finalize(uint paperId) external;
```

**Forwarder.** OpenZeppelin `ERC2771Forwarder`. Its EIP 712 request struct already contains nonce and deadline, which covers replay protection for the meta transaction path.

## 5. Tally with one hop override, order independent

Per matter M in topic T the contract keeps `yesTally`, `noTally`, `delegateChoice[M][d]` (unset, yes or no) and `overrideCount[M][d]`.

Public ballot by voter v with choice c. Let `d = getPastDelegate(v, T, snapshot)` and `w = getPastInboundWeight(v, T, snapshot)`.

If v did not delegate T (`d == 0`): add `1 + w - overrideCount[M][v]` to `tally[c]` and set `delegateChoice[M][v] = c`.

If v delegated T (`d != 0`), this ballot is the override: add 1 to `tally[c]`; if `delegateChoice[M][d]` is already set, subtract 1 from that tally, otherwise increment `overrideCount[M][d]` so the delegate's later ballot adds correspondingly less.

A voter can be in both roles at once (he delegated T himself and also carries inbound weight). His ballot then applies both branches: it overrides his own outbound delegation and activates his inbound weight.

Anonymous ballot: always weight exactly 1, add 1 to `tally[c]`. No delegation interaction can exist because of Rule 1.

Every ballot costs O(1) gas and the final tally is independent of voting order. Non voters and inactive delegates contribute nothing.

Worked example. Alice, Ben and Carla delegate Education to Dana; Emil registered anonymously. Dana votes Yes: Yes = 4 (her own vote plus three delegations), visible live. Carla votes No herself: Yes = 3, No = 1. Emil votes No anonymously: No = 2. Ben and Alice do nothing; their weight stays with Dana. Final at votingEnd: Yes 3, No 2.

## 6. Anonymity layer

Semaphore v4 identities are EdDSA key pairs whose commitment is published at registration; groups are Lean Incremental Merkle Trees managed by the canonical Semaphore contract; proofs are Groth16, generated in the browser with `@semaphore-protocol/proof` and verified on chain. Semaphore is already deployed on Sepolia, so reuse the canonical instance (address in the Semaphore docs under Deployed Contracts, docs.semaphore.pse.dev) instead of deploying circuits and verifiers yourself.

Identity derivation without storage: `new Identity(await signer.signMessage("liquid-vote identity v1"))`. The identity is deterministic from the wallet key, recoverable on any device, and nothing sensitive is persisted. Whoever controls the wallet controls the identity.

The proof scope (external nullifier) is `hash(paperId, matterId)`: one anonymous ballot per identity per matter, while the same identity votes on every matter of the paper.

Anonymity set caveats, for the UI and for the report. Unlinkability is only as strong as the group: show "your ballot hides among N anonymous registrants for this topic" and warn below a threshold, for example N < 20. And if all N anonymous ballots on a matter show the same choice, each individual choice is trivially inferable; this statistical disclosure is inherent to any anonymous tally.

## 7. Gasless layer

Public path: the browser signs an EIP 712 forward request (MetaMask `signTypedData`), the relayer validates it and calls `ERC2771Forwarder.execute`, the target contract recovers the voter through `_msgSender()`. Anonymous path: the browser sends `{matterId, proof, choice}` over HTTPS, the relayer pre validates via static call to avoid paying gas for garbage, then submits from its own EOA. The relayer also simulates relayed public calls before execution so reverts keep their reason, decodes custom errors from all known contracts into readable messages, and resyncs its nonce after a chain restart.

The relayer is a small Node/Express service with endpoints `/relay/meta` and `/relay/anonymous`, per IP rate limiting, and a nonce managed transaction queue for the government wallet. On Sepolia it only needs faucet ETH. Delegation changes relayed through `/relay/meta` need one extra policy: votes are naturally bounded at one per voter and matter, delegation flips are not, so an attacker could burn the government's gas by re delegating in a loop. Cap relayed delegation changes per voter and topic within a paper cycle; the self paid path stays uncapped, there the spammer funds himself. Censorship mitigation: since authorization lives entirely in signatures and proofs, any voter can bypass the relayer and submit directly with their own gas.

## 8. Frontend

One React application with four role based views satisfies the four interface requirements without four codebases. The views are gated by on chain state, checked live for the active account: the two administration views render only for holders of CREATOR_ROLE (paper admin) respectively ISSUER_ROLE (citizen admin), the vote view only for citizen token holders, and results for everyone. Gating is a UX courtesy, not security; the contracts enforce the same roles regardless. Vote: open papers first (per matter one Yes/No click, cast and tallied immediately; per topic optionally register for anonymity), standing delegations below, with a voting countdown. Results: papers with phase indicator and live tallies from the first ballot on, marked final after `finalize`. Paper Admin: create papers, add matters under the eight fixed topics, set the single deadline (voting closes). A demo account switcher in the header holds the well known Hardhat dev accounts (government, several voters, one fresh zero ETH voter) with local signing, so one browser can play every role without a wallet extension; MetaMask remains available as an equal session type. Dev keys in the bundle are for local chains only. Citizen Admin: issue the citizen token to an address.

web3.js handles contract calls and EIP 712 signing per requirement. Note that web3.js was sunset by its maintainers in March 2025 in favor of ethers.js and viem; the architecture is library agnostic and a swap is cheap, so document the choice either way. `@semaphore-protocol/core` provides identity, group synchronization (rebuilding the Merkle tree client side from Semaphore contract events) and proof generation.

## 9. Build order

M1, public core: CitizenRegistry, DelegationRegistry with checkpoints, VoteController with public voting and the override arithmetic, Forwarder plus relayer, all four views. This milestone alone is demoable and covers every requirement except unlinkability, which hedges the semester risk.

M2, anonymity (implemented): real Semaphore v4 deployed locally by the deploy script (PoseidonT3, Groth16 verifier, Semaphore), identity derived from one wallet signature, group sync from MemberAdded events, browser proving with bundled wasm/zkey artifacts (depths 1 to 10, CDN fallback), anonymous voting through the relayer (choice bound as the proof message), the weight 1 rule, and set size display with a small set warning.

M3, polish and later additions: voting history view (public history from events; anonymous history reconstructed only client side from the locally derived identity, by design invisible to everyone else), self paid fallback UX, SSI exploration.

## 10. Testing

Local, Hardhat with chai. Tests in place (24 passing): SBT non transferability; delegation checkpoints return correct values at the snapshot, including a delegation set before paper creation (counts) and one set right after (applies to the next paper only); override arithmetic in every voting order (delegate first, delegator first, delegate never votes, and the dual role voter), with the live tally asserted after each ballot; double vote rejection; nullifier reuse rejection; anonMode blocks public ballots per topic; registration reverts when any delegation exists for the topic at the snapshot and when the voter already voted publicly on the topic (double ballot guard); phase gating (ballots and registration accepted only while voting is open, the tally frozen and finalize available after); forwarder replay rejection with a reused nonce and a foreign signature; a delegation set through the forwarder is attributed to the signing voter and never to the relayer or forwarder; and a real proof suite that deploys the genuine Semaphore stack, verifies Groth16 proofs on chain (including a single member set with the depth clamp), exercises mid vote group growth, and rejects outsider roots and relayer choice flips. For Semaphore, run fast suites against a mock verifier and one slow honest suite that deploys the contracts from `@semaphore-protocol/contracts` and generates real proofs.

Sepolia walkthrough. Fund a deployer and the relayer wallet from a Sepolia faucet (Google Cloud or Alchemy faucets work without mainnet balance requirements in most cases). Configure Hardhat with a Sepolia RPC endpoint and the deployer key, deploy, and verify on Etherscan:

```bash
npx hardhat run scripts/deploy.ts --network sepolia
npx hardhat verify --network sepolia <address> <constructor args>
node relayer/index.js   # RELAYER_KEY and RPC_URL in .env
```

Point the VoteController at the canonical Semaphore Sepolia address from the docs. Issue citizen tokens to two or three MetaMask test accounts through the Citizen Admin view. Create a paper with two matters in different topics and a short window, for example voting 30 minutes. Test the snapshot boundary explicitly: delegate before creating the paper and confirm the weight counts, then delegate from another account after publication and confirm this paper is unaffected while the next one picks it up. Walk one account through a delegation and a later override, and a second account through anonymous registration and an anonymous ballot; neither account should ever need ETH. After votingEnd, finalize and cross check the Results view against the contract events on Sepolia Etherscan.

## 11. Known limitations (report and diary material)

Eligibility rests on the government trust root. Receipt freeness is absent on the public path, so vote buying is theoretically possible there, with MACI as the acknowledged remedy. The relayer sees network metadata and could censor, mitigated but not eliminated by the self paid fallback. Small anonymity sets weaken unlinkability, and unanimous anonymous tallies disclose individual choices. The live tally is the consciously accepted v0.8 trade off: voters see the running result while the window is open, so bandwagon effects and strategic late voting are possible by design; the mitigations (commit and reveal, or threshold/timelock encryption) are documented above and in earlier versions of this document. Since v0.5 removed the fixed registration window, early anonymous ballots hide in smaller sets than late ones; the UI warns below N = 20, and voters who care can register and vote late. The demo account switcher ships well known Hardhat keys and stores the fresh voter's key in localStorage, acceptable only on a local chain and stated as such. Finally, on chain Groth16 verification costs roughly 250k to 350k gas per anonymous ballot, negligible on Sepolia but a genuine cost argument at national scale, which is why production systems batch proofs or move tallying off chain with on chain verification.

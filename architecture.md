# Liquid Voting on Ethereum: Architecture Specification

Version 0.3. Changelog: v0.2 moved the delegation snapshot from paper creation to the end of a dedicated delegation window (section 3); v0.3 wired DelegationRegistry into the gasless meta transaction path (sections 4 and 7). Stack: Solidity 0.8.x, OpenZeppelin 5.x, Semaphore v4, Hardhat, React with web3.js, Node.js relayer. Networks: Hardhat local first, then Sepolia.

## 1. Locked design decisions

Anonymity level: unlinkable voting via Semaphore v4 zero knowledge group membership proofs. Delegation model: one hop with own vote override. Result visibility: only after the voting window closes, enforced by commit and reveal rather than by hiding data in the UI, because on chain state is always publicly readable by anyone running a node.

Three composition rules resolve the conflicts between these choices.

**Rule 1: anonymity and delegation are mutually exclusive per topic.** A voter may register for anonymous voting on a topic only if, at the snapshot, they have no outgoing delegation for that topic and no incoming delegations for that topic. Two reasons. First, an anonymous ballot cannot be linked to its caster, so the contract could never subtract it from a delegate's tally, which would double count the voter. Second, a delegate voting anonymously with weight w would be instantly identifiable by that weight (weight fingerprinting). Consequence: the own vote override exists on the public path only, and delegates are public figures by design. This is also politically defensible: delegated power should be accountable.

**Rule 2: every ballot is a commitment first.** During the voting window all voters, public and anonymous, submit `hash(choice, salt)`. After the window closes, a reveal window opens in which plaintext choices are published and tallied. This is the only way to genuinely keep results secret until close on a public chain, and it conveniently moves all tally and override arithmetic into a single phase. A commitment that is never revealed counts as abstention.

**Rule 3: anonymous transactions never carry the voter's signature.** Public actions (registration, delegation, public commits and reveals) travel as ERC 2771 meta transactions signed by the voter and relayed by the government wallet. Anonymous commits and reveals are sent to the relayer as raw payloads (proof, nullifier, commitment) and submitted from the relayer's own account; the zero knowledge proof itself is the authorization. If anonymous payloads were wrapped in a meta transaction signed by the voter, that signature would deanonymize the ballot.

## 2. Trust model

What the chain provides: a publicly verifiable tally, tamper evident ballots, and vote once enforcement through nullifiers and commitment mappings. What it does not provide: trustless eligibility. The government mints the citizen token, so Sybil resistance is exactly as good as the issuance process. The relayer is a censorship point (mitigation: every function is also callable directly by a voter paying their own gas) and a metadata observer (it sees IP addresses and timing; network level anonymity would need Tor or similar and is out of scope). Receipt freeness is not achieved on the public path: public voters can prove how they voted, which in theory enables vote buying. MACI is the known remedy and is listed as future work.

## 3. Voting paper lifecycle

Created, then Delegation, then Registration, then Voting, then Reveal, then Finalized.

At creation the government defines title, matters (each with one of the eight fixed topic ids and a text or IPFS CID) and four deadlines: delegationEnd, registrationEnd, votingEnd and revealEnd. The snapshot is taken at the end of the delegation window, not at creation: `snapshotTime = delegationEnd`, and all delegation lookups for this paper use that timepoint. The delegation window exists so that voters can adjust their standing delegations in response to the published matters and still have them count for this paper; this matches the standard Governor pattern, where the voting power snapshot sits at the start of voting and the voting delay exists precisely so delegations can be moved first. The snapshot must nevertheless come before the registration window. Anonymous registration eligibility (no outbound and no inbound delegation for the topic) is checked against the snapshot, and only a snapshot that already lies in the past makes this check race free: if delegation and registration shared one window, a voter could register anonymously first and delegate afterwards, ending up counted twice, once through the delegate and once through an unlinkable ballot that nobody can attribute and subtract. Delegation changes made after delegationEnd stay valid but apply from the next paper onwards, and the Vote view must say so explicitly. During Registration, eligible voters insert identity commitments into the Semaphore group of each topic they want to vote on anonymously. Registration closes before voting starts so that group Merkle roots are stable while proofs are generated and so that a late registration cannot be correlated with a late ballot. During Voting only commitments are accepted. During Reveal only reveals are accepted and tallies are computed. Finalize freezes the result and emits an event the results view listens to.

## 4. Contracts

**CitizenRegistry.** Non transferable ERC 721 following ERC 5192 (Locked event, all transfer paths revert). `issue(address)` is restricted to `ISSUER_ROLE` and backs the manual citizen creation interface. An optional `revoke` covers loss of eligibility.

**DelegationRegistry.** Standing per topic delegations with checkpoints, the same pattern as ERC20Votes. `setDelegate(topicId, delegate)` and `clearDelegate(topicId)` append checkpoints for `delegateOf(voter, topic)` and adjust checkpointed `inboundWeight(delegate, topic)`, so `getPastDelegate` and `getPastInboundWeight` can be queried at any past timepoint. Run the checkpoints on the timestamp clock (ERC 6372) so they can be queried exactly at the phase boundary `snapshotTime`; never mix block based checkpoints with timestamp based phases. Constraints: the delegate must hold the citizen token, self delegation reverts. Like VoteController, the contract inherits `ERC2771Context` and resolves the voter through `_msgSender()` in every function (a single leftover `msg.sender` would attribute the delegation to the forwarder), so delegation changes ride the same gasless meta transaction path as votes. The trusted forwarder address is an immutable constructor argument, so deploy the Forwarder before every contract that trusts it. One hop semantics: inbound weight never flows onward. If your delegate has himself delegated the topic and never votes personally, your weight is simply unused, exactly as if your delegate had abstained.

**BallotManager.** Paper creation and phase logic, `CREATOR_ROLE` for the government, plus a `cancel(paperId)` flag. Matter texts are stored on chain as short strings; switch to IPFS CIDs if matters carry long documents.

**VoteController.** The core contract. It inherits `ERC2771Context`, holds tallies and the commit, reveal and override logic, and talks to the canonical deployed Semaphore instance. Group ids are derived as `uint256(keccak256(paperId, topicId))`.

```solidity
function registerAnonymous(uint paperId, uint8 topicId, uint identityCommitment) external;
// requires: SBT, phase == Registration, no outbound and no inbound delegation
// for this topic at snapshotTime (= delegationEnd), not yet registered for this topic.
// effects: anonMode[paper][topic][voter] = true; Semaphore.addMember(groupId, commitment)

function commitPublic(uint matterId, bytes32 commitment) external;
// requires: SBT, phase == Voting, !anonMode for the matter's topic, no prior commit

function commitAnonymous(uint matterId, uint[8] proof, uint nullifier, bytes32 commitment) external;
// requires: phase == Voting; Semaphore.validateProof for group(paper, topic(matter))
// with scope = uint(keccak256(paperId, matterId)); Semaphore rejects reused nullifiers

function revealPublic(uint matterId, bool choice, bytes32 salt) external;
function revealAnonymous(uint matterId, uint commitIndex, bool choice, bytes32 salt) external;
// requires: phase == Reveal; keccak256(choice, salt) matches the stored commitment

function finalize(uint paperId) external;
```

**Forwarder.** OpenZeppelin `ERC2771Forwarder`. Its EIP 712 request struct already contains nonce and deadline, which covers replay protection for the meta transaction path.

## 5. Tally with one hop override, order independent

Per matter M in topic T the contract keeps `yesTally`, `noTally`, `delegateChoice[M][d]` (unset, yes or no) and `overrideCount[M][d]`.

Public reveal by voter v with choice c. Let `d = getPastDelegate(v, T, snapshot)` and `w = getPastInboundWeight(v, T, snapshot)`.

If v did not delegate T (`d == 0`): add `1 + w - overrideCount[M][v]` to `tally[c]` and set `delegateChoice[M][v] = c`.

If v delegated T (`d != 0`), this reveal is the override: add 1 to `tally[c]`; if `delegateChoice[M][d]` is already set, subtract 1 from that tally, otherwise increment `overrideCount[M][d]` so the delegate's later reveal adds correspondingly less.

A voter can be in both roles at once (he delegated T himself and also carries inbound weight). His reveal then applies both branches: it overrides his own outbound delegation and activates his inbound weight.

Anonymous reveal: always weight exactly 1, add 1 to `tally[c]`. No delegation interaction can exist because of Rule 1.

Every reveal costs O(1) gas and the final tally is independent of reveal order. Unrevealed commitments and inactive delegates contribute nothing.

Worked example. Alice, Ben and Carla delegate Education to Dana; Emil registered anonymously. Dana reveals Yes: Yes = 4 (her own vote plus three delegations). Carla reveals No herself: Yes = 3, No = 1. Emil reveals No anonymously: No = 2. Ben and Alice do nothing further; their weight stays with Dana. Final: Yes 3, No 2.

## 6. Anonymity layer

Semaphore v4 identities are EdDSA key pairs whose commitment is published at registration; groups are Lean Incremental Merkle Trees managed by the canonical Semaphore contract; proofs are Groth16, generated in the browser with `@semaphore-protocol/proof` and verified on chain. Semaphore is already deployed on Sepolia, so reuse the canonical instance (address in the Semaphore docs under Deployed Contracts, docs.semaphore.pse.dev) instead of deploying circuits and verifiers yourself.

Identity derivation without storage: `new Identity(await signer.signMessage("liquid-vote identity v1"))`. The identity is deterministic from the wallet key, recoverable on any device, and nothing sensitive is persisted. Whoever controls the wallet controls the identity.

The proof scope (external nullifier) is `hash(paperId, matterId)`: one anonymous ballot per identity per matter, while the same identity votes on every matter of the paper.

Anonymity set caveats, for the UI and for the report. Unlinkability is only as strong as the group: show "your ballot hides among N anonymous registrants for this topic" and warn below a threshold, for example N < 20. And if all N anonymous reveals on a matter show the same choice, each individual choice is trivially inferable; this statistical disclosure is inherent to any anonymous tally.

## 7. Gasless layer

Public path: the browser signs an EIP 712 forward request (MetaMask `signTypedData`), the relayer validates it and calls `ERC2771Forwarder.execute`, the target contract recovers the voter through `_msgSender()`. Anonymous path: the browser sends `{matterId, proof, nullifier, commitment}` over HTTPS, the relayer pre validates the proof off chain to avoid paying gas for garbage, then submits from its own EOA.

The relayer is a small Node/Express service with endpoints `/relay/meta` and `/relay/anonymous`, per IP rate limiting, and a nonce managed transaction queue for the government wallet. On Sepolia it only needs faucet ETH. Delegation changes relayed through `/relay/meta` need one extra policy: commits and reveals are naturally bounded at one each per voter and matter, delegation flips are not, so an attacker could burn the government's gas by re delegating in a loop. Cap relayed delegation changes per voter and topic within a paper cycle; the self paid path stays uncapped, there the spammer funds himself. Censorship mitigation: since authorization lives entirely in signatures and proofs, any voter can bypass the relayer and submit directly with their own gas.

## 8. Frontend

One React application with four role based views satisfies the four interface requirements without four codebases. Vote: open papers, per topic either pick a delegate or register for anonymity, then commit and later reveal per matter, with phase countdowns. Results: papers with phase indicator; tallies render only once the reveal phase has started and are marked final after `finalize`. Paper Admin: create papers, add matters under the eight fixed topics, set the four deadlines. Citizen Admin: issue the citizen token to an address.

web3.js handles contract calls and EIP 712 signing per requirement. Note that web3.js was sunset by its maintainers in March 2025 in favor of ethers.js and viem; the architecture is library agnostic and a swap is cheap, so document the choice either way. `@semaphore-protocol/core` provides identity, group synchronization (rebuilding the Merkle tree client side from Semaphore contract events) and proof generation.

## 9. Build order

M1, public core: CitizenRegistry, DelegationRegistry with checkpoints, BallotManager, VoteController with public commit reveal and the override arithmetic, Forwarder plus relayer, all four views. This milestone alone is demoable and covers every requirement except unlinkability, which hedges the semester risk.

M2, anonymity: Semaphore integration, registration phase, anonymous commit and reveal, the weight 1 rule, identity derivation UX and group size display.

M3, polish and later additions: voting history view (public history from events; anonymous history reconstructed only client side from the locally derived identity, by design invisible to everyone else), self paid fallback UX, SSI exploration.

## 10. Testing

Local, Hardhat with chai. Tests to write: SBT non transferability; delegation checkpoints return correct values at the snapshot timepoint, including a delegation set just before delegationEnd (counts) and one set just after (does not); override arithmetic in every reveal order (delegate first, delegator first, delegate never reveals, and the dual role voter); double commit rejection; nullifier reuse rejection; anonMode blocks public commits; registration reverts when any delegation exists for the topic; phase gating on every function; forwarder replay rejection with a reused nonce and an expired deadline; a delegation set through the forwarder is attributed to the signing voter and never to the relayer or forwarder; a fuzzed invariant that tallies always equal the correctly weighted sum of revealed ballots and never go negative. For Semaphore, run fast suites against a mock verifier and one slow honest suite that deploys the contracts from `@semaphore-protocol/contracts` and generates real proofs.

Sepolia walkthrough. Fund a deployer and the relayer wallet from a Sepolia faucet (Google Cloud or Alchemy faucets work without mainnet balance requirements in most cases). Configure Hardhat with a Sepolia RPC endpoint and the deployer key, deploy, and verify on Etherscan:

```bash
npx hardhat run scripts/deploy.ts --network sepolia
npx hardhat verify --network sepolia <address> <constructor args>
node relayer/index.js   # RELAYER_KEY and RPC_URL in .env
```

Point the VoteController at the canonical Semaphore Sepolia address from the docs. Issue citizen tokens to two or three MetaMask test accounts through the Citizen Admin view. Create a paper with two matters in different topics and short windows, for example delegation 15 minutes, registration 15, voting 30, reveal 30. Test the snapshot boundary explicitly: delegate during the delegation window and confirm the weight counts, then delegate from another account after delegationEnd and confirm this paper is unaffected. Walk one account through a delegation and a later override, and a second account through anonymous registration and an anonymous ballot; neither account should ever need ETH. After the reveal window, finalize and cross check the Results view against the contract events on Sepolia Etherscan.

## 11. Known limitations (report and diary material)

Eligibility rests on the government trust root. Receipt freeness is absent on the public path, so vote buying is theoretically possible there, with MACI as the acknowledged remedy. The relayer sees network metadata and could censor, mitigated but not eliminated by the self paid fallback. Small anonymity sets weaken unlinkability, and unanimous anonymous tallies disclose individual choices. The reveal step is a real UX burden: a second interaction per matter, and forgetting it means abstention. Finally, on chain Groth16 verification costs roughly 250k to 350k gas per anonymous ballot, negligible on Sepolia but a genuine cost argument at national scale, which is why production systems batch proofs or move tallying off chain with on chain verification.

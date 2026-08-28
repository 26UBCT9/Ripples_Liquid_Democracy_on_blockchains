/**
 * Real Semaphore v4 end-to-end suite on the v0.8 direct-voting lifecycle.
 *
 * Deploys PoseidonT3 + SemaphoreVerifier + Semaphore (the same code as the
 * canonical public deployments), registers identities during the open voting
 * window, generates genuine Groth16 proofs with the local snark artifacts
 * (the CHOICE is the proof message), and has the verifier check them on-chain.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const path = require("path");
const fs = require("fs");
const { Identity, Group } = require("@semaphore-protocol/core");
const generateProof = require("@semaphore-protocol/proof").generateProof;

const EDUCATION = 2;
const CHOICE_MESSAGE = (choice) => (choice ? 1n : 2n);

/** Local snark artifacts (no network access needed). */
function artifactsFor(depth) {
  const base = path.join(__dirname, "..", "node_modules", "@zk-kit", "semaphore-artifacts");
  const wasm = path.join(base, `semaphore-${depth}.wasm`);
  const zkey = path.join(base, `semaphore-${depth}.zkey`);
  if (!fs.existsSync(wasm) || !fs.existsSync(zkey)) {
    throw new Error(`missing snark artifacts for depth ${depth} under ${base}`);
  }
  return { wasm, zkey };
}

async function proveVote(identity, group, choice, scope) {
  const depth = Math.max(1, group.depth); // single-member sets have depth 0
  return generateProof(identity, group, CHOICE_MESSAGE(choice), scope, depth, artifactsFor(depth));
}

async function deployRealFixture() {
  const [gov, relayer, emil, luca, maia] = await ethers.getSigners();

  const poseidon = await (
    await ethers.getContractFactory("poseidon-solidity/PoseidonT3.sol:PoseidonT3")
  ).deploy();
  const verifier = await (
    await ethers.getContractFactory("@semaphore-protocol/contracts/base/SemaphoreVerifier.sol:SemaphoreVerifier")
  ).deploy();
  const semaphore = await (
    await ethers.getContractFactory("@semaphore-protocol/contracts/Semaphore.sol:Semaphore", {
      libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": await poseidon.getAddress() },
    })
  ).deploy(await verifier.getAddress());

  const forwarder = await (await ethers.getContractFactory("Forwarder")).deploy("LiquidVoteForwarder");
  const citizens = await (await ethers.getContractFactory("CitizenRegistry")).deploy(gov.address);
  const delegations = await (
    await ethers.getContractFactory("DelegationRegistry")
  ).deploy(await forwarder.getAddress(), await citizens.getAddress());
  const controller = await (
    await ethers.getContractFactory("VoteController")
  ).deploy(
    await forwarder.getAddress(),
    gov.address,
    await citizens.getAddress(),
    await delegations.getAddress(),
    await semaphore.getAddress()
  );

  for (const s of [emil, luca, maia]) await citizens.issue(s.address);

  const now = await time.latest();
  const p = { votingEnd: now + 2000 };
  await controller.createPaper("Real anonymity", p.votingEnd, [
    { topicId: EDUCATION, text: "First matter" },
    { topicId: EDUCATION, text: "Second matter" },
  ]);
  const paper = await controller.getPaper(1);
  const [matterA, matterB] = [...paper.matterIds];

  // Deterministic identities as the frontend derives them (from a signature).
  const emilId = new Identity("emil-signature-seed");
  const lucaId = new Identity("luca-signature-seed");

  // The paper is already live: register straight into the open voting window.
  await controller.connect(emil).registerAnonymous(1, EDUCATION, emilId.commitment);
  await controller.connect(luca).registerAnonymous(1, EDUCATION, lucaId.commitment);

  // Off-chain mirror of the on-chain group, in insertion order.
  const group = new Group([emilId.commitment, lucaId.commitment]);
  const groupId = await controller.groupIdOf(1, EDUCATION);
  expect(await semaphore.getMerkleTreeRoot(groupId)).to.equal(group.root);

  return { gov, relayer, emil, luca, maia, semaphore, controller, matterA, matterB, emilId, lucaId, group, p };
}

describe("Real Semaphore v4 with genuine Groth16 proofs (direct voting)", function () {
  this.timeout(300000);

  it("accepts a valid proof, tallies live, and blocks the reused nullifier", async () => {
    const s = await loadFixture(deployRealFixture);
    const scope = await s.controller.scopeOf(s.matterA);

    const proof = await proveVote(s.emilId, s.group, true, scope);
    await expect(s.controller.connect(s.relayer).voteAnonymous(s.matterA, proof, true)).to.emit(
      s.controller,
      "AnonymousVote"
    );
    // tallied immediately, readable mid-vote
    expect((await s.controller.getMatter(s.matterA)).yes).to.equal(1n);

    // Same identity, same matter: same nullifier -> rejected by Semaphore.
    const proof2 = await proveVote(s.emilId, s.group, false, scope);
    await expect(s.controller.connect(s.relayer).voteAnonymous(s.matterA, proof2, false)).to.be.revertedWithCustomError(
      s.semaphore,
      "Semaphore__YouAreUsingTheSameNullifierTwice"
    );

    // The tally freezes at votingEnd.
    await time.increaseTo(s.p.votingEnd + 1);
    const m = await s.controller.getMatter(s.matterA);
    expect(m.yes).to.equal(1n);
    expect(m.no).to.equal(0n);
  });

  it("scopes nullifiers per matter: the same identity votes on both matters", async () => {
    const s = await loadFixture(deployRealFixture);
    const proofA = await proveVote(s.lucaId, s.group, true, await s.controller.scopeOf(s.matterA));
    const proofB = await proveVote(s.lucaId, s.group, false, await s.controller.scopeOf(s.matterB));
    await s.controller.connect(s.relayer).voteAnonymous(s.matterA, proofA, true);
    await s.controller.connect(s.relayer).voteAnonymous(s.matterB, proofB, false);
    expect((await s.controller.getMatter(s.matterA)).yes).to.equal(1n);
    expect((await s.controller.getMatter(s.matterB)).no).to.equal(1n);
  });

  it("supports members joining mid-vote: proofs against the grown group verify", async () => {
    const s = await loadFixture(deployRealFixture);
    const maiaId = new Identity("maia-signature-seed");
    await s.controller.connect(s.maia).registerAnonymous(1, EDUCATION, maiaId.commitment);
    const grown = new Group([s.emilId.commitment, s.lucaId.commitment, maiaId.commitment]);

    const proofM = await proveVote(maiaId, grown, false, await s.controller.scopeOf(s.matterA));
    await expect(s.controller.connect(s.relayer).voteAnonymous(s.matterA, proofM, false)).to.emit(
      s.controller,
      "AnonymousVote"
    );
  });

  it("proves for a single-member set: depth clamps from 0 to 1 (the fresh-voter case)", async () => {
    const s = await loadFixture(deployRealFixture);
    const now = await time.latest();
    await s.controller.createPaper("Solo", now + 500, [{ topicId: EDUCATION, text: "Only one?" }]);
    const paper2 = await s.controller.getPaper(2);
    const soloMatter = paper2.matterIds[0];

    const maiaId = new Identity("maia-signature-seed");
    await s.controller.connect(s.maia).registerAnonymous(2, EDUCATION, maiaId.commitment);
    const solo = new Group([maiaId.commitment]);
    expect(solo.depth).to.equal(0); // the raw depth the clamp protects against

    const proofS = await proveVote(maiaId, solo, true, await s.controller.scopeOf(soloMatter));
    await expect(s.controller.connect(s.relayer).voteAnonymous(soloMatter, proofS, true)).to.emit(
      s.controller,
      "AnonymousVote"
    );
    expect((await s.controller.getMatter(soloMatter)).yes).to.equal(1n);
  });

  it("rejects outsider proofs and relayer choice flips", async () => {
    const s = await loadFixture(deployRealFixture);
    const scope = await s.controller.scopeOf(s.matterA);

    // Maia is a citizen but never registered: her self-made root differs.
    const maiaId = new Identity("maia-signature-seed");
    const outsiderGroup = new Group([s.emilId.commitment, s.lucaId.commitment, maiaId.commitment]);
    const proofM = await proveVote(maiaId, outsiderGroup, true, scope);
    await expect(s.controller.connect(s.relayer).voteAnonymous(s.matterA, proofM, true)).to.be.revertedWithCustomError(
      s.semaphore,
      "Semaphore__MerkleTreeRootIsNotPartOfTheGroup"
    );

    // A relayer must not be able to flip the ballot: the message binds the choice.
    const proof = await proveVote(s.emilId, s.group, true, scope);
    await expect(s.controller.connect(s.relayer).voteAnonymous(s.matterA, proof, false)).to.be.revertedWith(
      "message is not the choice"
    );
  });
});

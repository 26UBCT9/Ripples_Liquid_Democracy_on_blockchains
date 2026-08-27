/**
 * M2 end-to-end suite: the REAL Semaphore v4 stack on the v0.5 live lifecycle.
 *
 * Deploys PoseidonT3 + SemaphoreVerifier + Semaphore (the same code as the
 * canonical public deployments), registers identities DURING the open voting
 * window, generates genuine Groth16 proofs with the local snark artifacts,
 * and has the verifier contract check them on-chain.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const path = require("path");
const fs = require("fs");
const { Identity, Group } = require("@semaphore-protocol/core");
const generateProof = require("@semaphore-protocol/proof").generateProof;

const EDUCATION = 2;
const abi = ethers.AbiCoder.defaultAbiCoder();

const salt = (label) => ethers.encodeBytes32String(label);
const anonCommitment = (matterId, choice, s) =>
  ethers.keccak256(abi.encode(["uint256", "bool", "bytes32"], [matterId, choice, s]));

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
  const p = { votingEnd: now + 2000, revealEnd: now + 4000 };
  await controller.createPaper("Real anonymity", p.votingEnd, p.revealEnd, [
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

describe("M2: real Semaphore v4 with genuine Groth16 proofs", function () {
  this.timeout(300000);

  it("accepts a valid proof on-chain, tallies the reveal, and blocks the reused nullifier", async () => {
    const s = await loadFixture(deployRealFixture);
    const emilSalt = salt("emil-real");
    const c = anonCommitment(s.matterA, true, emilSalt);
    const scope = await s.controller.scopeOf(s.matterA);

    const proof = await generateProof(s.emilId, s.group, BigInt(c), scope, s.group.depth, artifactsFor(s.group.depth));
    await expect(s.controller.connect(s.relayer).commitAnonymous(s.matterA, proof, c))
      .to.emit(s.controller, "AnonymousCommit");

    // Same identity, same matter, fresh commitment: same nullifier -> rejected by Semaphore.
    const c2 = anonCommitment(s.matterA, false, salt("emil-second-try"));
    const proof2 = await generateProof(s.emilId, s.group, BigInt(c2), scope, s.group.depth, artifactsFor(s.group.depth));
    await expect(s.controller.connect(s.relayer).commitAnonymous(s.matterA, proof2, c2)).to.be.revertedWithCustomError(
      s.semaphore,
      "Semaphore__YouAreUsingTheSameNullifierTwice"
    );

    // Reveal and tally with weight exactly 1.
    await time.increaseTo(s.p.votingEnd + 1);
    await s.controller.connect(s.relayer).revealAnonymous(s.matterA, 0, true, emilSalt);
    const m = await s.controller.getMatter(s.matterA);
    expect(m.yes).to.equal(1n);
    expect(m.no).to.equal(0n);
  });

  it("scopes nullifiers per matter: the same identity votes on both matters", async () => {
    const s = await loadFixture(deployRealFixture);
    const depth = s.group.depth;
    const cA = anonCommitment(s.matterA, true, salt("luca-a"));
    const cB = anonCommitment(s.matterB, false, salt("luca-b"));
    const proofA = await generateProof(s.lucaId, s.group, BigInt(cA), await s.controller.scopeOf(s.matterA), depth, artifactsFor(depth));
    const proofB = await generateProof(s.lucaId, s.group, BigInt(cB), await s.controller.scopeOf(s.matterB), depth, artifactsFor(depth));
    await s.controller.connect(s.relayer).commitAnonymous(s.matterA, proofA, cA);
    await s.controller.connect(s.relayer).commitAnonymous(s.matterB, proofB, cB);
    expect(await s.controller.anonCommitCount(s.matterA)).to.equal(1n);
    expect(await s.controller.anonCommitCount(s.matterB)).to.equal(1n);
  });

  it("supports members joining mid-vote: proofs against the grown group verify", async () => {
    const s = await loadFixture(deployRealFixture);
    // Maia joins while voting is already running.
    const maiaId = new Identity("maia-signature-seed");
    await s.controller.connect(s.maia).registerAnonymous(1, EDUCATION, maiaId.commitment);
    const grown = new Group([s.emilId.commitment, s.lucaId.commitment, maiaId.commitment]);

    const cM = anonCommitment(s.matterA, false, salt("maia-live"));
    const proofM = await generateProof(maiaId, grown, BigInt(cM), await s.controller.scopeOf(s.matterA), grown.depth, artifactsFor(grown.depth));
    await expect(s.controller.connect(s.relayer).commitAnonymous(s.matterA, proofM, cM)).to.emit(
      s.controller,
      "AnonymousCommit"
    );
  });

  it("rejects proofs from outside the group and swapped ballot commitments", async () => {
    const s = await loadFixture(deployRealFixture);
    const scope = await s.controller.scopeOf(s.matterA);

    // Maia is a citizen but never registered: her self-made root differs.
    const maiaId = new Identity("maia-signature-seed");
    const outsiderGroup = new Group([s.emilId.commitment, s.lucaId.commitment, maiaId.commitment]);
    const cM = anonCommitment(s.matterA, true, salt("maia"));
    const proofM = await generateProof(maiaId, outsiderGroup, BigInt(cM), scope, outsiderGroup.depth, artifactsFor(outsiderGroup.depth));
    await expect(s.controller.connect(s.relayer).commitAnonymous(s.matterA, proofM, cM)).to.be.revertedWithCustomError(
      s.semaphore,
      "Semaphore__MerkleTreeRootIsNotPartOfTheGroup"
    );

    // A relayer must not be able to swap the ballot: message binds the commitment.
    const cReal = anonCommitment(s.matterA, true, salt("emil-real2"));
    const cSwapped = anonCommitment(s.matterA, false, salt("swapped"));
    const proof = await generateProof(s.emilId, s.group, BigInt(cReal), scope, s.group.depth, artifactsFor(s.group.depth));
    await expect(s.controller.connect(s.relayer).commitAnonymous(s.matterA, proof, cSwapped)).to.be.revertedWith(
      "message is not the commitment"
    );
  });
});

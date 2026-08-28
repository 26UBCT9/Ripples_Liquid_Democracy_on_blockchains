const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const EDUCATION = 2;
const MIGRATION = 5;
const abi = ethers.AbiCoder.defaultAbiCoder();

const salt = (label) => ethers.encodeBytes32String(label);

function publicCommitment(matterId, voter, choice, s) {
  return ethers.keccak256(abi.encode(["uint256", "address", "bool", "bytes32"], [matterId, voter, choice, s]));
}

function anonCommitment(matterId, choice, s) {
  return ethers.keccak256(abi.encode(["uint256", "bool", "bytes32"], [matterId, choice, s]));
}

function mockProof(scope, commitment, nullifier) {
  return {
    merkleTreeDepth: 1,
    merkleTreeRoot: 0,
    nullifier,
    message: BigInt(commitment),
    scope,
    points: [0, 0, 0, 0, 0, 0, 0, 0],
  };
}

async function deployFixture() {
  const [gov, relayer, alice, ben, carla, dana, emil, luca] = await ethers.getSigners();

  const forwarder = await (await ethers.getContractFactory("Forwarder")).deploy("LiquidVoteForwarder");
  const citizens = await (await ethers.getContractFactory("CitizenRegistry")).deploy(gov.address);
  const semaphore = await (await ethers.getContractFactory("MockSemaphore")).deploy();
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

  for (const s of [alice, ben, carla, dana, emil, luca]) {
    await citizens.issue(s.address);
  }
  return { gov, relayer, alice, ben, carla, dana, emil, luca, forwarder, citizens, semaphore, delegations, controller };
}

// Papers are live at creation: Voting from now, Reveal after votingEnd.
async function createPaper(controller, matters) {
  const now = await time.latest();
  const votingEnd = now + 1000;
  const revealEnd = votingEnd + 1000;
  await controller.createPaper(
    "Eidgenoessische Abstimmung",
    votingEnd,
    revealEnd,
    matters ?? [{ topicId: EDUCATION, text: "Introduce a federal AI curriculum?" }]
  );
  const paperId = await controller.paperCount();
  const p = await controller.getPaper(paperId);
  return {
    paperId,
    matterIds: [...p.matterIds],
    snapshot: p.snapshot,
    votingEnd,
    revealEnd,
  };
}

const toReveal = (p) => time.increaseTo(p.votingEnd + 1);
const toEnded = (p) => time.increaseTo(p.revealEnd + 1);

async function tally(controller, matterId) {
  const m = await controller.getMatter(matterId);
  return { yes: m.yes, no: m.no };
}

describe("CitizenRegistry", () => {
  it("is soulbound and issues one token per citizen", async () => {
    const { gov, alice, ben, citizens } = await loadFixture(deployFixture);
    expect(await citizens.isCitizen(alice.address)).to.equal(true);
    await expect(citizens.issue(alice.address)).to.be.revertedWith("already a citizen");
    const id = await citizens.tokenIdOf(alice.address);
    await expect(citizens.connect(alice).transferFrom(alice.address, ben.address, id)).to.be.revertedWith(
      "soulbound: non-transferable"
    );
    await expect(citizens.connect(alice).issue(alice.address)).to.be.reverted; // no role
    await citizens.connect(gov).revoke(alice.address);
    expect(await citizens.isCitizen(alice.address)).to.equal(false);
  });
});

describe("DelegationRegistry checkpoints", () => {
  it("snapshots at paper creation: earlier delegations count, later ones do not", async () => {
    const { alice, dana, emil, delegations, controller } = await loadFixture(deployFixture);

    // standing delegation set before the paper exists
    await delegations.connect(alice).setDelegate(EDUCATION, dana.address);
    const p = await createPaper(controller);

    // change right after publication: applies to the NEXT paper only
    await delegations.connect(alice).setDelegate(EDUCATION, emil.address);

    expect(await delegations.getPastDelegate(alice.address, EDUCATION, p.snapshot)).to.equal(dana.address);
    expect(await delegations.getPastInboundWeight(dana.address, EDUCATION, p.snapshot)).to.equal(1n);
    expect(await delegations.getPastInboundWeight(emil.address, EDUCATION, p.snapshot)).to.equal(0n);
    expect(await delegations.delegateOf(alice.address, EDUCATION)).to.equal(emil.address);
    await expect(
      delegations.getPastDelegate(alice.address, EDUCATION, BigInt(await time.latest()) + 10n ** 6n)
    ).to.be.revertedWith("future lookup");
  });

  it("rejects self delegation, non-citizens and no-op changes", async () => {
    const { gov, alice, ben, delegations } = await loadFixture(deployFixture);
    await expect(delegations.connect(alice).setDelegate(EDUCATION, alice.address)).to.be.revertedWith("self delegation");
    await expect(delegations.connect(alice).setDelegate(EDUCATION, gov.address)).to.be.revertedWith(
      "delegate not a citizen"
    );
    await expect(delegations.connect(alice).setDelegate(9, ben.address)).to.be.revertedWith("bad topic");
    await delegations.connect(alice).setDelegate(EDUCATION, ben.address);
    await expect(delegations.connect(alice).setDelegate(EDUCATION, ben.address)).to.be.revertedWith("unchanged");
    await delegations.connect(alice).clearDelegate(EDUCATION);
    expect(await delegations.delegateOf(alice.address, EDUCATION)).to.equal(ethers.ZeroAddress);
  });
});

describe("VoteController: spec section 5 scenario", () => {
  // Alice, Ben, Carla delegate Education to Dana before the paper; Emil votes anonymously.
  async function scenarioFixture() {
    const ctx = await deployFixture();
    const { alice, ben, carla, dana, emil, relayer, delegations, controller } = ctx;

    for (const s of [alice, ben, carla]) {
      await delegations.connect(s).setDelegate(EDUCATION, dana.address);
    }
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];

    // voting is live immediately: register + commit without any window hopping
    await controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 42n);

    const danaSalt = salt("dana");
    const carlaSalt = salt("carla");
    const emilSalt = salt("emil");
    await controller.connect(dana).commitPublic(matterId, publicCommitment(matterId, dana.address, true, danaSalt));
    await controller.connect(carla).commitPublic(matterId, publicCommitment(matterId, carla.address, false, carlaSalt));

    const anonC = anonCommitment(matterId, false, emilSalt);
    const scope = await controller.scopeOf(matterId);
    await controller.connect(relayer).commitAnonymous(matterId, mockProof(scope, anonC, 777n), anonC);

    return { ...ctx, p, matterId, danaSalt, carlaSalt, emilSalt };
  }

  it("delegate reveals first, override subtracts afterwards (Yes 3 / No 2)", async () => {
    const s = await loadFixture(scenarioFixture);
    await toReveal(s.p);
    await s.controller.connect(s.dana).revealPublic(s.matterId, true, s.danaSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 4n, no: 0n });
    await s.controller.connect(s.carla).revealPublic(s.matterId, false, s.carlaSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 1n });
    await s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, false, s.emilSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 2n });
    await toEnded(s.p);
    await s.controller.finalize(s.p.paperId);
    expect((await s.controller.getPaper(s.p.paperId)).finalized).to.equal(true);
  });

  it("delegator reveals first, delegate weight shrinks (order independent)", async () => {
    const s = await loadFixture(scenarioFixture);
    await toReveal(s.p);
    await s.controller.connect(s.carla).revealPublic(s.matterId, false, s.carlaSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 0n, no: 1n });
    expect(await s.controller.overrideCount(s.matterId, s.dana.address)).to.equal(1n);
    await s.controller.connect(s.dana).revealPublic(s.matterId, true, s.danaSalt);
    // 1 (own) + 3 (inbound) - 1 (override) = 3
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 1n });
    await s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, false, s.emilSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 2n });
  });

  it("delegate never reveals: delegated weight stays unused", async () => {
    const s = await loadFixture(scenarioFixture);
    await toReveal(s.p);
    await s.controller.connect(s.carla).revealPublic(s.matterId, false, s.carlaSalt);
    await s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, false, s.emilSalt);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 0n, no: 2n });
  });

  it("rejects double commits, double reveals, and wrong salts", async () => {
    const s = await loadFixture(scenarioFixture);
    await expect(
      s.controller.connect(s.dana).commitPublic(s.matterId, publicCommitment(s.matterId, s.dana.address, true, salt("x")))
    ).to.be.revertedWith("already committed");
    await toReveal(s.p);
    await expect(s.controller.connect(s.dana).revealPublic(s.matterId, true, salt("wrong"))).to.be.revertedWith(
      "reveal does not match commitment"
    );
    await s.controller.connect(s.dana).revealPublic(s.matterId, true, s.danaSalt);
    await expect(s.controller.connect(s.dana).revealPublic(s.matterId, true, s.danaSalt)).to.be.revertedWith(
      "already revealed"
    );
    await expect(s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, true, s.emilSalt)).to.be.revertedWith(
      "reveal does not match commitment"
    );
    await s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, false, s.emilSalt);
    await expect(s.controller.connect(s.relayer).revealAnonymous(s.matterId, 0, false, s.emilSalt)).to.be.revertedWith(
      "already revealed"
    );
  });
});

describe("VoteController: dual role chain (A -> B -> C, one hop)", () => {
  it("B overrides its own delegation and activates its inbound weight", async () => {
    const { ben, carla, luca, delegations, controller } = await loadFixture(deployFixture);

    await delegations.connect(luca).setDelegate(EDUCATION, ben.address); // luca -> ben
    await delegations.connect(ben).setDelegate(EDUCATION, carla.address); // ben -> carla
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];

    const sb = salt("ben"), sc = salt("carla"), sl = salt("luca");
    await controller.connect(ben).commitPublic(matterId, publicCommitment(matterId, ben.address, true, sb));
    await controller.connect(carla).commitPublic(matterId, publicCommitment(matterId, carla.address, false, sc));
    await controller.connect(luca).commitPublic(matterId, publicCommitment(matterId, luca.address, false, sl));

    await toReveal(p);
    // Ben: own 1 + inbound 1 (luca) = 2 yes; overrides carla (not yet revealed)
    await controller.connect(ben).revealPublic(matterId, true, sb);
    expect(await tally(controller, matterId)).to.deep.include({ yes: 2n, no: 0n });
    // Carla: own 1 + inbound 1 (ben) - 1 override = 1 no
    await controller.connect(carla).revealPublic(matterId, false, sc);
    expect(await tally(controller, matterId)).to.deep.include({ yes: 2n, no: 1n });
    // Luca overrides ben, who already revealed yes: yes -1, no +1
    await controller.connect(luca).revealPublic(matterId, false, sl);
    expect(await tally(controller, matterId)).to.deep.include({ yes: 1n, no: 2n });
  });
});

describe("VoteController: anonymity rules (spec Rule 1)", () => {
  it("blocks registration for delegators and delegates at the snapshot", async () => {
    const { carla, dana, delegations, controller } = await loadFixture(deployFixture);
    await delegations.connect(carla).setDelegate(EDUCATION, dana.address);
    const p = await createPaper(controller);
    await expect(controller.connect(carla).registerAnonymous(p.paperId, EDUCATION, 1n)).to.be.revertedWith(
      "delegated this topic"
    );
    await expect(controller.connect(dana).registerAnonymous(p.paperId, EDUCATION, 2n)).to.be.revertedWith(
      "is a delegate for this topic"
    );
  });

  it("allows registration when the delegation was set after paper creation", async () => {
    const { luca, dana, delegations, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller);
    // standing delegation for future papers, set after this paper's snapshot
    await delegations.connect(luca).setDelegate(EDUCATION, dana.address);
    await expect(controller.connect(luca).registerAnonymous(p.paperId, EDUCATION, 3n)).to.emit(
      controller,
      "AnonymousRegistered"
    );
  });

  it("blocks switching to anonymous after a public ballot on the same topic", async () => {
    const { alice, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller, [
      { topicId: EDUCATION, text: "AI curriculum?" },
      { topicId: MIGRATION, text: "New integration programme?" },
    ]);
    const [eduMatter] = p.matterIds;
    await controller.connect(alice).commitPublic(eduMatter, publicCommitment(eduMatter, alice.address, true, salt("a")));
    await expect(controller.connect(alice).registerAnonymous(p.paperId, EDUCATION, 7n)).to.be.revertedWith(
      "already voted publicly this topic"
    );
    // the other topic is untouched
    await expect(controller.connect(alice).registerAnonymous(p.paperId, MIGRATION, 7n)).to.emit(
      controller,
      "AnonymousRegistered"
    );
  });

  it("anonMode blocks public ballots on that topic only", async () => {
    const { emil, relayer, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller, [
      { topicId: EDUCATION, text: "AI curriculum?" },
      { topicId: MIGRATION, text: "New integration programme?" },
    ]);
    const [eduMatter, migMatter] = p.matterIds;
    await controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 4n);
    await expect(controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 4n)).to.be.revertedWith(
      "already registered"
    );
    await expect(
      controller.connect(emil).commitPublic(eduMatter, publicCommitment(eduMatter, emil.address, true, salt("e")))
    ).to.be.revertedWith("registered anonymous for topic");
    // other topic still public
    await controller.connect(emil).commitPublic(migMatter, publicCommitment(migMatter, emil.address, true, salt("e")));

    // anonymous ballot on the education matter, weight 1
    const c = anonCommitment(eduMatter, true, salt("ea"));
    const scope = await controller.scopeOf(eduMatter);
    await controller.connect(relayer).commitAnonymous(eduMatter, mockProof(scope, c, 99n), c);
    await toReveal(p);
    await controller.connect(relayer).revealAnonymous(eduMatter, 0, true, salt("ea"));
    expect(await tally(controller, eduMatter)).to.deep.include({ yes: 1n, no: 0n });
  });

  it("enforces scope, message binding and nullifier uniqueness", async () => {
    const { emil, relayer, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];
    await controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 5n);
    const c = anonCommitment(matterId, true, salt("z"));
    const scope = await controller.scopeOf(matterId);
    await expect(
      controller.connect(relayer).commitAnonymous(matterId, mockProof(scope + 1n, c, 1n), c)
    ).to.be.revertedWith("wrong scope");
    await expect(
      controller.connect(relayer).commitAnonymous(matterId, mockProof(scope, anonCommitment(matterId, false, salt("q")), 1n), c)
    ).to.be.revertedWith("message is not the commitment");
    await controller.connect(relayer).commitAnonymous(matterId, mockProof(scope, c, 1n), c);
    await expect(
      controller.connect(relayer).commitAnonymous(matterId, mockProof(scope, c, 1n), c)
    ).to.be.revertedWith("nullifier already used");
  });
});

describe("VoteController: phases and administration", () => {
  it("papers are live at creation and gate every action to its phase", async () => {
    const { alice, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];
    const c = publicCommitment(matterId, alice.address, true, salt("a"));

    expect(await controller.phaseOf(p.paperId)).to.equal(0); // Voting, immediately
    await expect(controller.connect(alice).revealPublic(matterId, true, salt("a"))).to.be.revertedWith(
      "not reveal phase"
    );
    await controller.connect(alice).commitPublic(matterId, c);
    await expect(controller.finalize(p.paperId)).to.be.revertedWith("not ended");

    await toReveal(p);
    expect(await controller.phaseOf(p.paperId)).to.equal(1); // Reveal
    await expect(
      controller.connect(alice).commitPublic(matterId, publicCommitment(matterId, alice.address, false, salt("b")))
    ).to.be.revertedWith("not voting phase");
    await expect(controller.connect(alice).registerAnonymous(p.paperId, EDUCATION, 1n)).to.be.revertedWith(
      "not voting phase"
    );
    await controller.connect(alice).revealPublic(matterId, true, salt("a"));

    await toEnded(p);
    expect(await controller.phaseOf(p.paperId)).to.equal(2); // Ended
    await expect(controller.connect(alice).revealPublic(matterId, true, salt("a"))).to.be.revertedWith(
      "not reveal phase"
    );
    await controller.finalize(p.paperId);
    await expect(controller.finalize(p.paperId)).to.be.revertedWith("already finalized");
  });

  it("validates paper creation and supports cancellation", async () => {
    const { alice, controller } = await loadFixture(deployFixture);
    const now = await time.latest();
    await expect(
      controller.createPaper("x", now + 200, now + 100, [{ topicId: EDUCATION, text: "t" }])
    ).to.be.revertedWith("bad deadlines");
    await expect(controller.createPaper("x", now + 100, now + 200, [])).to.be.revertedWith("no matters");
    await expect(
      controller.createPaper("x", now + 100, now + 200, [{ topicId: 8, text: "t" }])
    ).to.be.revertedWith("bad topic");
    await expect(controller.connect(alice).createPaper("x", now + 100, now + 200, [])).to.be.reverted; // no role

    const p = await createPaper(controller);
    await controller.cancel(p.paperId);
    expect(await controller.phaseOf(p.paperId)).to.equal(3); // Cancelled
    await expect(
      controller.connect(alice).commitPublic(p.matterIds[0], publicCommitment(p.matterIds[0], alice.address, true, salt("a")))
    ).to.be.revertedWith("not voting phase");
  });

  it("creates one semaphore group per distinct topic on the paper", async () => {
    const { controller, semaphore } = await loadFixture(deployFixture);
    const p = await createPaper(controller, [
      { topicId: EDUCATION, text: "m1" },
      { topicId: EDUCATION, text: "m2" },
      { topicId: MIGRATION, text: "m3" },
    ]);
    expect(await semaphore.groupCounter()).to.equal(2n);
    expect(await controller.groupIdOf(p.paperId, EDUCATION)).to.equal(0n);
    expect(await controller.groupIdOf(p.paperId, MIGRATION)).to.equal(1n);
    await expect(controller.groupIdOf(p.paperId, 0)).to.be.revertedWith("topic not on paper");
  });
});

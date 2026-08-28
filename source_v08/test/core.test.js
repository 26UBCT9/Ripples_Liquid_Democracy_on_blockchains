const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const EDUCATION = 2;
const MIGRATION = 5;

const mockProof = (scope, choice, nullifier) => ({
  merkleTreeDepth: 1,
  merkleTreeRoot: 0,
  nullifier,
  message: choice ? 1n : 2n,
  scope,
  points: [0, 0, 0, 0, 0, 0, 0, 0],
});

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

// Papers are live at creation; the tally is final after votingEnd.
async function createPaper(controller, matters) {
  const now = await time.latest();
  const votingEnd = now + 1000;
  await controller.createPaper(
    "Referendum",
    votingEnd,
    matters ?? [{ topicId: EDUCATION, text: "Introduce a federal AI curriculum?" }]
  );
  const paperId = await controller.paperCount();
  const p = await controller.getPaper(paperId);
  return { paperId, matterIds: [...p.matterIds], snapshot: p.snapshot, votingEnd };
}

const toEnded = (p) => time.increaseTo(p.votingEnd + 1);

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

describe("VoteController: spec section 5 scenario, live tally", () => {
  // Alice, Ben, Carla delegate Education to Dana before the paper; Emil votes anonymously.
  async function scenarioFixture() {
    const ctx = await deployFixture();
    const { alice, ben, carla, dana, emil, delegations, controller } = ctx;
    for (const s of [alice, ben, carla]) {
      await delegations.connect(s).setDelegate(EDUCATION, dana.address);
    }
    const p = await createPaper(controller);
    await controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 42n);
    return { ...ctx, p, matterId: p.matterIds[0] };
  }

  it("delegate votes first, override subtracts afterwards (Yes 3 / No 2)", async () => {
    const s = await loadFixture(scenarioFixture);
    await s.controller.connect(s.dana).votePublic(s.matterId, true);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 4n, no: 0n }); // own 1 + inbound 3
    await s.controller.connect(s.carla).votePublic(s.matterId, false);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 1n }); // override subtracts
    const scope = await s.controller.scopeOf(s.matterId);
    await s.controller.connect(s.relayer).voteAnonymous(s.matterId, mockProof(scope, false, 777n), false);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 2n });
    await toEnded(s.p);
    await s.controller.finalize(s.p.paperId);
    expect((await s.controller.getPaper(s.p.paperId)).finalized).to.equal(true);
  });

  it("delegator votes first, delegate weight shrinks (order independent)", async () => {
    const s = await loadFixture(scenarioFixture);
    await s.controller.connect(s.carla).votePublic(s.matterId, false);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 0n, no: 1n });
    expect(await s.controller.overrideCount(s.matterId, s.dana.address)).to.equal(1n);
    await s.controller.connect(s.dana).votePublic(s.matterId, true);
    // 1 (own) + 3 (inbound) - 1 (override) = 3
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 3n, no: 1n });
  });

  it("delegate never votes: delegated weight stays unused", async () => {
    const s = await loadFixture(scenarioFixture);
    await s.controller.connect(s.carla).votePublic(s.matterId, false);
    const scope = await s.controller.scopeOf(s.matterId);
    await s.controller.connect(s.relayer).voteAnonymous(s.matterId, mockProof(scope, false, 777n), false);
    await toEnded(s.p);
    expect(await tally(s.controller, s.matterId)).to.deep.include({ yes: 0n, no: 2n });
  });

  it("rejects double votes", async () => {
    const s = await loadFixture(scenarioFixture);
    await s.controller.connect(s.dana).votePublic(s.matterId, true);
    await expect(s.controller.connect(s.dana).votePublic(s.matterId, true)).to.be.revertedWith("already voted");
    await expect(s.controller.connect(s.dana).votePublic(s.matterId, false)).to.be.revertedWith("already voted");
  });
});

describe("VoteController: dual role chain (A -> B -> C, one hop)", () => {
  it("B overrides its own delegation and activates its inbound weight", async () => {
    const { ben, carla, luca, delegations, controller } = await loadFixture(deployFixture);

    await delegations.connect(luca).setDelegate(EDUCATION, ben.address); // luca -> ben
    await delegations.connect(ben).setDelegate(EDUCATION, carla.address); // ben -> carla
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];

    // Ben: own 1 + inbound 1 (luca) = 2 yes; overrides carla (not yet voted)
    await controller.connect(ben).votePublic(matterId, true);
    expect(await tally(controller, matterId)).to.deep.include({ yes: 2n, no: 0n });
    // Carla: own 1 + inbound 1 (ben) - 1 override = 1 no
    await controller.connect(carla).votePublic(matterId, false);
    expect(await tally(controller, matterId)).to.deep.include({ yes: 2n, no: 1n });
    // Luca overrides ben, who already voted yes: yes -1, no +1
    await controller.connect(luca).votePublic(matterId, false);
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
    await controller.connect(alice).votePublic(eduMatter, true);
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
    await expect(controller.connect(emil).votePublic(eduMatter, true)).to.be.revertedWith(
      "registered anonymous for topic"
    );
    // other topic still public
    await controller.connect(emil).votePublic(migMatter, true);

    // anonymous ballot on the education matter, weight 1, tallied live
    const scope = await controller.scopeOf(eduMatter);
    await controller.connect(relayer).voteAnonymous(eduMatter, mockProof(scope, true, 99n), true);
    expect(await tally(controller, eduMatter)).to.deep.include({ yes: 1n, no: 0n });
  });

  it("enforces scope, choice binding and nullifier uniqueness", async () => {
    const { emil, relayer, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];
    await controller.connect(emil).registerAnonymous(p.paperId, EDUCATION, 5n);
    const scope = await controller.scopeOf(matterId);
    await expect(
      controller.connect(relayer).voteAnonymous(matterId, mockProof(scope + 1n, true, 1n), true)
    ).to.be.revertedWith("wrong scope");
    // a relayer flipping the choice must fail: the message binds it
    await expect(
      controller.connect(relayer).voteAnonymous(matterId, mockProof(scope, true, 1n), false)
    ).to.be.revertedWith("message is not the choice");
    await controller.connect(relayer).voteAnonymous(matterId, mockProof(scope, true, 1n), true);
    await expect(controller.connect(relayer).voteAnonymous(matterId, mockProof(scope, true, 1n), true)).to.be.revertedWith(
      "nullifier already used"
    );
  });
});

describe("VoteController: phases and administration", () => {
  it("papers are live at creation, results are live, and the tally freezes at votingEnd", async () => {
    const { alice, ben, controller } = await loadFixture(deployFixture);
    const p = await createPaper(controller);
    const matterId = p.matterIds[0];

    expect(await controller.phaseOf(p.paperId)).to.equal(0); // Voting, immediately
    await controller.connect(alice).votePublic(matterId, true);
    // live result readable mid-vote
    expect(await tally(controller, matterId)).to.deep.include({ yes: 1n, no: 0n });
    await expect(controller.finalize(p.paperId)).to.be.revertedWith("not ended");

    await toEnded(p);
    expect(await controller.phaseOf(p.paperId)).to.equal(1); // Ended
    await expect(controller.connect(ben).votePublic(matterId, false)).to.be.revertedWith("not voting phase");
    await expect(controller.connect(ben).registerAnonymous(p.paperId, EDUCATION, 1n)).to.be.revertedWith(
      "not voting phase"
    );
    expect(await tally(controller, matterId)).to.deep.include({ yes: 1n, no: 0n }); // final
    await controller.finalize(p.paperId);
    await expect(controller.finalize(p.paperId)).to.be.revertedWith("already finalized");
  });

  it("validates paper creation and supports cancellation", async () => {
    const { alice, controller } = await loadFixture(deployFixture);
    const now = await time.latest();
    await expect(controller.createPaper("x", now - 1, [{ topicId: EDUCATION, text: "t" }])).to.be.revertedWith(
      "bad deadline"
    );
    await expect(controller.createPaper("x", now + 100, [])).to.be.revertedWith("no matters");
    await expect(controller.createPaper("x", now + 100, [{ topicId: 8, text: "t" }])).to.be.revertedWith("bad topic");
    await expect(controller.connect(alice).createPaper("x", now + 100, [])).to.be.reverted; // no role

    const p = await createPaper(controller);
    await controller.cancel(p.paperId);
    expect(await controller.phaseOf(p.paperId)).to.equal(2); // Cancelled
    await expect(controller.connect(alice).votePublic(p.matterIds[0], true)).to.be.revertedWith("not voting phase");
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

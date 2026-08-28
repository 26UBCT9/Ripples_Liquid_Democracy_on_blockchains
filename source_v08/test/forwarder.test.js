const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const EDUCATION = 2;
const abi = ethers.AbiCoder.defaultAbiCoder();

async function deployFixture() {
  const [gov, relayer, alice, dana] = await ethers.getSigners();
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
  await citizens.issue(alice.address);
  await citizens.issue(dana.address);
  return { gov, relayer, alice, dana, forwarder, citizens, delegations, controller };
}

/// Signs an OZ ERC2771Forwarder ForwardRequest exactly the way the frontend does.
async function signMeta(forwarder, signer, to, data, gas = 500_000n) {
  const { chainId } = await ethers.provider.getNetwork();
  const nonce = await forwarder.nonces(signer.address);
  const deadline = (await time.latest()) + 3600;
  const domain = {
    name: "LiquidVoteForwarder",
    version: "1",
    chainId,
    verifyingContract: await forwarder.getAddress(),
  };
  const types = {
    ForwardRequest: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "gas", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "data", type: "bytes" },
    ],
  };
  const message = { from: signer.address, to, value: 0n, gas, nonce, deadline, data };
  const signature = await signer.signTypedData(domain, types, message);
  return { from: signer.address, to, value: 0n, gas, deadline, data, signature };
}

describe("Gasless path (ERC-2771)", () => {
  it("attributes a relayed delegation to the signing voter, not the relayer", async () => {
    const { relayer, alice, dana, forwarder, delegations } = await loadFixture(deployFixture);
    const data = delegations.interface.encodeFunctionData("setDelegate", [EDUCATION, dana.address]);
    const request = await signMeta(forwarder, alice, await delegations.getAddress(), data);

    const before = await ethers.provider.getBalance(alice.address);
    await expect(forwarder.connect(relayer).execute(request))
      .to.emit(delegations, "DelegateChanged")
      .withArgs(alice.address, EDUCATION, dana.address, ethers.ZeroAddress);
    expect(await delegations.delegateOf(alice.address, EDUCATION)).to.equal(dana.address);
    // the voter paid nothing
    expect(await ethers.provider.getBalance(alice.address)).to.equal(before);
  });

  it("rejects a replayed request (nonce) and a foreign signature", async () => {
    const { relayer, alice, dana, forwarder, delegations } = await loadFixture(deployFixture);
    const data = delegations.interface.encodeFunctionData("setDelegate", [EDUCATION, dana.address]);
    const request = await signMeta(forwarder, alice, await delegations.getAddress(), data);
    await forwarder.connect(relayer).execute(request);
    await expect(forwarder.connect(relayer).execute(request)).to.be.reverted; // nonce consumed

    // relayer cannot forge a request in alice's name
    const forged = await signMeta(forwarder, relayer, await delegations.getAddress(), data);
    forged.from = alice.address;
    await expect(forwarder.connect(relayer).execute(forged)).to.be.reverted;
  });

  it("carries a gasless vote as a meta transaction, attributed and tallied live", async () => {
    const { relayer, alice, forwarder, controller } = await loadFixture(deployFixture);
    const now = await time.latest();
    await controller.createPaper("P", now + 300, [{ topicId: EDUCATION, text: "m" }]);
    const matterId = await controller.matterCount(); // voting is live immediately

    const data = controller.interface.encodeFunctionData("votePublic", [matterId, true]);
    await forwarder.connect(relayer).execute(await signMeta(forwarder, alice, await controller.getAddress(), data));
    expect(await controller.publicVoted(matterId, alice.address)).to.equal(true);
    const m = await controller.getMatter(matterId);
    expect(m.yes).to.equal(1n); // tallied at cast time
  });
});

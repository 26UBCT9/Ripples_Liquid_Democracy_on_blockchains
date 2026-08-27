const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Canonical Semaphore v4 address on public testnets (verify against
// https://docs.semaphore.pse.dev/deployed-contracts before deploying).
const DEFAULT_SEPOLIA_SEMAPHORE = "0x06d1530c829366A7fff0069e77c5af6A6FA7db2E";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} as ${deployer.address}`);
  const deployBlock = await ethers.provider.getBlockNumber();

  const forwarder = await (await ethers.getContractFactory("Forwarder")).deploy("LiquidVoteForwarder");
  await forwarder.waitForDeployment();

  const citizens = await (await ethers.getContractFactory("CitizenRegistry")).deploy(deployer.address);
  await citizens.waitForDeployment();

  let semaphoreAddress = process.env.SEMAPHORE_ADDRESS;
  if (!semaphoreAddress) {
    if (network.name === "sepolia") {
      semaphoreAddress = DEFAULT_SEPOLIA_SEMAPHORE;
      console.log(`Using canonical Semaphore at ${semaphoreAddress} (set SEMAPHORE_ADDRESS to override)`);
    } else {
      // Local networks run the REAL Semaphore v4 stack (M2): Poseidon library,
      // Groth16 verifier, Semaphore with the library linked in.
      const poseidon = await (
        await ethers.getContractFactory("poseidon-solidity/PoseidonT3.sol:PoseidonT3")
      ).deploy();
      await poseidon.waitForDeployment();
      const verifier = await (
        await ethers.getContractFactory("@semaphore-protocol/contracts/base/SemaphoreVerifier.sol:SemaphoreVerifier")
      ).deploy();
      await verifier.waitForDeployment();
      const semaphore = await (
        await ethers.getContractFactory("@semaphore-protocol/contracts/Semaphore.sol:Semaphore", {
          libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": await poseidon.getAddress() },
        })
      ).deploy(await verifier.getAddress());
      await semaphore.waitForDeployment();
      semaphoreAddress = await semaphore.getAddress();
      console.log(`Deployed real Semaphore v4 at ${semaphoreAddress} (verifier ${await verifier.getAddress()})`);
    }
  }

  const delegations = await (
    await ethers.getContractFactory("DelegationRegistry")
  ).deploy(await forwarder.getAddress(), await citizens.getAddress());
  await delegations.waitForDeployment();

  const controller = await (
    await ethers.getContractFactory("VoteController")
  ).deploy(
    await forwarder.getAddress(),
    deployer.address,
    await citizens.getAddress(),
    await delegations.getAddress(),
    semaphoreAddress
  );
  await controller.waitForDeployment();

  const { chainId } = await ethers.provider.getNetwork();
  const addresses = {
    chainId: Number(chainId),
    network: network.name,
    forwarder: await forwarder.getAddress(),
    citizenRegistry: await citizens.getAddress(),
    delegationRegistry: await delegations.getAddress(),
    voteController: await controller.getAddress(),
    semaphore: semaphoreAddress,
    deployBlock,
    rpcUrl: network.config.url || "http://127.0.0.1:8545",
  };

  const abis = {};
  for (const name of ["Forwarder", "CitizenRegistry", "DelegationRegistry", "VoteController"]) {
    abis[name] = (await artifacts.readArtifact(name)).abi;
  }
  abis.Semaphore = (await artifacts.readArtifact("@semaphore-protocol/contracts/Semaphore.sol:Semaphore")).abi;

  const deployment = { ...addresses, abi: abis };

  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.json`),
    JSON.stringify(deployment, null, 2)
  );
  const frontendDir = path.join(__dirname, "..", "frontend", "src");
  if (fs.existsSync(frontendDir)) {
    fs.writeFileSync(path.join(frontendDir, "deployment.json"), JSON.stringify(deployment, null, 2));
  }

  console.log(JSON.stringify(addresses, null, 2));
  console.log("Wrote deployments/%s.json and frontend/src/deployment.json", network.name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

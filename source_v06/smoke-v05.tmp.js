const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const REPO = "/home/claude/liquid-vote";
const { Web3 } = require(path.join(REPO, "frontend/node_modules/web3"));
const { secp256k1 } = require(path.join(REPO, "frontend/node_modules/ethereum-cryptography/secp256k1.js"));
const { Identity, Group } = require("@semaphore-protocol/core");
const { generateProof } = require("@semaphore-protocol/proof");

const artifactsFor = (d) => ({
  wasm: path.join(REPO, "node_modules/@zk-kit/semaphore-artifacts", `semaphore-${d}.wasm`),
  zkey: path.join(REPO, "node_modules/@zk-kit/semaphore-artifacts", `semaphore-${d}.zkey`),
});

// same digest construction as frontend/src/lib/eip712.js
function forwardDigest(web3, domain, r) {
  const abi = web3.eth.abi;
  const DT = web3.utils.keccak256(web3.utils.utf8ToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const FT = web3.utils.keccak256(web3.utils.utf8ToHex("ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"));
  const ds = web3.utils.keccak256(abi.encodeParameters(["bytes32","bytes32","bytes32","uint256","address"],
    [DT, web3.utils.keccak256(web3.utils.utf8ToHex(domain.name)), web3.utils.keccak256(web3.utils.utf8ToHex(domain.version)), domain.chainId, domain.verifyingContract]));
  const sh = web3.utils.keccak256(abi.encodeParameters(["bytes32","address","address","uint256","uint256","uint256","uint48","bytes32"],
    [FT, r.from, r.to, r.value, r.gas, r.nonce, r.deadline, web3.utils.keccak256(r.data)]));
  return web3.utils.keccak256("0x1901" + ds.slice(2) + sh.slice(2));
}

(async () => {
  const dep = JSON.parse(fs.readFileSync("deployments/localhost.json", "utf8"));
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const web3 = new Web3("http://127.0.0.1:8545");
  const gov = new ethers.NonceManager(new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider));
  const emil = new ethers.Wallet("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", provider); // hh #6
  const luca = new ethers.Wallet("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", provider); // hh #7

  const citizens = new ethers.Contract(dep.citizenRegistry, dep.abi.CitizenRegistry, gov);
  const controller = new ethers.Contract(dep.voteController, dep.abi.VoteController, gov);
  const delegations = new ethers.Contract(dep.delegationRegistry, dep.abi.DelegationRegistry, provider);
  const forwarder = new ethers.Contract(dep.forwarder, dep.abi.Forwarder, provider);

  const fresh = ethers.Wallet.createRandom().connect(provider);
  for (const a of [emil.address, luca.address, fresh.address]) await (await citizens.issue(a)).wait();

  const now = (await provider.getBlock("latest")).timestamp;
  await (await controller.createPaper("v0.5 smoke", now + 1000, now + 2000, [{ topicId: 2, text: "Live voting?" }])).wait();
  const paperId = await controller.paperCount();
  const { matterIds } = await controller.getPaper(paperId);
  const matterId = matterIds[0];
  console.log(`paper ${paperId} live, phase = ${await controller.phaseOf(paperId)} (expect 0)`);

  // 1) gasless delegation from the 0 ETH wallet via manual EIP-712 digest
  const data = delegations.interface.encodeFunctionData("setDelegate", [2, emil.address]);
  const req = { from: fresh.address, to: dep.delegationRegistry, value: "0", gas: "400000",
    nonce: (await forwarder.nonces(fresh.address)).toString(), deadline: now + 3600, data };
  const digest = forwardDigest(web3, { name: "LiquidVoteForwarder", version: "1", chainId: 31337, verifyingContract: dep.forwarder }, req);
  const sg = secp256k1.sign(digest.slice(2), fresh.privateKey.slice(2));
  const signature = "0x" + sg.toCompactHex() + (sg.recovery + 27).toString(16).padStart(2, "0");
  let res = await fetch("http://127.0.0.1:3001/relay/meta", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature }),
  });
  console.log("gasless delegation:", res.status, JSON.stringify(await res.json()).slice(0, 80));
  console.log(`  delegateOf(fresh) = ${(await delegations.delegateOf(fresh.address, 2)) === emil.address ? "emil (OK)" : "WRONG"}, fresh balance = ${ethers.formatEther(await provider.getBalance(fresh.address))} ETH`);

  // 2) anonymous flow during the live voting window
  const emilId = new Identity("emil-smoke-seed");
  const lucaId = new Identity("luca-smoke-seed");
  await (await controller.connect(emil).registerAnonymous(paperId, 2, emilId.commitment)).wait();
  await (await controller.connect(luca).registerAnonymous(paperId, 2, lucaId.commitment)).wait();

  const group = new Group([emilId.commitment, lucaId.commitment]);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const salt = ethers.encodeBytes32String("emil-v05");
  const commitment = ethers.keccak256(abi.encode(["uint256", "bool", "bytes32"], [matterId, true, salt]));
  const scope = await controller.scopeOf(matterId);
  console.log("generating proof (depth", group.depth + ")…");
  const proof = await generateProof(emilId, group, BigInt(commitment), scope, group.depth, artifactsFor(group.depth));

  res = await fetch("http://127.0.0.1:3001/relay/anonymous", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "commit", matterId: matterId.toString(), proof, commitment }),
  });
  const commitBody = await res.json();
  console.log("relay commit:", res.status, JSON.stringify(commitBody));

  await provider.send("evm_setNextBlockTimestamp", [now + 1001]);
  await provider.send("evm_mine", []);
  res = await fetch("http://127.0.0.1:3001/relay/anonymous", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "reveal", matterId: matterId.toString(), index: commitBody.index, choice: true, salt }),
  });
  console.log("relay reveal:", res.status, JSON.stringify(await res.json()));

  const m = await controller.getMatter(matterId);
  console.log(`tally: yes=${m.yes} no=${m.no} (expected yes=1), phase = ${await controller.phaseOf(paperId)} (expect 1)`);
  if (m.yes !== 1n) process.exit(1);
  console.log("V0.5 SMOKE PASSED");
})().catch((e) => { console.error("SMOKE FAIL:", e.shortMessage || e.message); process.exit(1); });

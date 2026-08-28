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
  const citizens = new ethers.Contract(dep.citizenRegistry, dep.abi.CitizenRegistry, gov);
  const controller = new ethers.Contract(dep.voteController, dep.abi.VoteController, gov);
  const forwarder = new ethers.Contract(dep.forwarder, dep.abi.Forwarder, provider);

  const publicW3 = web3.eth.accounts.create();
  const anonW3 = web3.eth.accounts.create();
  await (await citizens.issue(publicW3.address)).wait();
  await (await citizens.issue(anonW3.address)).wait();
  const now = (await provider.getBlock("latest")).timestamp;
  await (await controller.createPaper("Live vote", now + 600, [{ topicId: 2, text: "Direct?" }])).wait();
  const paperId = await controller.paperCount();
  const { matterIds } = await controller.getPaper(paperId);
  const matterId = matterIds[0];

  const relayMeta = async (acct, to, data, gas) => {
    const req = { from: acct.address, to, value: "0", gas: String(gas),
      nonce: (await forwarder.nonces(acct.address)).toString(),
      deadline: Math.floor(Date.now()/1000) + 3600, data };
    const digest = forwardDigest(web3, { name: "LiquidVoteForwarder", version: "1", chainId: dep.chainId, verifyingContract: dep.forwarder }, req);
    const sg = secp256k1.sign(digest.slice(2), acct.privateKey.slice(2));
    const signature = "0x" + sg.toCompactHex() + (sg.recovery + 27).toString(16).padStart(2, "0");
    const r = await fetch("http://127.0.0.1:3001/relay/meta", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature }) });
    return { status: r.status, body: await r.json() };
  };

  const w3ctrl = new web3.eth.Contract(dep.abi.VoteController, dep.voteController);

  // 1) public gasless vote -> live tally immediately
  let r = await relayMeta(publicW3, dep.voteController, w3ctrl.methods.votePublic(matterId.toString(), true).encodeABI(), 500000);
  console.log("public vote:", r.status);
  let m = await controller.getMatter(matterId);
  console.log(`live tally after public vote: yes=${m.yes} no=${m.no} (expect 1/0)`);

  // 2) solo anonymous vote, choice bound as the message
  r = await relayMeta(anonW3, dep.voteController, w3ctrl.methods.registerAnonymous(paperId.toString(), 2, new Identity(anonW3.sign("liquid-vote identity v1").signature).commitment.toString()).encodeABI(), 900000);
  console.log("gasless registerAnonymous:", r.status);
  const identity = new Identity(anonW3.sign("liquid-vote identity v1").signature);
  const group = new Group([identity.commitment]);
  const depth = Math.max(1, group.depth);
  const proof = await generateProof(identity, group, 2, (await controller.scopeOf(matterId)).toString(), depth, artifactsFor(depth)); // 2 = No
  let res = await fetch("http://127.0.0.1:3001/relay/anonymous", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "vote", matterId: matterId.toString(), proof, choice: false }) });
  console.log("anon vote:", res.status, JSON.stringify(await res.json()).slice(0, 70));
  m = await controller.getMatter(matterId);
  console.log(`live tally after anon vote: yes=${m.yes} no=${m.no} (expect 1/1)`);

  // 3) double anonymous vote -> readable error
  const proof2 = await generateProof(identity, group, 1, (await controller.scopeOf(matterId)).toString(), depth, artifactsFor(depth));
  res = await fetch("http://127.0.0.1:3001/relay/anonymous", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "vote", matterId: matterId.toString(), proof: proof2, choice: true }) });
  console.log("double anon vote:", res.status, JSON.stringify(await res.json()));

  // 4) after votingEnd: votes rejected, tally frozen, finalize works
  await provider.send("evm_setNextBlockTimestamp", [now + 601]);
  await provider.send("evm_mine", []);
  r = await relayMeta(publicW3, dep.voteController, w3ctrl.methods.votePublic(matterId.toString(), false).encodeABI(), 500000);
  console.log("vote after close:", r.status, JSON.stringify(r.body));
  await (await controller.finalize(paperId)).wait();
  m = await controller.getMatter(matterId);
  console.log(`final tally: yes=${m.yes} no=${m.no}, finalized=${(await controller.getPaper(paperId)).finalized}`);
  if (m.yes !== 1n || m.no !== 1n) process.exit(1);
  console.log("V0.8 SMOKE PASSED");
})().catch((e) => { console.error("FAIL:", e.shortMessage || e.message); process.exit(1); });

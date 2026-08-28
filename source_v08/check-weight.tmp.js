const { ethers } = require("ethers");
const fs = require("fs");
(async () => {
  const dep = JSON.parse(fs.readFileSync("deployments/localhost.json", "utf8"));
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const gov = new ethers.NonceManager(new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider));
  const A = new ethers.Wallet("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", provider); // delegates BEFORE
  const B = new ethers.Wallet("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", provider); // delegate
  const C = new ethers.Wallet("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", provider); // delegates AFTER

  const citizens = new ethers.Contract(dep.citizenRegistry, dep.abi.CitizenRegistry, gov);
  const controller = new ethers.Contract(dep.voteController, dep.abi.VoteController, gov);
  const delegations = new ethers.Contract(dep.delegationRegistry, dep.abi.DelegationRegistry, provider);
  for (const w of [A.address, B.address, C.address]) await (await citizens.issue(w)).wait();

  // A delegates Education to B BEFORE the paper exists
  await (await delegations.connect(A).setDelegate(2, B.address)).wait();

  const now = (await provider.getBlock("latest")).timestamp;
  await (await controller.createPaper("Weight check", now + 600, [{ topicId: 2, text: "Empowered?" }])).wait();
  const paperId = await controller.paperCount();
  const { matterIds } = await controller.getPaper(paperId);
  const matterId = matterIds[0];
  const snapshot = await controller.snapshotOf(paperId);

  // C delegates to B AFTER publication: must not count for THIS paper
  await (await delegations.connect(C).setDelegate(2, B.address)).wait();

  console.log("what the frontend will read:");
  console.log("  A snapshot delegate:", await delegations.getPastDelegate(A.address, 2, snapshot), "(expect B)");
  console.log("  C snapshot delegate:", await delegations.getPastDelegate(C.address, 2, snapshot), "(expect 0x0: set after publication)");
  console.log("  C current delegate :", await delegations.delegateOf(C.address, 2), "(expect B: counts next paper)");
  console.log("  B inbound at snapshot:", (await delegations.getPastInboundWeight(B.address, 2, snapshot)).toString(), "(expect 1)");

  await (await controller.connect(B).votePublic(matterId, true)).wait();
  let m = await controller.getMatter(matterId);
  console.log(`B votes Yes -> tally yes=${m.yes} (expect 2: own 1 + A's delegated 1; C's post-publication delegation correctly excluded)`);

  await (await controller.connect(A).votePublic(matterId, false)).wait();
  m = await controller.getMatter(matterId);
  console.log(`A overrides with No -> tally yes=${m.yes} no=${m.no} (expect 1/1)`);
  if (m.yes !== 1n || m.no !== 1n) process.exit(1);
  console.log("DELEGATION EMPOWERMENT VERIFIED");
})().catch((e) => { console.error("FAIL:", e.shortMessage || e.message); process.exit(1); });

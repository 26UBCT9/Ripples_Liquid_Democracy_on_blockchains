/**
 * Government relayer.
 *
 * Pays the gas so voters never need ETH:
 *  - /relay/meta       ERC-2771 meta transactions (delegation, registration,
 *                      public commits and reveals). The voter's EIP-712
 *                      signature is the authorization; the forwarder recovers
 *                      the voter, so the relayer can never act in their name.
 *  - /relay/anonymous  Anonymous ballots. Submitted from the relayer's own
 *                      account WITHOUT any voter signature (spec Rule 3): the
 *                      Semaphore proof or the salted commitment is the
 *                      authorization.
 *
 * Policy: only the two allowlisted targets are relayed, and delegation flips
 * are capped per voter (they are the one unbounded action, see spec section 7).
 * Anyone can always bypass this service and pay their own gas.
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const DEPLOYMENT = process.env.DEPLOYMENT || "../deployments/localhost.json";
// Hardhat account #1 as a dev default; set RELAYER_KEY in production.
const RELAYER_KEY =
  process.env.RELAYER_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const MAX_DELEGATION_RELAYS_PER_HOUR = 5;

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const baseWallet = new ethers.Wallet(RELAYER_KEY, provider);
// NonceManager serializes tx nonces so parallel relay requests never clash.
const wallet = new ethers.NonceManager(baseWallet);

const forwarder = new ethers.Contract(deployment.forwarder, deployment.abi.Forwarder, wallet);
const controller = new ethers.Contract(deployment.voteController, deployment.abi.VoteController, wallet);
const delegationIface = new ethers.Interface(deployment.abi.DelegationRegistry);

// Decode custom errors from every contract we know, so a Semaphore revert
// becomes a readable message instead of "unknown custom error".
const errorIfaces = ["VoteController", "Forwarder", "CitizenRegistry", "DelegationRegistry", "Semaphore"]
  .filter((n) => deployment.abi[n])
  .map((n) => new ethers.Interface(deployment.abi[n]));

const FRIENDLY = {
  Semaphore__YouAreUsingTheSameNullifierTwice: "this identity has already voted on this matter",
  Semaphore__MerkleTreeRootIsNotPartOfTheGroup: "proof does not match the current anonymity set, sync and retry",
  Semaphore__InvalidProof: "invalid zero-knowledge proof",
  Semaphore__MerkleTreeDepthIsNotSupported: "unsupported merkle tree depth",
  ERC2771ForwarderInvalidSigner: "signature does not match the voter",
  ERC2771ForwarderExpiredRequest: "request deadline expired",
};

function explain(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const iface of errorIfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return FRIENDLY[parsed.name] || parsed.name;
      } catch {}
    }
  }
  if (e?.reason) return e.reason;
  return e?.shortMessage || e?.message || "relay failed";
}

// A restarted or redeployed chain is the classic source of mystery errors
// ("could not coalesce error", nonce too low): detect and say so.
async function ensureDeployment() {
  if ((await provider.getCode(deployment.forwarder)) === "0x") {
    throw new Error(
      "no contract code at the recorded addresses: the chain was restarted or redeployed. Run deploy:local, then restart this relayer."
    );
  }
}

// After a node restart the NonceManager cache is stale; reset and retry once.
async function sendResilient(fn) {
  try {
    return await fn();
  } catch (e) {
    if (/coalesce|nonce/i.test(e?.message || "")) {
      wallet.reset();
      return await fn();
    }
    throw e;
  }
}

const allowedTargets = new Set(
  [deployment.delegationRegistry, deployment.voteController].map((a) => a.toLowerCase())
);
const delegationSelectors = new Set(
  ["setDelegate", "clearDelegate"].map((f) => delegationIface.getFunction(f).selector)
);

// naive in-memory rate limiter: voter -> timestamps of relayed delegation txs
const delegationLog = new Map();
function delegationCapExceeded(from) {
  const now = Date.now();
  const log = (delegationLog.get(from) || []).filter((t) => now - t < 3600_000);
  delegationLog.set(from, log);
  return log.length >= MAX_DELEGATION_RELAYS_PER_HOUR;
}

provider.getCode(deployment.forwarder).then((code) => {
  if (code === "0x") {
    console.warn("WARNING: no contract code at the deployment addresses. Deploy first, then restart the relayer.");
  }
}).catch(() => console.warn("WARNING: chain not reachable at " + RPC_URL));

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

app.get("/health", async (_req, res) => {
  const balance = await provider.getBalance(baseWallet.address);
  res.json({ relayer: baseWallet.address, balance: ethers.formatEther(balance), chainId: deployment.chainId });
});

app.post("/relay/meta", async (req, res) => {
  try {
    await ensureDeployment();
    const { request, signature } = req.body;
    if (!request || !signature) return res.status(400).json({ error: "request and signature required" });

    const to = String(request.to).toLowerCase();
    if (!allowedTargets.has(to)) return res.status(403).json({ error: "target not allowlisted" });

    const selector = String(request.data).slice(0, 10);
    if (to === deployment.delegationRegistry.toLowerCase() && delegationSelectors.has(selector)) {
      if (delegationCapExceeded(request.from)) {
        return res.status(429).json({ error: "delegation relay cap reached, submit self-paid or retry later" });
      }
      delegationLog.get(request.from).push(Date.now());
    }

    const forwardRequest = {
      from: request.from,
      to: request.to,
      value: BigInt(request.value ?? 0),
      gas: BigInt(request.gas),
      deadline: Number(request.deadline),
      data: request.data,
      signature,
    };
    // pre-validate so garbage never costs gas
    if (!(await forwarder.verify(forwardRequest))) {
      return res.status(400).json({ error: "invalid forward request (signature/nonce/deadline)" });
    }
    const tx = await sendResilient(() => forwarder.execute(forwardRequest));
    const receipt = await tx.wait();
    res.json({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
  } catch (e) {
    console.error("/relay/meta failed:", e);
    res.status(500).json({ error: explain(e) });
  }
});

app.post("/relay/anonymous", async (req, res) => {
  try {
    await ensureDeployment();
    const { kind } = req.body;
    let tx;
    if (kind === "commit") {
      const { matterId, proof, commitment } = req.body;
      const p = {
        merkleTreeDepth: BigInt(proof.merkleTreeDepth),
        merkleTreeRoot: BigInt(proof.merkleTreeRoot),
        nullifier: BigInt(proof.nullifier),
        message: BigInt(proof.message),
        scope: BigInt(proof.scope),
        points: proof.points.map(BigInt),
      };
      await controller.commitAnonymous.staticCall(matterId, p, commitment); // pre-validate
      tx = await sendResilient(() => controller.commitAnonymous(matterId, p, commitment));
    } else if (kind === "reveal") {
      const { matterId, index, choice, salt } = req.body;
      await controller.revealAnonymous.staticCall(matterId, index, choice, salt);
      tx = await sendResilient(() => controller.revealAnonymous(matterId, index, choice, salt));
    } else {
      return res.status(400).json({ error: "kind must be commit or reveal" });
    }
    const receipt = await tx.wait();
    // For commits, hand the ballot index back: the voter needs it to reveal.
    let index = null;
    for (const log of receipt.logs) {
      try {
        const parsed = controller.interface.parseLog(log);
        if (parsed?.name === "AnonymousCommit") {
          index = Number(parsed.args.index);
          break;
        }
      } catch {}
    }
    res.json({ txHash: receipt.hash, blockNumber: receipt.blockNumber, index });
  } catch (e) {
    console.error("/relay/anonymous failed:", e);
    res.status(500).json({ error: explain(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Relayer ${baseWallet.address} listening on :${PORT}, targets:`, [...allowedTargets]);
});

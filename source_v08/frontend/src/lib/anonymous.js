/**
 * M2 anonymity layer for the browser.
 *
 * Identity: deterministically derived from one wallet signature, so the same
 * account always recovers the same Semaphore identity on any device. The
 * signature never leaves this browser and is never sent on-chain.
 *
 * Group sync: the Merkle tree is rebuilt from the Semaphore contract's
 * MemberAdded events for the (paper, topic) group, in insertion order.
 *
 * Proving: Groth16 in the browser. The wasm/zkey artifacts ship with the app
 * (bundled from @zk-kit/semaphore-artifacts, depths 1-10); if an artifact is
 * missing the library falls back to fetching from the public PSE CDN.
 */
import { Identity, Group } from "@semaphore-protocol/core";
import { generateProof } from "@semaphore-protocol/proof";
import { contracts, deployment, web3, RELAYER_URL, signPersonal } from "./chain";

// Bundled snark artifacts, depth 1..10 (an anonymity set of up to 1024).
const wasmUrls = import.meta.glob("/node_modules/@zk-kit/semaphore-artifacts/semaphore-{1,2,3,4,5,6,7,8,9,10}.wasm", {
  query: "?url",
  import: "default",
  eager: true,
});
const zkeyUrls = import.meta.glob("/node_modules/@zk-kit/semaphore-artifacts/semaphore-{1,2,3,4,5,6,7,8,9,10}.zkey", {
  query: "?url",
  import: "default",
  eager: true,
});

function artifactsFor(depth) {
  const wasm = wasmUrls[`/node_modules/@zk-kit/semaphore-artifacts/semaphore-${depth}.wasm`];
  const zkey = zkeyUrls[`/node_modules/@zk-kit/semaphore-artifacts/semaphore-${depth}.zkey`];
  if (!wasm || !zkey) return undefined; // let the library fetch from its CDN
  return { wasm: new URL(wasm, window.location.origin).href, zkey: new URL(zkey, window.location.origin).href };
}

const IDENTITY_MESSAGE = "liquid-vote identity v1";
const identityCache = new Map(); // account -> Identity (in memory only, it is a secret)

/** Derive (or recall) the voter's Semaphore identity. Asks for one signature. */
export async function getIdentity(account) {
  const key = account.toLowerCase();
  if (identityCache.has(key)) return identityCache.get(key);
  const signature = await signPersonal(IDENTITY_MESSAGE);
  const identity = new Identity(signature);
  identityCache.set(key, identity);
  return identity;
}

/** Rebuild the Semaphore group for (paperId, topicId) from chain events. */
export async function syncGroup(paperId, topicId) {
  const { controller } = contracts();
  const groupId = (await controller.methods.groupIdOf(paperId, topicId).call()).toString();
  const semaphore = new web3.eth.Contract(deployment.abi.Semaphore, deployment.semaphore);
  const events = await semaphore.getPastEvents("MemberAdded", {
    filter: { groupId },
    fromBlock: deployment.deployBlock ?? 0,
    toBlock: "latest",
  });
  const members = events
    .sort((a, b) => Number(a.returnValues.index) - Number(b.returnValues.index))
    .map((e) => BigInt(e.returnValues.identityCommitment));
  return { group: new Group(members), groupId, size: members.length };
}

/** Number of registered members of the (paper, topic) anonymity set. */
export async function anonymitySetSize(paperId, topicId) {
  try {
    const { controller } = contracts();
    const groupId = (await controller.methods.groupIdOf(paperId, topicId).call()).toString();
    const semaphore = new web3.eth.Contract(deployment.abi.Semaphore, deployment.semaphore);
    return Number(await semaphore.methods.getMerkleTreeSize(groupId).call());
  } catch {
    return null;
  }
}

/**
 * Generate the membership proof for one ballot and hand everything to the
 * relayer, which submits from its own account - no voter signature anywhere.
 * The choice itself is the proof's message, so the relayer cannot flip it.
 */
export async function voteAnonymousBallot(account, paperId, topicId, matterId, choice) {
  const identity = await getIdentity(account);
  const { group } = await syncGroup(paperId, topicId);
  if (!group.members.some((m) => m === identity.commitment)) {
    throw new Error("This account's identity is not registered in the anonymity set of this topic.");
  }
  const { controller } = contracts();
  const scope = (await controller.methods.scopeOf(matterId).call()).toString();

  // A group with one member has tree depth 0; the circuit needs at least 1.
  const depth = Math.max(1, group.depth);
  const message = choice ? 1 : 2;
  const proof = await generateProof(identity, group, message, scope, depth, artifactsFor(depth));

  const res = await fetch(`${RELAYER_URL}/relay/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "vote", matterId: matterId.toString(), proof, choice }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "anonymous relay failed");
  return body;
}

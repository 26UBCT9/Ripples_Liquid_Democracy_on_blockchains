import Web3 from "web3";
import deployment from "../deployment.json";
import { forwardRequestDigest, signDigest } from "./eip712";

export const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://127.0.0.1:3001";
export const RPC_URL = import.meta.env.VITE_RPC_URL || deployment.rpcUrl || "http://127.0.0.1:8545";

export const isDeployed = Boolean(deployment.voteController);

// All reads and locally signed sends go through the RPC directly, pinned to
// the right network. MetaMask is only consulted when a MetaMask session signs.
export const web3 = new Web3(RPC_URL);
export const injected = typeof window !== "undefined" ? window.ethereum : null;

export { deployment };

// ------------------------------------------------------------------ session
// The demo ships with well-known Hardhat dev keys so one browser can play
// government and several voters without any wallet juggling. NEVER use these
// keys outside a local chain. The fresh voter proves the zero-ETH journey.

const HH_KEYS = {
  government: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
  alice: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
  ben: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
  carla: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
  dana: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
};

const FRESH_KEY_SLOT = `demo:freshvoter:${deployment.chainId}`;

function freshVoterKey() {
  let key = localStorage.getItem(FRESH_KEY_SLOT);
  if (!key) {
    key = web3.eth.accounts.create().privateKey;
    localStorage.setItem(FRESH_KEY_SLOT, key);
  }
  return key;
}

export function demoAccounts() {
  const acc = (label, key, note) => ({
    id: label.toLowerCase().replace(/[^a-z]/g, "-"),
    label,
    note,
    key,
    address: web3.eth.accounts.privateKeyToAccount(key).address,
  });
  return [
    acc("Government", HH_KEYS.government, "admin roles, pays its own gas"),
    acc("Alice", HH_KEYS.alice, "voter"),
    acc("Ben", HH_KEYS.ben, "voter"),
    acc("Carla", HH_KEYS.carla, "voter"),
    acc("Dana", HH_KEYS.dana, "voter"),
    acc("Fresh voter", freshVoterKey(), "random key, 0 ETH, fully gasless"),
  ];
}

let session = null; // { type: 'local'|'metamask', address, key? }

export const getSession = () => session;

export function useLocalAccount(account) {
  session = { type: "local", address: account.address, key: account.key };
  return session;
}

export async function useMetaMask() {
  if (!injected) throw new Error("No wallet extension found.");
  const [addr] = await injected.request({ method: "eth_requestAccounts" });
  session = { type: "metamask", address: web3.utils.toChecksumAddress(addr) };
  return session;
}

/** Chain id MetaMask is currently on (local sessions are always pinned right). */
export async function injectedChainId() {
  if (!injected) return null;
  return Number(await injected.request({ method: "eth_chainId" }));
}

// ---------------------------------------------------------------- contracts

export function contracts() {
  return {
    forwarder: new web3.eth.Contract(deployment.abi.Forwarder, deployment.forwarder),
    citizens: new web3.eth.Contract(deployment.abi.CitizenRegistry, deployment.citizenRegistry),
    delegations: new web3.eth.Contract(deployment.abi.DelegationRegistry, deployment.delegationRegistry),
    controller: new web3.eth.Contract(deployment.abi.VoteController, deployment.voteController),
  };
}

// ------------------------------------------------------------------- sending

/** Self-paid transaction from the active session (government/admin actions). */
export async function sendTx(to, data, gas = 3_000_000) {
  if (!session) throw new Error("Pick an account first.");
  if (session.type === "local") {
    const tx = {
      from: session.address,
      to,
      data,
      gas,
      gasPrice: await web3.eth.getGasPrice(),
      nonce: await web3.eth.getTransactionCount(session.address, "pending"),
      chainId: deployment.chainId,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, session.key);
    return web3.eth.sendSignedTransaction(signed.rawTransaction);
  }
  const txHash = await injected.request({
    method: "eth_sendTransaction",
    params: [{ from: session.address, to, data }],
  });
  return { transactionHash: txHash };
}

/**
 * Gasless voter action: sign an ERC-2771 ForwardRequest and hand it to the
 * government relayer. Local sessions sign the EIP-712 digest directly, a
 * MetaMask session signs the same typed data via eth_signTypedData_v4.
 */
export async function sendGasless(to, data, gas = 600000) {
  if (!session) throw new Error("Pick an account first.");
  const { forwarder } = contracts();
  const from = session.address;
  const nonce = (await forwarder.methods.nonces(from).call()).toString();
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = {
    name: "LiquidVoteForwarder",
    version: "1",
    chainId: deployment.chainId,
    verifyingContract: deployment.forwarder,
  };
  const request = { from, to, value: "0", gas: String(gas), nonce, deadline, data };

  let signature;
  if (session.type === "local") {
    signature = signDigest(forwardRequestDigest(domain, request), session.key);
  } else {
    const typedData = {
      domain,
      primaryType: "ForwardRequest",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ForwardRequest: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "gas", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "data", type: "bytes" },
        ],
      },
      message: request,
    };
    signature = await injected.request({
      method: "eth_signTypedData_v4",
      params: [from, JSON.stringify(typedData)],
    });
  }

  const res = await fetch(`${RELAYER_URL}/relay/meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "relay failed");
  return body;
}

/** Personal-message signature (identity derivation). Never leaves the browser. */
export async function signPersonal(message) {
  if (!session) throw new Error("Pick an account first.");
  if (session.type === "local") {
    return web3.eth.accounts.sign(message, session.key).signature;
  }
  return injected.request({
    method: "personal_sign",
    params: [web3.utils.utf8ToHex(message), session.address],
  });
}

// ------------------------------------------------------------- commitments

export function randomSalt() {
  return web3.utils.randomHex(32);
}

/** Public ballot: keccak256(abi.encode(matterId, voter, choice, salt)). */
export function publicCommitment(matterId, voter, choice, salt) {
  return web3.utils.keccak256(
    web3.eth.abi.encodeParameters(["uint256", "address", "bool", "bytes32"], [matterId, voter, choice, salt])
  );
}

/** Anonymous ballot: keccak256(abi.encode(matterId, choice, salt)) - no address. */
export function anonCommitment(matterId, choice, salt) {
  return web3.utils.keccak256(
    web3.eth.abi.encodeParameters(["uint256", "bool", "bytes32"], [matterId, choice, salt])
  );
}

// -------------------------------------------------- local ballot storage
// The salt must survive until the reveal phase; it lives in this browser.

const ballotKey = (account, matterId) => `ballot:${deployment.chainId}:${account.toLowerCase()}:${matterId}`;

export function storeBallot(account, matterId, ballot) {
  localStorage.setItem(ballotKey(account, matterId), JSON.stringify(ballot));
}

export function loadBallot(account, matterId) {
  const raw = localStorage.getItem(ballotKey(account, matterId));
  return raw ? JSON.parse(raw) : null;
}

// Anonymous ballots get their own slot: {choice, salt, index}. The index in
// the matter's commitment list is needed for the reveal.
const anonKey = (account, matterId) => `anonballot:${deployment.chainId}:${account.toLowerCase()}:${matterId}`;

export function storeAnonBallot(account, matterId, ballot) {
  localStorage.setItem(anonKey(account, matterId), JSON.stringify(ballot));
}

export function loadAnonBallot(account, matterId) {
  const raw = localStorage.getItem(anonKey(account, matterId));
  return raw ? JSON.parse(raw) : null;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

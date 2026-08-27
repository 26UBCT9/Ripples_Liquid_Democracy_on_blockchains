# LiquidVote

Liquid democracy on Ethereum: soulbound voting rights, voting papers with yes/no matters in eight fixed topics, per topic one hop delegation with own vote override, optional unlinkable anonymous ballots (Semaphore v4, real Groth16 proofs in the browser), sealed ballots until the voting window closes (commit reveal), and gasless voting through a government relayer (ERC-2771). Frontend in React with web3.js.

Architecture and design rationale: `liquid-voting-architecture.md` (v0.6).

## Lifecycle

A paper is **live the moment it is published**. There are no delegation or registration windows:

1. **Voting** (creation to `votingEnd`): vote Yes/No per matter, or switch a topic to anonymous mode first, any time. Ballots stay sealed.
2. **Reveal** (`votingEnd` to `revealEnd`): the evaluation period. Ballots are opened and tallied live.
3. **Ended**: result final, anyone can finalize.

Delegations are standing: set them whenever you like, per topic. Each paper counts them exactly as they stood at its publication; later changes apply from the next paper.

## Quickstart (local)

Requirements: Node 22 (`nvm install 22`), three installs on first run:

```bash
npm install                # repo root: contracts + tests
cd relayer && npm install && cd ..
cd frontend && npm install && cd ..
```

Run the full test suite (23 tests, includes real Groth16 proofs verified on chain):

```bash
npm test
```

Start the stack in four terminals:

```bash
npm run node                       # 1: local chain (5s blocks so time advances)
npm run deploy:local               # 2: deploys everything incl. real Semaphore v4
cd relayer && npm start            # 3: government relayer on :3001
cd frontend && npm run dev         # 4: app on http://localhost:5173
```

## Demo walkthrough (no MetaMask needed)

The header has an **account switcher** with local demo accounts (well known Hardhat dev keys, local chains only). Voter actions are signed in the browser and relayed gas free; Government pays its own gas. Tabs follow the on-chain roles of the active account: Paper and Citizen administration appear only for holders of `CREATOR_ROLE` / `ISSUER_ROLE`, the Vote tab only for citizen token holders, and Results for everyone.

1. Pick **Government**. In *Citizen administration*, the demo voters are listed with one-click *Issue voting right* buttons (any other address works via the form below). In *Paper administration*, publish a paper with one or two matters; the defaults (voting +10 min, evaluation +20 min) are fine.
2. Switch to **Alice**: the paper is already open. Vote Yes on a matter, or set a standing delegation for a topic first (it will count from the *next* paper, the UI says so).
3. Switch to **Ben**: pick *Go anonymous* on a topic, then vote. One signature derives the anonymous identity, the browser generates a real zero knowledge proof (a few seconds), and the relayer submits it from its own account: nothing on chain links the ballot to Ben.
4. Switch to the **Fresh voter** (random key, 0 ETH): delegate and vote. Everything works without ever funding the account, which is the gasless requirement demonstrated end to end.
5. When the voting countdown ends, switch through the voters and press *Reveal* on each ballot; watch the tally build in *Results*. After the evaluation window, finalize.

MetaMask is optional: pick "MetaMask…" in the switcher to use a real wallet (point it at `http://127.0.0.1:8545`, chain id 31337). Same flows, signatures via the extension.

## Anonymity (M2, implemented)

- Identity: `new Identity(signature)` from one wallet signature over a fixed message; deterministic, never stored, never on chain. Only the commitment is published when you opt in.
- Groups: one Semaphore group per (paper, topic), created atomically with the paper. The browser rebuilds the tree from `MemberAdded` events (from the recorded deploy block) and shows the anonymity set size, warning below 20.
- Proofs: Groth16 in the browser via `@semaphore-protocol/proof`; wasm/zkey artifacts for tree depths 1 to 10 ship with the app (CDN fallback otherwise). First proof takes a few seconds.
- Opting in works mid vote: Semaphore keeps a history of recent roots (default 1h), so proofs against a slightly stale root still verify while others join. Early anonymous ballots hide in smaller sets; the UI is honest about it.
- Double ballot protection both ways: anonymous mode blocks public ballots on that topic, and a public ballot blocks a later switch to anonymous on that topic.
- The relayer submits anonymous ballots from its own account and returns the ballot index needed for the reveal. Locally the deploy script deploys the real Semaphore v4 stack (PoseidonT3, verifier, Semaphore), so local demos verify genuine proofs on chain.

## Sepolia

```bash
cp .env.example .env        # SEPOLIA_RPC_URL, PRIVATE_KEY; SEMAPHORE_ADDRESS is prefilled
npm run deploy:sepolia
cd relayer && cp .env.example .env   # RELAYER_KEY, RPC_URL, fund the relayer from a faucet
npm start
cd frontend && npm run build         # VITE_RPC_URL=<your sepolia rpc> if it differs from deploy
```

The deployment reuses the canonical Semaphore v4 on Sepolia (verify the address against docs.semaphore.pse.dev, Deployed Contracts). The demo switcher accounts hold no Sepolia ETH; use MetaMask sessions there, voters still need none thanks to the relayer. Note: rebuilding anonymity groups uses `eth_getLogs` from the deploy block; free RPCs with tight log range caps may need a paid endpoint for long lived deployments.

## Tests

`npm test` runs 23 tests: soulbound registry, checkpointed delegations with the creation snapshot boundary, override arithmetic in every reveal order (incl. the dual role voter), phase gating on the live lifecycle, double ballot guards in both directions, forwarder attribution and replay rejection, and a real proof suite that deploys the genuine Semaphore contracts, verifies Groth16 on chain, grows the group mid vote, and rejects outsider roots, reused nullifiers and swapped commitments.

## Layout

```
contracts/          CitizenRegistry, DelegationRegistry, VoteController, Forwarder,
                    mocks/MockSemaphore (unit tests), semaphore/Imports.sol (real stack)
scripts/deploy.js   deploys everything; local networks get the real Semaphore v4
test/               core.test.js, forwarder.test.js, real-anonymity.test.js
relayer/            Express relayer: /relay/meta, /relay/anonymous, /health
frontend/           React + web3.js, account switcher, four views
```

## Security notes for the demo

The bundled demo keys are the public Hardhat dev keys; anything sent to them on a public network is lost. The fresh voter's random key and all ballot salts live in browser localStorage: fine for a local demo, stated as a limitation in the architecture document. Never point the switcher's local accounts at a real network.

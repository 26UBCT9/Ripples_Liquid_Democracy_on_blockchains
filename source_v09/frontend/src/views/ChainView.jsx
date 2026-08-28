import { useEffect, useState } from "react";
import { contracts, deployment, short, web3 } from "../lib/chain";
import { TOPICS } from "../topics";

/**
 * On-chain inspector: renders what actually lives on the chain, decoded.
 * Papers and ballots as raw events (block, tx hash, timestamp, arguments),
 * and per transaction the decoded calldata, including the unwrapped ERC-2771
 * meta transaction envelope and the Groth16 proof payload of anonymous votes.
 */

const ABIS = () => ({
  VoteController: deployment.abi.VoteController,
  Forwarder: deployment.abi.Forwarder,
  DelegationRegistry: deployment.abi.DelegationRegistry,
  CitizenRegistry: deployment.abi.CitizenRegistry,
  Semaphore: deployment.abi.Semaphore,
});

let SELECTORS = null;
function selectors() {
  if (SELECTORS) return SELECTORS;
  SELECTORS = {};
  for (const [contract, abi] of Object.entries(ABIS())) {
    for (const f of (abi || []).filter((x) => x.type === "function")) {
      try {
        SELECTORS[web3.eth.abi.encodeFunctionSignature(f)] = { contract, fn: f };
      } catch {}
    }
  }
  return SELECTORS;
}

function decodeCall(input) {
  if (!input || input.length < 10) return null;
  const hit = selectors()[input.slice(0, 10)];
  if (!hit) return { contract: "?", name: `unknown ${input.slice(0, 10)}`, args: {} };
  const call = { contract: hit.contract, name: hit.fn.name, args: {} };
  try {
    const decoded = web3.eth.abi.decodeParameters(hit.fn.inputs, "0x" + input.slice(10));
    for (const inp of hit.fn.inputs) call.args[inp.name] = decoded[inp.name];
  } catch {}
  // Unwrap the ERC-2771 envelope: the inner call plus the signing voter.
  if (call.name === "execute" && call.args.request) {
    call.signer = call.args.request.from;
    call.inner = decodeCall(call.args.request.data);
  }
  return call;
}

const trunc = (s, head = 10, tail = 6) => {
  s = String(s);
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
};

function fmtValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true (Yes)" : "false (No)";
  if (typeof v === "bigint") return trunc(v.toString(), 12, 8);
  if (Array.isArray(v)) return v.map((x) => fmtValue(x)).join(", ");
  if (typeof v === "object") return "(tuple)";
  const s = String(v);
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return short(s);
  if (s.startsWith("0x") && s.length > 20) return trunc(s, 12, 8);
  return trunc(s, 28, 8);
}

function ArgsTable({ args, skip = [] }) {
  const rows = Object.entries(args || {}).filter(([k]) => !skip.includes(k) && isNaN(Number(k)) && k !== "__length__");
  if (rows.length === 0) return null;
  return (
    <table className="chain-kv">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="chain-key">{k}</td>
            <td className="mono" title={typeof v === "object" ? "" : String(v)}>
              {fmtValue(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProofTable({ proof }) {
  if (!proof) return null;
  return (
    <div className="chain-proof">
      <span className="eyebrow">Groth16 proof (public signals + proof points)</span>
      <table className="chain-kv">
        <tbody>
          <tr><td className="chain-key">merkleTreeRoot</td><td className="mono">{trunc(proof.merkleTreeRoot, 14, 10)}</td></tr>
          <tr><td className="chain-key">nullifier</td><td className="mono">{trunc(proof.nullifier, 14, 10)}</td></tr>
          <tr><td className="chain-key">message</td><td className="mono">{String(proof.message)} {String(proof.message) === "1" ? "(Yes)" : String(proof.message) === "2" ? "(No)" : ""}</td></tr>
          <tr><td className="chain-key">scope</td><td className="mono">{trunc(proof.scope, 14, 10)}</td></tr>
          <tr><td className="chain-key">merkleTreeDepth</td><td className="mono">{String(proof.merkleTreeDepth)}</td></tr>
          {(proof.points || []).map((p, i) => (
            <tr key={i}><td className="chain-key">points[{i}]</td><td className="mono">{trunc(p, 14, 10)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TxDetail({ hash }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    (async () => {
      const [tx, receipt] = await Promise.all([web3.eth.getTransaction(hash), web3.eth.getTransactionReceipt(hash)]);
      setData({ tx, receipt, call: decodeCall(tx.input) });
    })();
  }, [hash]);
  if (!data) return <div className="chain-detail">loading transaction…</div>;
  const { tx, receipt, call } = data;
  const target = call?.inner || call;
  return (
    <div className="chain-detail">
      <table className="chain-kv">
        <tbody>
          <tr><td className="chain-key">tx hash</td><td className="mono">{hash}</td></tr>
          <tr><td className="chain-key">from (paid gas)</td><td className="mono">{tx.from} {tx.from?.toLowerCase() !== call?.signer?.toLowerCase() && call?.signer ? "(relayer)" : ""}</td></tr>
          <tr><td className="chain-key">to</td><td className="mono">{tx.to}</td></tr>
          <tr><td className="chain-key">gas used</td><td className="mono">{receipt.gasUsed.toString()}</td></tr>
          <tr><td className="chain-key">block</td><td className="mono">{tx.blockNumber?.toString()}</td></tr>
        </tbody>
      </table>
      {call && (
        <div className="chain-call">
          <span className="eyebrow">
            decoded call: {call.contract}.{call.name}()
          </span>
          <ArgsTable args={call.args} skip={call.name === "execute" ? ["request"] : ["proof"]} />
          {call.signer && (
            <div className="chain-envelope">
              <span className="eyebrow">
                meta transaction envelope · signed by voter {short(call.signer)} · executed by relayer
              </span>
              {call.inner && (
                <>
                  <span className="eyebrow">inner call: {call.inner.contract}.{call.inner.name}()</span>
                  <ArgsTable args={call.inner.args} />
                </>
              )}
            </div>
          )}
          {target?.name === "voteAnonymous" && <ProofTable proof={target.args.proof} />}
        </div>
      )}
    </div>
  );
}

export default function ChainView({ notify }) {
  const [papers, setPapers] = useState([]);
  const [openTx, setOpenTx] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { controller } = contracts();
        const from = deployment.deployBlock ?? 0;
        const opts = { fromBlock: from, toBlock: "latest" };
        const [pc, mc, pv, av, ar] = await Promise.all([
          controller.getPastEvents("PaperCreated", opts),
          controller.getPastEvents("MatterCreated", opts),
          controller.getPastEvents("PublicVote", opts),
          controller.getPastEvents("AnonymousVote", opts),
          controller.getPastEvents("AnonymousRegistered", opts),
        ]);

        const blockNos = [...new Set([...pc, ...mc, ...pv, ...av, ...ar].map((e) => Number(e.blockNumber)))];
        const times = {};
        await Promise.all(
          blockNos.map(async (n) => {
            const b = await web3.eth.getBlock(n);
            times[n] = Number(b.timestamp);
          })
        );
        const stamp = (e) => new Date(times[Number(e.blockNumber)] * 1000).toLocaleString();

        const matterPaper = {};
        const mattersByPaper = {};
        for (const e of mc) {
          const pid = e.returnValues.paperId.toString();
          matterPaper[e.returnValues.matterId.toString()] = pid;
          (mattersByPaper[pid] = mattersByPaper[pid] || []).push({
            matterId: e.returnValues.matterId.toString(),
            topicId: Number(e.returnValues.topicId),
            text: e.returnValues.text,
            block: Number(e.blockNumber),
            tx: e.transactionHash,
          });
        }

        const list = pc
          .map((e) => {
            const id = e.returnValues.paperId.toString();
            const ballots = [
              ...ar.filter((x) => x.returnValues.paperId.toString() === id).map((x) => ({
                kind: "REGISTERED ANONYMOUS",
                who: short(x.returnValues.voter),
                what: TOPICS[Number(x.returnValues.topicId)],
                block: Number(x.blockNumber), tx: x.transactionHash, time: stamp(x),
              })),
              ...pv.filter((x) => matterPaper[x.returnValues.matterId.toString()] === id).map((x) => ({
                kind: "PUBLIC VOTE",
                who: short(x.returnValues.voter),
                what: `matter ${x.returnValues.matterId} · ${x.returnValues.choice ? "Yes" : "No"} · weight ${x.returnValues.weightAdded}`,
                block: Number(x.blockNumber), tx: x.transactionHash, time: stamp(x),
              })),
              ...av.filter((x) => matterPaper[x.returnValues.matterId.toString()] === id).map((x) => ({
                kind: "ANONYMOUS VOTE",
                who: "—",
                what: `matter ${x.returnValues.matterId} · ${x.returnValues.choice ? "Yes" : "No"} · weight 1`,
                block: Number(x.blockNumber), tx: x.transactionHash, time: stamp(x),
              })),
            ].sort((a, b) => a.block - b.block);
            return {
              id,
              title: e.returnValues.title,
              snapshot: Number(e.returnValues.snapshot),
              votingEnd: Number(e.returnValues.votingEnd),
              block: Number(e.blockNumber),
              tx: e.transactionHash,
              time: stamp(e),
              matters: mattersByPaper[id] || [],
              ballots,
            };
          })
          .reverse();
        setPapers(list);
      } catch (e) {
        notify(`Could not load chain data: ${e.message}`, "err");
      }
    })();
  }, []);

  return (
    <div>
      <h2 className="rule">On-chain data</h2>
      <p className="hint">
        The raw chain truth, decoded: every paper and ballot as contract events with block, transaction and
        timestamp. Click a transaction to see its decoded calldata, including the ERC-2771 meta transaction envelope
        of gasless votes and the full Groth16 proof of anonymous ones.
      </p>
      {papers.length === 0 && <p className="notice">No papers on this chain yet.</p>}
      {papers.map((p) => (
        <article className="sheet" key={p.id}>
          <header className="sheet-head">
            <div>
              <span className="eyebrow">event PaperCreated · block {p.block} · {p.time}</span>
              <h3>Paper №{p.id}: {p.title}</h3>
              <div className="mono small chain-hash" onClick={() => setOpenTx(openTx === p.tx ? null : p.tx)}>
                tx {p.tx}
              </div>
            </div>
          </header>
          {openTx === p.tx && <TxDetail hash={p.tx} />}

          <table className="chain-table">
            <thead>
              <tr><th>matter</th><th>topic</th><th>text</th></tr>
            </thead>
            <tbody>
              {p.matters.map((m) => (
                <tr key={m.matterId}>
                  <td className="mono">{m.matterId}</td>
                  <td>{TOPICS[m.topicId]}</td>
                  <td>{m.text}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="chain-table">
            <thead>
              <tr><th>event</th><th>voter</th><th>data</th><th>block</th><th>transaction</th></tr>
            </thead>
            <tbody>
              {p.ballots.map((b) => (
                <tr key={b.tx + b.kind + b.what}>
                  <td><span className={`chain-badge ${b.kind === "ANONYMOUS VOTE" ? "chain-badge-anon" : ""}`}>{b.kind}</span></td>
                  <td className="mono">{b.who}</td>
                  <td>{b.what}</td>
                  <td className="mono">{b.block}</td>
                  <td className="mono chain-hash" onClick={() => setOpenTx(openTx === b.tx ? null : b.tx)}>
                    {trunc(b.tx, 12, 8)}
                  </td>
                </tr>
              ))}
              {p.ballots.length === 0 && (
                <tr><td colSpan="5" className="small">no ballots yet</td></tr>
              )}
            </tbody>
          </table>
          {openTx && p.ballots.some((b) => b.tx === openTx) && <TxDetail hash={openTx} />}
        </article>
      ))}
    </div>
  );
}

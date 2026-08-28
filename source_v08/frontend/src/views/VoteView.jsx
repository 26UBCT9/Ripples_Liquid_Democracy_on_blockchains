import { useEffect, useState } from "react";
import {
  contracts,
  deployment,
  loadAnonVote,
  sendGasless,
  short,
  storeAnonVote,
  web3,
} from "../lib/chain";
import { anonymitySetSize, getIdentity, voteAnonymousBallot } from "../lib/anonymous";
import { TOPICS } from "../topics";

export default function VoteView({ account, papers, refresh, notify, isCitizen }) {
  return (
    <div>
      <h2 className="rule">Voting papers</h2>
      {papers.length === 0 && <p className="notice">No voting papers yet.</p>}
      {papers.map((p) => (
        <Paper key={p.id} paper={p} account={account} notify={notify} refresh={refresh} />
      ))}
      <DelegationPanel account={account} notify={notify} refresh={refresh} isCitizen={isCitizen} />
    </div>
  );
}

function DelegationPanel({ account, notify, refresh, isCitizen }) {
  const [current, setCurrent] = useState({});
  const [inputs, setInputs] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { delegations } = contracts();
    const next = {};
    for (let t = 0; t < 8; t++) {
      next[t] = await delegations.methods.delegateOf(account, t).call();
    }
    setCurrent(next);
  };
  useEffect(() => {
    load();
  }, [account]);

  const change = async (topicId, clear) => {
    try {
      setBusy(true);
      const { delegations } = contracts();
      const data = clear
        ? delegations.methods.clearDelegate(topicId).encodeABI()
        : delegations.methods.setDelegate(topicId, inputs[topicId]).encodeABI();
      await sendGasless(deployment.delegationRegistry, data, 400000);
      notify(clear ? "Delegation cleared." : "Delegation set.", "ok");
      setInputs({ ...inputs, [topicId]: "" });
      await load();
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Standing delegations</h2>
      <p className="hint">
        One hop per topic, standing until you change it. Each paper counts the delegations exactly as they were when
        it was published; your own ballot always overrides. Changes are signed by you and relayed gas-free.
      </p>
      {!isCitizen && <p className="notice">This account holds no citizen token, so it cannot delegate or vote.</p>}
      <div className="topic-grid">
        {TOPICS.map((name, t) => {
          const zero = !current[t] || /^0x0+$/.test(current[t]);
          return (
            <div className="topic-row" key={t}>
              <div>
                <span className="eyebrow">Topic {t}</span>
                <strong>{name}</strong>
                <div className="mono small">{zero ? "no delegate" : `→ ${short(current[t])}`}</div>
              </div>
              <div className="topic-actions">
                <input
                  className="mono"
                  placeholder="0x… delegate"
                  value={inputs[t] || ""}
                  onChange={(e) => setInputs({ ...inputs, [t]: e.target.value })}
                  disabled={!isCitizen || busy}
                />
                <button
                  className="btn"
                  disabled={!isCitizen || busy || !web3.utils.isAddress(inputs[t] || "")}
                  onClick={() => change(t, false)}
                >
                  Set
                </button>
                <button className="btn" disabled={!isCitizen || busy || zero} onClick={() => change(t, true)}>
                  Clear
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Countdown({ paper }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (paper.phase !== 0) return null;
  const s = Math.max(0, paper.votingEnd - Math.floor(Date.now() / 1000));
  const fmt = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  return (
    <span className="mono small">
      voting closes in {fmt}
    </span>
  );
}

function Paper({ paper, account, notify, refresh }) {
  // Delegation status per topic, as it counts for THIS paper (at its snapshot).
  const [dlg, setDlg] = useState({});

  useEffect(() => {
    (async () => {
      const { delegations } = contracts();
      const next = {};
      for (const t of [...new Set(paper.matters.map((m) => m.topicId))]) {
        const [atSnapshot, current, inbound] = await Promise.all([
          delegations.methods.getPastDelegate(account, t, paper.snapshot).call(),
          delegations.methods.delegateOf(account, t).call(),
          delegations.methods.getPastInboundWeight(account, t, paper.snapshot).call(),
        ]);
        const none = (a) => !a || /^0x0+$/.test(a);
        next[t] = {
          out: none(atSnapshot) ? null : atSnapshot,
          outNow: none(current) ? null : current,
          inbound: Number(inbound),
        };
      }
      setDlg(next);
    })();
  }, [paper.id, paper.snapshot, account]);

  return (
    <article className="sheet">
      <header className="sheet-head">
        <div>
          <span className="eyebrow">Paper №{paper.id}</span>
          <h3>{paper.title}</h3>
        </div>
        <div className="sheet-meta">
          <span className={`phase phase-${paper.phase}`}>{paper.phaseName}</span>
          <Countdown paper={paper} />
        </div>
      </header>

      {paper.phase === 0 && <AnonymityRow paper={paper} account={account} notify={notify} refresh={refresh} />}

      {paper.matters.map((m) => (
        <Matter
          key={m.id}
          paper={paper}
          matter={m}
          account={account}
          notify={notify}
          refresh={refresh}
          dlg={dlg[m.topicId]}
        />
      ))}
    </article>
  );
}

function DelegationNote({ dlg }) {
  if (!dlg) return null;
  const notes = [];
  if (dlg.out) {
    notes.push(
      <span key="out" className="dlg-note">
        Topic delegated to <span className="mono">{short(dlg.out)}</span> for this paper · your own vote overrides it
      </span>
    );
    if (dlg.outNow && dlg.outNow.toLowerCase() !== dlg.out.toLowerCase()) {
      notes.push(
        <span key="change" className="dlg-note dlg-muted">
          Change to <span className="mono">{short(dlg.outNow)}</span> counts from the next paper
        </span>
      );
    }
    if (!dlg.outNow) {
      notes.push(
        <span key="cleared" className="dlg-note dlg-muted">
          Cleared in the meantime · the clearing counts from the next paper
        </span>
      );
    }
  } else if (dlg.outNow) {
    notes.push(
      <span key="late" className="dlg-note dlg-muted">
        Delegation to <span className="mono">{short(dlg.outNow)}</span> was set after this paper was published · it
        counts from the next paper, so vote here yourself
      </span>
    );
  }
  if (dlg.inbound > 0) {
    notes.push(
      <span key="in" className="dlg-note dlg-carry">
        You carry {dlg.inbound} delegated vote{dlg.inbound > 1 ? "s" : ""} on this topic · your ballot counts{" "}
        {dlg.inbound + 1}x (minus overrides)
      </span>
    );
  }
  if (notes.length === 0) return null;
  return <div className="dlg-notes">{notes}</div>;
}

function AnonymityRow({ paper, account, notify, refresh }) {
  const topics = [...new Set(paper.matters.map((m) => m.topicId))];
  const [status, setStatus] = useState({});
  const [sizes, setSizes] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { controller } = contracts();
    const nextStatus = {};
    const nextSizes = {};
    for (const t of topics) {
      nextStatus[t] = await controller.methods.anonMode(paper.id, t, account).call();
      nextSizes[t] = await anonymitySetSize(paper.id, t);
    }
    setStatus(nextStatus);
    setSizes(nextSizes);
  };
  useEffect(() => {
    load();
  }, [paper.id, account]);

  return (
    <div className="register">
      <strong>Vote anonymously instead?</strong>
      <p className="hint">
        Per topic, any time while voting is open, if you neither delegated the topic nor receive delegations for it,
        and have not yet voted publicly on it. Your identity comes from one signature (kept in this browser); only its
        commitment goes on-chain. Anonymous ballots have weight 1.
      </p>
      {topics.map((t) => (
        <div className="row" key={t}>
          <button
            className="btn"
            disabled={status[t] || busy}
            onClick={async () => {
              try {
                setBusy(true);
                const identity = await getIdentity(account);
                const { controller } = contracts();
                const data = controller.methods
                  .registerAnonymous(paper.id, t, identity.commitment.toString())
                  .encodeABI();
                await sendGasless(deployment.voteController, data, 900000);
                notify(`Anonymous mode active for "${TOPICS[t]}".`, "ok");
                await load();
                refresh();
              } catch (e) {
                notify(e.message, "err");
              } finally {
                setBusy(false);
              }
            }}
          >
            {status[t] ? `Anonymous: ${TOPICS[t]}` : `Go anonymous: ${TOPICS[t]}`}
          </button>
          {sizes[t] !== null && sizes[t] !== undefined && (
            <span className={`small ${sizes[t] < 20 ? "rejected" : ""}`}>
              anonymity set: {sizes[t]}
              {sizes[t] < 20 ? " (small - limited anonymity)" : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Matter({ paper, matter, account, notify, refresh, dlg }) {
  const [voted, setVoted] = useState(false);
  const [anon, setAnon] = useState(false);
  const [anonVote, setAnonVote] = useState(() => loadAnonVote(account, matter.id));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAnonVote(loadAnonVote(account, matter.id));
    (async () => {
      const { controller } = contracts();
      setVoted(await controller.methods.publicVoted(matter.id, account).call());
      setAnon(await controller.methods.anonMode(paper.id, matter.topicId, account).call());
    })();
  }, [matter.id, account, paper.phase]);

  const vote = async (choice) => {
    try {
      setBusy(true);
      const { controller } = contracts();
      const data = controller.methods.votePublic(matter.id, choice).encodeABI();
      await sendGasless(deployment.voteController, data, 500000);
      setVoted(true);
      notify("Vote cast and tallied.", "ok");
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  const voteAnon = async (choice) => {
    try {
      setBusy(true);
      notify("Generating the zero-knowledge proof - this can take a few seconds…");
      await voteAnonymousBallot(account, paper.id, matter.topicId, matter.id, choice);
      storeAnonVote(account, matter.id, choice);
      setAnonVote({ choice });
      notify("Anonymous vote cast via relayer and tallied.", "ok");
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  const openAndUnvoted = paper.phase === 0 && ((anon && !anonVote) || (!anon && !voted));

  return (
    <div className="ballot">
      <div className="ballot-q">
        <span className="eyebrow">{TOPICS[matter.topicId]}</span>
        <p className="question">{matter.text}</p>
        <span className="mono small">Matter №{matter.id}{anon ? " · anonymous mode" : ""}</span>
        <DelegationNote dlg={dlg} />
      </div>
      <div className="ballot-a">
        {openAndUnvoted && (
          <div className="janein">
            <button className="btn-vote" disabled={busy} onClick={() => (anon ? voteAnon(true) : vote(true))}>
              Yes
            </button>
            <button className="btn-vote" disabled={busy} onClick={() => (anon ? voteAnon(false) : vote(false))}>
              No
            </button>
          </div>
        )}
        {paper.phase === 0 && !anon && voted && <span className="stamp stamp-ok">VOTED</span>}
        {paper.phase === 0 && anon && anonVote && (
          <span className="stamp stamp-ok">ANONYMOUS · VOTED · {anonVote.choice ? "YES" : "NO"}</span>
        )}
        {paper.phase >= 1 && <span className="stamp stamp-wait">CLOSED</span>}
      </div>
    </div>
  );
}

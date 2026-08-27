import { useEffect, useState } from "react";
import {
  anonCommitment,
  contracts,
  deployment,
  loadAnonBallot,
  loadBallot,
  publicCommitment,
  randomSalt,
  sendGasless,
  short,
  storeAnonBallot,
  storeBallot,
  web3,
} from "../lib/chain";
import {
  anonymitySetSize,
  commitAnonymousBallot,
  findAnonIndex,
  getIdentity,
  revealAnonymousBallot,
} from "../lib/anonymous";
import { TOPICS } from "../topics";

export default function VoteView({ account, papers, refresh, notify, isCitizen }) {
  return (
    <div>
      <DelegationPanel account={account} notify={notify} refresh={refresh} isCitizen={isCitizen} />
      <h2 className="rule">Voting papers</h2>
      {papers.length === 0 && <p className="notice">No voting papers yet.</p>}
      {papers.map((p) => (
        <Paper key={p.id} paper={p} account={account} notify={notify} refresh={refresh} />
      ))}
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
  const now = Math.floor(Date.now() / 1000);
  const next =
    paper.phase === 0
      ? ["voting closes", paper.votingEnd]
      : paper.phase === 1
        ? ["evaluation closes", paper.revealEnd]
        : null;
  if (!next) return null;
  const s = Math.max(0, next[1] - now);
  const fmt = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  return (
    <span className="mono small">
      {next[0]} in {fmt}
    </span>
  );
}

function Paper({ paper, account, notify, refresh }) {
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
        <Matter key={m.id} paper={paper} matter={m} account={account} notify={notify} refresh={refresh} />
      ))}
    </article>
  );
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

function Matter({ paper, matter, account, notify, refresh }) {
  const [stored, setStored] = useState(() => loadBallot(account, matter.id));
  const [anonStored, setAnonStored] = useState(() => loadAnonBallot(account, matter.id));
  const [committed, setCommitted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [anonRevealed, setAnonRevealed] = useState(false);
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStored(loadBallot(account, matter.id));
    const a = loadAnonBallot(account, matter.id);
    setAnonStored(a);
    (async () => {
      const { controller } = contracts();
      const c = await controller.methods.publicCommitOf(matter.id, account).call();
      setCommitted(!/^0x0+$/.test(c));
      setRevealed(await controller.methods.publicRevealed(matter.id, account).call());
      setAnon(await controller.methods.anonMode(paper.id, matter.topicId, account).call());
      if (a?.index !== undefined && a?.index !== null) {
        setAnonRevealed(await controller.methods.anonRevealed(matter.id, a.index).call());
      }
    })();
  }, [matter.id, account, paper.phase]);

  const commit = async (choice) => {
    try {
      setBusy(true);
      const salt = randomSalt();
      const commitment = publicCommitment(matter.id, account, choice, salt);
      const { controller } = contracts();
      const data = controller.methods.commitPublic(matter.id, commitment).encodeABI();
      await sendGasless(deployment.voteController, data, 500000);
      storeBallot(account, matter.id, { choice, salt });
      setStored({ choice, salt });
      setCommitted(true);
      notify("Ballot cast. It stays sealed until the voting window closes; keep this browser for the reveal.", "ok");
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  const commitAnon = async (choice) => {
    try {
      setBusy(true);
      notify("Generating the zero-knowledge proof - this can take a few seconds…");
      const salt = randomSalt();
      const commitment = anonCommitment(matter.id, choice, salt);
      const { index } = await commitAnonymousBallot(account, paper.id, matter.topicId, matter.id, commitment);
      storeAnonBallot(account, matter.id, { choice, salt, index });
      setAnonStored({ choice, salt, index });
      notify("Anonymous ballot cast via relayer. Keep this browser for the reveal.", "ok");
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    try {
      setBusy(true);
      const { controller } = contracts();
      const data = controller.methods.revealPublic(matter.id, stored.choice, stored.salt).encodeABI();
      await sendGasless(deployment.voteController, data, 700000);
      setRevealed(true);
      notify("Ballot revealed and tallied.", "ok");
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  const revealAnon = async () => {
    try {
      setBusy(true);
      let { index } = anonStored;
      if (index === undefined || index === null) {
        index = await findAnonIndex(matter.id, anonCommitment(matter.id, anonStored.choice, anonStored.salt));
        if (index === null) throw new Error("Ballot not found on-chain.");
      }
      await revealAnonymousBallot(matter.id, index, anonStored.choice, anonStored.salt);
      setAnonRevealed(true);
      notify("Anonymous ballot revealed and tallied.", "ok");
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ballot">
      <div className="ballot-q">
        <span className="eyebrow">{TOPICS[matter.topicId]}</span>
        <p className="question">{matter.text}</p>
        <span className="mono small">Matter №{matter.id}{anon ? " · anonymous mode" : ""}</span>
      </div>
      <div className="ballot-a">
        {paper.phase === 0 && !anon && !committed && (
          <div className="janein">
            <button className="btn-vote" disabled={busy} onClick={() => commit(true)}>
              Yes
            </button>
            <button className="btn-vote" disabled={busy} onClick={() => commit(false)}>
              No
            </button>
          </div>
        )}
        {paper.phase === 0 && !anon && committed && (
          <span className="stamp">SEALED{stored ? ` · ${stored.choice ? "YES" : "NO"}` : ""}</span>
        )}

        {paper.phase === 0 && anon && !anonStored && (
          <div className="janein">
            <button className="btn-vote" disabled={busy} onClick={() => commitAnon(true)}>
              Yes
            </button>
            <button className="btn-vote" disabled={busy} onClick={() => commitAnon(false)}>
              No
            </button>
          </div>
        )}
        {paper.phase === 0 && anon && anonStored && (
          <span className="stamp">ANONYMOUS · SEALED · {anonStored.choice ? "YES" : "NO"}</span>
        )}

        {paper.phase === 1 && !anon && committed && !revealed && (
          stored ? (
            <button className="btn btn-primary" disabled={busy} onClick={reveal}>
              Reveal {stored.choice ? "Yes" : "No"}
            </button>
          ) : (
            <span className="stamp stamp-wait">SALT NOT IN THIS BROWSER</span>
          )
        )}
        {paper.phase === 1 && !anon && revealed && <span className="stamp stamp-ok">REVEALED</span>}
        {paper.phase === 1 && !anon && !committed && <span className="stamp stamp-wait">NO BALLOT</span>}

        {paper.phase === 1 && anon && anonStored && !anonRevealed && (
          <button className="btn btn-primary" disabled={busy} onClick={revealAnon}>
            Reveal anonymous {anonStored.choice ? "Yes" : "No"}
          </button>
        )}
        {paper.phase === 1 && anon && anonRevealed && <span className="stamp stamp-ok">REVEALED</span>}
        {paper.phase === 1 && anon && !anonStored && <span className="stamp stamp-wait">NO ANONYMOUS BALLOT HERE</span>}

        {paper.phase >= 2 && <span className="stamp stamp-wait">CLOSED</span>}
      </div>
    </div>
  );
}

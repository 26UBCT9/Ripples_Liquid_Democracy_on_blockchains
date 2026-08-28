import { useState } from "react";
import { contracts, deployment, sendTx } from "../lib/chain";
import { TOPICS } from "../topics";

const toTs = (s) => Math.floor(new Date(s).getTime() / 1000);
const plus = (min) => {
  const d = new Date(Date.now() + min * 60000);
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function PaperAdmin({ notify, refresh }) {
  const [title, setTitle] = useState("");
  const [deadlines, setDeadlines] = useState({
    votingEnd: plus(10),
  });
  const [matters, setMatters] = useState([{ topicId: 0, text: "" }]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    try {
      setBusy(true);
      const { controller } = contracts();
      const data = controller.methods
        .createPaper(title, toTs(deadlines.votingEnd), matters.map((m) => [m.topicId, m.text]))
        .encodeABI();
      await sendTx(deployment.voteController, data);
      notify("Voting paper published.", "ok");
      setTitle("");
      setMatters([{ topicId: 0, text: "" }]);
      refresh();
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Publish a voting paper</h2>
      <p className="hint">
        Government action (CREATOR_ROLE), paid by the government wallet. The paper is live and open for voting the
        moment it is published, results are visible live, and the tally is final once the voting window closes.
        Standing delegations are snapshotted at publication.
      </p>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Volksabstimmung 2026-3" />
      </label>
      <div className="deadline-grid">
        {[["votingEnd", "Voting closes"]].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="datetime-local"
              value={deadlines[key]}
              onChange={(e) => setDeadlines({ ...deadlines, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <h3 className="rule">Matters</h3>
      {matters.map((m, i) => (
        <div className="matter-row" key={i}>
          <select value={m.topicId} onChange={(e) => update(i, { topicId: Number(e.target.value) })}>
            {TOPICS.map((t, idx) => (
              <option key={idx} value={idx}>
                {idx} · {t}
              </option>
            ))}
          </select>
          <input
            value={m.text}
            placeholder="Question, answerable with yes or no"
            onChange={(e) => update(i, { text: e.target.value })}
          />
          <button className="btn" onClick={() => setMatters(matters.filter((_, j) => j !== i))} disabled={matters.length === 1}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => setMatters([...matters, { topicId: 0, text: "" }])}>
          Add matter
        </button>
        <button className="btn btn-primary" disabled={busy || !title || matters.some((m) => !m.text)} onClick={create}>
          Publish paper
        </button>
      </div>
    </section>
  );

  function update(i, patch) {
    setMatters(matters.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }
}

import { contracts, deployment, sendTx } from "../lib/chain";
import { TOPICS } from "../topics";

export default function ResultsView({ papers, notify, refresh }) {
  return (
    <div>
      <h2 className="rule">Results</h2>
      <p className="hint">
        Every ballot stays sealed while voting is open. Once the voting window closes, the evaluation begins: each
        reveal updates the tally live, and unrevealed ballots count as abstentions.
      </p>
      {papers.map((p) => (
        <article className="sheet" key={p.id}>
          <header className="sheet-head">
            <div>
              <span className="eyebrow">Paper №{p.id}</span>
              <h3>{p.title}</h3>
            </div>
            <div className="sheet-meta">
              <span className={`phase phase-${p.phase}`}>{p.phaseName}</span>
              {p.phase === 2 && !p.finalized && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      const { controller } = contracts();
                      await sendTx(deployment.voteController, controller.methods.finalize(p.id).encodeABI());
                      notify("Paper finalized.", "ok");
                      refresh();
                    } catch (e) {
                      notify(e.message, "err");
                    }
                  }}
                >
                  Finalize
                </button>
              )}
              {p.finalized && <span className="stamp stamp-ok">FINAL</span>}
            </div>
          </header>
          {p.matters.map((m) => {
            const yes = Number(m.yes);
            const no = Number(m.no);
            const total = yes + no;
            const hidden = p.phase < 1;
            return (
              <div className="ballot" key={m.id}>
                <div className="ballot-q">
                  <span className="eyebrow">{TOPICS[m.topicId]}</span>
                  <p className="question">{m.text}</p>
                </div>
                <div className="ballot-a result">
                  {hidden ? (
                    <span className="stamp stamp-wait">SEALED UNTIL REVEAL</span>
                  ) : (
                    <>
                      <div className="bar">
                        <div className="bar-yes" style={{ width: total ? `${(yes / total) * 100}%` : "0%" }} />
                      </div>
                      <div className="counts mono">
                        <span>Yes {yes}</span>
                        <span className={total && yes > no ? "accepted" : total && no > yes ? "rejected" : ""}>
                          {total === 0 ? "no reveals yet" : yes > no ? "ACCEPTED" : no > yes ? "REJECTED" : "TIED"}
                        </span>
                        <span>No {no}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </article>
      ))}
    </div>
  );
}

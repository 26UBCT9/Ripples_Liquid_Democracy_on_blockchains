import { useEffect, useState } from "react";
import { contracts, demoAccounts, deployment, sendTx, short, web3 } from "../lib/chain";

export default function CitizenAdmin({ notify, refresh }) {
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [roster, setRoster] = useState([]);

  const loadRoster = async () => {
    const { citizens } = contracts();
    const list = await Promise.all(
      demoAccounts()
        .filter((a) => a.id !== "government")
        .map(async (a) => ({ ...a, citizen: await citizens.methods.isCitizen(a.address).call() }))
    );
    setRoster(list);
  };
  useEffect(() => {
    loadRoster();
  }, []);

  const act = async (method, target) => {
    try {
      setBusy(true);
      const { citizens } = contracts();
      await sendTx(deployment.citizenRegistry, citizens.methods[method](target).encodeABI());
      notify(method === "issue" ? `Voting right issued to ${short(target)}.` : `Voting right revoked from ${short(target)}.`, "ok");
      await loadRoster();
      refresh();
      if (target === address) setStatus(await citizens.methods.isCitizen(address).call());
    } catch (e) {
      notify(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <section className="panel">
        <h2>Demo voters</h2>
        <p className="hint">
          Government action (ISSUER_ROLE). One soulbound token per citizen establishes the vote; issuance stands in
          for the civil register. The token never transfers.
        </p>
        <div className="topic-grid">
          {roster.map((a) => (
            <div className="topic-row" key={a.id}>
              <div>
                <strong>{a.label}</strong>
                <div className="mono small">{a.address}</div>
              </div>
              <div className="topic-actions">
                <span className={`chip ${a.citizen ? "chip-ok" : ""}`}>{a.citizen ? "CITIZEN" : "NO RIGHT"}</span>
                {a.citizen ? (
                  <button className="btn" disabled={busy} onClick={() => act("revoke", a.address)}>
                    Revoke
                  </button>
                ) : (
                  <button className="btn btn-primary" disabled={busy} onClick={() => act("issue", a.address)}>
                    Issue voting right
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Any address</h2>
        <label>
          Citizen address
          <input className="mono" value={address} placeholder="0x…" onChange={(e) => setAddress(e.target.value)} />
        </label>
        <div className="row">
          <button
            className="btn"
            disabled={!web3.utils.isAddress(address)}
            onClick={async () => setStatus(await contracts().citizens.methods.isCitizen(address).call())}
          >
            Check
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !web3.utils.isAddress(address)}
            onClick={() => act("issue", address)}
          >
            Issue voting right
          </button>
          <button className="btn" disabled={busy || !web3.utils.isAddress(address)} onClick={() => act("revoke", address)}>
            Revoke
          </button>
          {status !== null && (
            <span className={`chip ${status ? "chip-ok" : ""}`}>{status ? "CITIZEN" : "NOT A CITIZEN"}</span>
          )}
        </div>
      </section>
    </div>
  );
}

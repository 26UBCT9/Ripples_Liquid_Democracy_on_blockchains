import { useCallback, useEffect, useState } from "react";
import {
  contracts,
  demoAccounts,
  deployment,
  getSession,
  injected,
  injectedChainId,
  isDeployed,
  short,
  useLocalAccount,
  useMetaMask,
  web3,
} from "./lib/chain";
import { PHASES } from "./topics";
import VoteView from "./views/VoteView";
import ResultsView from "./views/ResultsView";
import PaperAdmin from "./views/PaperAdmin";
import CitizenAdmin from "./views/CitizenAdmin";

const CREATOR_ROLE = web3.utils.keccak256("CREATOR_ROLE");
const ISSUER_ROLE = web3.utils.keccak256("ISSUER_ROLE");

export default function App() {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState("results");
  const [roles, setRoles] = useState({ citizen: false, creator: false, issuer: false });
  const [papers, setPapers] = useState([]);
  const [flash, setFlash] = useState(null);
  const [mmChainOk, setMmChainOk] = useState(true);
  const account = session?.address || null;

  const notify = (text, kind = "info") => {
    setFlash({ text, kind });
    setTimeout(() => setFlash(null), 6000);
  };

  const refresh = useCallback(async () => {
    if (!account || !isDeployed) return;
    try {
      const { controller, citizens } = contracts();
      const [citizen, creator, issuer] = await Promise.all([
        citizens.methods.isCitizen(account).call(),
        controller.methods.hasRole(CREATOR_ROLE, account).call(),
        citizens.methods.hasRole(ISSUER_ROLE, account).call(),
      ]);
      setRoles({ citizen, creator, issuer });

      const count = Number(await controller.methods.paperCount().call());
      const list = [];
      for (let id = count; id >= 1 && list.length < 20; id--) {
        const p = await controller.methods.getPaper(id).call();
        const phase = Number(await controller.methods.phaseOf(id).call());
        const matters = await Promise.all(
          p.matterIds.map(async (mid) => {
            const m = await controller.methods.getMatter(mid).call();
            return {
              id: mid.toString(),
              topicId: Number(m.topicId),
              text: m.text,
              yes: m.yes.toString(),
              no: m.no.toString(),
            };
          })
        );
        list.push({
          id,
          title: p.title,
          phase,
          phaseName: PHASES[phase],
          votingEnd: Number(p.votingEnd),
          revealEnd: Number(p.revealEnd),
          finalized: p.finalized,
          matters,
        });
      }
      setPapers(list);
    } catch (e) {
      console.error("refresh failed", e);
    }
  }, [account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  // Tabs follow the on-chain roles of the active account.
  const tabs = [
    roles.citizen && { key: "vote", label: "Vote" },
    { key: "results", label: "Results" },
    roles.creator && { key: "papers", label: "Paper administration" },
    roles.issuer && { key: "citizens", label: "Citizen administration" },
  ].filter(Boolean);

  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab(tabs[0]?.key || "results");
  }, [roles.citizen, roles.creator, roles.issuer]); // eslint-disable-line react-hooks/exhaustive-deps

  // MetaMask sessions: track account switches and the selected network.
  useEffect(() => {
    if (!injected || session?.type !== "metamask") {
      setMmChainOk(true);
      return;
    }
    const checkChain = async () => setMmChainOk((await injectedChainId()) === deployment.chainId);
    const onAccounts = (a) => a[0] && setSession({ ...getSession(), address: a[0] });
    checkChain();
    injected.on?.("accountsChanged", onAccounts);
    injected.on?.("chainChanged", checkChain);
    return () => {
      injected.removeListener?.("accountsChanged", onAccounts);
      injected.removeListener?.("chainChanged", checkChain);
    };
  }, [session?.type]);

  if (!isDeployed) {
    return (
      <Shell>
        <p className="notice">
          No deployment found. Run <code>npm run deploy:local</code> (or <code>deploy:sepolia</code>) in the repo
          root, then rebuild the frontend.
        </p>
      </Shell>
    );
  }

  const viewProps = { account, session, papers, refresh, notify, isCitizen: roles.citizen };

  return (
    <Shell
      right={
        <AccountSwitcher
          session={session}
          roles={roles}
          onPick={async (choice) => {
            try {
              setRoles({ citizen: false, creator: false, issuer: false });
              setSession(choice === "metamask" ? await useMetaMask() : useLocalAccount(choice));
            } catch (e) {
              notify(e.message, "err");
            }
          }}
        />
      }
    >
      {account && (
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "tab-active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {flash && <div className={`flash flash-${flash.kind}`}>{flash.text}</div>}
      {session?.type === "metamask" && !mmChainOk && (
        <p className="notice">
          MetaMask is on the wrong network. Switch it to chain id {deployment.chainId} ({deployment.network}).
        </p>
      )}
      {!account ? (
        <p className="notice">
          Pick an account above to start. The demo accounts need no wallet extension: Government publishes papers and
          issues voting rights, the voters delegate and vote. Every voter action is signed locally and relayed
          gas-free; the fresh voter holds 0 ETH to prove it.
        </p>
      ) : (
        <main>
          {!roles.citizen && !roles.creator && !roles.issuer && (
            <p className="notice">
              This account has no voting right yet. The government can issue one in Citizen administration to:{" "}
              <span className="mono">{account}</span>
            </p>
          )}
          {tab === "vote" && roles.citizen && <VoteView {...viewProps} />}
          {tab === "results" && <ResultsView {...viewProps} />}
          {tab === "papers" && roles.creator && <PaperAdmin {...viewProps} />}
          {tab === "citizens" && roles.issuer && <CitizenAdmin {...viewProps} />}
        </main>
      )}
      <footer className="foot">
        <span>Network: {deployment.network} · chain {deployment.chainId}</span>
        <span className="mono">controller {short(deployment.voteController)}</span>
      </footer>
    </Shell>
  );
}

function AccountSwitcher({ session, roles, onPick }) {
  const accounts = demoAccounts();
  const current = accounts.find((a) => a.address === session?.address);
  const roleLabel = roles.creator || roles.issuer ? "GOVERNMENT" : roles.citizen ? "CITIZEN" : "NO VOTING RIGHT";
  return (
    <div className="wallet">
      {session && <span className={`chip ${roles.citizen || roles.creator || roles.issuer ? "chip-ok" : ""}`}>{roleLabel}</span>}
      <select
        className="switcher"
        value={session?.type === "metamask" ? "metamask" : current?.id || ""}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onPick(v === "metamask" ? "metamask" : accounts.find((a) => a.id === v));
        }}
      >
        <option value="" disabled>
          Pick an account…
        </option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label} · {short(a.address)} ({a.note})
          </option>
        ))}
        {injected && <option value="metamask">MetaMask…</option>}
      </select>
    </div>
  );
}

function Shell({ children, right }) {
  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            Liquid<span className="accent">Vote</span>
          </h1>
          <p className="subtitle">Direct democracy with per-topic delegation, on Ethereum</p>
        </div>
        {right}
      </header>
      {children}
    </div>
  );
}

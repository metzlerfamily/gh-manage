import { useEffect, useState } from "react";
import { hasRole } from "../core/policy";
import { CONFIG_REPO, token } from "./api";
import { Apps } from "./Apps";
import { completeCreation, manifestCallback, type Step } from "./creation";
import { OptIn } from "./OptIn";
import { RequestForm } from "./RequestForm";
import { Requests } from "./Requests";
import { SignIn } from "./SignIn";
import { Status } from "./Status";
import { useAppData } from "./useAppData";

const TABS = { apps: "Apps", requests: "Requests", new: "Request an app", optin: "Enable on repos", status: "Status" } as const;
type Tab = keyof typeof TABS;

const tabFromHash = (): Tab => {
  const t = location.hash.replace(/^#\//, "") as Tab;
  return t in TABS ? t : "apps";
};

export function App() {
  const [signedIn, setSignedIn] = useState(() => !!token.get());
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const { data, error } = useAppData(signedIn);
  const [creation, setCreation] = useState<{ steps: Step[]; error?: string; done?: boolean } | null>(null);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const callback = manifestCallback();
    if (!callback || !data || creation) return;
    setCreation({ steps: [] });
    completeCreation(callback.code, callback.state, data.user.login, data.config.settings, (steps) => setCreation({ steps }))
      .then(() => setCreation((c) => ({ steps: c?.steps ?? [], done: true })))
      .catch((e: Error) => setCreation((c) => ({ steps: c?.steps ?? [], error: e.message })));
  }, [data, creation]);

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  if (error)
    return (
      <main className="narrow">
        <p className="error">{error}</p>
        <button
          onClick={() => {
            token.clear();
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </main>
    );
  if (!data) return <main className="narrow muted">Loading {CONFIG_REPO}…</main>;

  const pendingReviews = data.pulls.filter((p) => p.user.login !== data.user.login).length;
  const role = hasRole(data.user.login, "manager", data.config.settings) ? "manager" : hasRole(data.user.login, "admin", data.config.settings) ? "admin" : "requester";

  return (
    <>
      <header className="top">
        <strong>gh-manage</strong>
        <nav>
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <a key={t} href={`#/${t}`} className={t === tab ? "active" : ""}>
              {TABS[t]}
              {t === "requests" && pendingReviews > 0 && <span className="count">{pendingReviews}</span>}
            </a>
          ))}
        </nav>
        <span className="user">
          <img src={data.user.avatar_url} alt="" width={20} height={20} />
          {data.user.login} <span className="muted small">({role})</span>
          <button
            className="link"
            onClick={() => {
              token.clear();
              setSignedIn(false);
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main>
        {data.problems.length > 0 && (
          <div className="card warn">
            <strong>The configuration on the default branch has problems</strong>
            <ul>
              {data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {creation && (
          <div className={`card ${creation.error ? "warn" : "ok"}`}>
            <strong>{creation.error ? "App creation stopped" : creation.done ? "App created" : "Creating the app…"}</strong>
            <ol>
              {creation.steps.map((s) => (
                <li key={s.label}>
                  {s.label}
                  {s.detail && <div className="muted small">{s.detail}</div>}
                </li>
              ))}
            </ol>
            {creation.error && <p className="error">{creation.error}</p>}
          </div>
        )}
        {tab === "apps" && <Apps data={data} />}
        {tab === "requests" && <Requests data={data} />}
        {tab === "new" && <RequestForm data={data} onDone={() => (location.hash = "#/requests")} />}
        {tab === "optin" && <OptIn data={data} />}
        {tab === "status" && <Status data={data} />}
      </main>
    </>
  );
}

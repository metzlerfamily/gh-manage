import { useEffect, useState } from "react";
import { appKeyFromPath } from "../core/config";
import { evaluatePr, type PrEvaluation } from "../core/review";
import type { AppSpec } from "../core/schema";
import { loadConfig } from "../core/config";
import { CONFIG_REPO, defaultBranchSha, describeError, filesAt, gh, type PullRequest } from "./api";
import { Permissions } from "./Permissions";
import type { AppData } from "./useAppData";

interface PrView {
  pr: PullRequest;
  evaluation: PrEvaluation;
  apps: { key: string; spec?: AppSpec }[];
}

async function loadPr(pr: PullRequest, base: Record<string, string>): Promise<PrView> {
  const [files, reviews, head] = await Promise.all([
    gh.paginate<{ filename: string; previous_filename?: string }>(`/repos/${CONFIG_REPO}/pulls/${pr.number}/files`),
    gh.paginate<{ user: { login: string }; state: string; commit_id: string }>(`/repos/${CONFIG_REPO}/pulls/${pr.number}/reviews`),
    filesAt(pr.head.sha),
  ]);
  const changedPaths = files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  const evaluation = evaluatePr({
    author: pr.user.login,
    headSha: pr.head.sha,
    baseFiles: base,
    headFiles: head,
    changedPaths,
    reviews: reviews.map((r) => ({ login: r.user.login, state: r.state, commit_id: r.commit_id })),
  });
  const headApps = loadConfig(head).config?.apps ?? {};
  const apps = changedPaths
    .map(appKeyFromPath)
    .filter((k): k is string => !!k)
    .map((key) => ({ key, spec: headApps[key] }));
  return { pr, evaluation, apps };
}

export function Requests({ data }: { data: AppData }) {
  const [views, setViews] = useState<PrView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const base = await filesAt((await defaultBranchSha()).sha);
        const loaded = await Promise.all(data.pulls.map((pr) => loadPr(pr, base)));
        if (live) setViews(loaded.filter((v) => v.evaluation.requirements.length || v.evaluation.problems.length));
      } catch (e) {
        if (live) setError(describeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [data.pulls]);

  async function review(pr: PullRequest, event: "APPROVE" | "REQUEST_CHANGES") {
    const body = event === "REQUEST_CHANGES" ? prompt("What needs to change?") : "Approved in gh-manage";
    if (body === null) return;
    setBusy(pr.number);
    try {
      await gh.json("POST", `/repos/${CONFIG_REPO}/pulls/${pr.number}/reviews`, { body: { event, body, commit_id: pr.head.sha } });
      await data.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function merge(pr: PullRequest) {
    setBusy(pr.number);
    try {
      await gh.json("PUT", `/repos/${CONFIG_REPO}/pulls/${pr.number}/merge`, { body: { merge_method: "squash", sha: pr.head.sha } });
      if (pr.head.repo?.full_name.toLowerCase() === CONFIG_REPO.toLowerCase())
        await gh.raw("DELETE", `/repos/${CONFIG_REPO}/git/refs/heads/${pr.head.ref}`, { allow404: true });
      await data.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!views) return <p className="muted">Loading pull requests…</p>;

  return (
    <section>
      <h2>Open requests</h2>
      {!views.length && <p className="muted">No open configuration pull requests.</p>}
      {views.map(({ pr, evaluation, apps }) => {
        const isAuthor = pr.user.login.toLowerCase() === data.user.login.toLowerCase();
        return (
          <article key={pr.number} className="card">
            <header className="row">
              <h3>
                <a href={pr.html_url}>
                  #{pr.number} {pr.title}
                </a>
              </h3>
              <span className={`badge ${evaluation.ok ? "ok" : "warn"}`}>{evaluation.ok ? "ready to merge" : "waiting"}</span>
            </header>
            <p className="muted">
              by @{pr.user.login} · {new Date(pr.created_at).toLocaleString()}
            </p>
            {evaluation.problems.length > 0 && (
              <ul className="error">
                {evaluation.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {apps.map(({ key, spec }) =>
              spec ? (
                <div key={key}>
                  <p>
                    <strong>{spec.name}</strong> in <code>{spec.org}</code>
                    {spec.enablement && (
                      <>
                        {" "}
                        · topic <code>{spec.enablement.topic}</code>
                      </>
                    )}
                  </p>
                  <p>{spec.purpose}</p>
                  <p className="muted">Use case: {spec.use_case}</p>
                  <Permissions spec={spec} />
                </div>
              ) : (
                <p key={key} className="muted">
                  removes <code>{key}</code>
                </p>
              ),
            )}
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Needs</th>
                  <th>Why</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.requirements.map((r) => (
                  <tr key={r.subject}>
                    <td>
                      <code>{r.subject}</code>
                    </td>
                    <td>{r.role === "none" ? "—" : r.role}</td>
                    <td>{r.reasons.join("; ")}</td>
                    <td>{r.role === "none" ? "n/a" : r.satisfiedBy ? `@${r.satisfiedBy}` : "pending"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row actions">
              {!isAuthor && (
                <>
                  <button disabled={busy === pr.number} onClick={() => review(pr, "APPROVE")}>
                    Approve
                  </button>
                  <button className="secondary" disabled={busy === pr.number} onClick={() => review(pr, "REQUEST_CHANGES")}>
                    Request changes
                  </button>
                </>
              )}
              <button disabled={!evaluation.ok || busy === pr.number} onClick={() => merge(pr)} title={evaluation.ok ? "" : "Approvals are missing"}>
                Merge
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

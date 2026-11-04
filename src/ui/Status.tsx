import { useState } from "react";
import { hasRole } from "../core/policy";
import { CONFIG_REPO, describeError, gh } from "./api";
import type { AppData } from "./useAppData";

export function Status({ data }: { data: AppData }) {
  const { status, config, user } = data;
  const [message, setMessage] = useState<string | null>(null);
  const isAdmin = hasRole(user.login, "admin", config.settings);

  async function runNow(dryRun: boolean) {
    try {
      await gh.json("POST", `/repos/${CONFIG_REPO}/actions/workflows/reconcile.yml/dispatches`, {
        body: { ref: "main", inputs: { dry_run: String(dryRun), only: "", override_guard: "false" } },
      });
      setMessage(`Started a ${dryRun ? "plan" : "reconcile"} run. Results appear here when it finishes.`);
    } catch (e) {
      setMessage(describeError(e));
    }
  }

  return (
    <section>
      <h2>Reconciliation status</h2>
      <p className="muted">
        {status ? `Last run ${new Date(status.generated_at).toLocaleString()}${status.dry_run ? " (plan only)" : ""}.` : "No run has published a status yet."}{" "}
        <a href={`https://github.com/${CONFIG_REPO}/actions/workflows/reconcile.yml`}>Run history</a>
      </p>
      {isAdmin && (
        <div className="row actions">
          <button onClick={() => runNow(false)}>Reconcile now</button>
          <button className="secondary" onClick={() => runNow(true)}>
            Plan only
          </button>
        </div>
      )}
      {message && <p>{message}</p>}
      {status && (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Org</th>
              <th>Topic</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Installed on</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            {status.results.map((r) => (
              <tr key={`${r.app}@${r.org}`}>
                <td>{config.apps[r.app]?.name ?? r.app}</td>
                <td>{r.org}</td>
                <td>
                  <code>{r.topic}</code>
                </td>
                <td>{r.mode}</td>
                <td>
                  <span className={`badge ${["in-sync", "applied"].includes(r.status) ? "ok" : "warn"}`}>{r.status}</span>
                  {r.message && <div className="muted small">{r.message}</div>}
                </td>
                <td>{r.current.join(", ") || "—"}</td>
                <td>
                  {r.to_add.map((n) => (
                    <div key={n}>+ {n}</div>
                  ))}
                  {r.to_remove.map((n) => (
                    <div key={n}>− {n}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

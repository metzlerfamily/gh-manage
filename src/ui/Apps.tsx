import { Fragment, useState } from "react";
import { hasRole } from "../core/policy";
import { installUrl, startCreation } from "./creation";
import { Permissions } from "./Permissions";
import type { AppData } from "./useAppData";

export function Apps({ data }: { data: AppData }) {
  const { config, user, status } = data;
  const [open, setOpen] = useState<string | null>(null);
  const isAdmin = hasRole(user.login, "admin", config.settings);
  const entries = Object.entries(config.apps);

  return (
    <section>
      <h2>Apps</h2>
      {!entries.length && <p className="muted">No apps yet. Use “Request an app” to add the first one.</p>}
      <table>
        <thead>
          <tr>
            <th>App</th>
            <th>Owner org</th>
            <th>Topic</th>
            <th>State</th>
            <th>Repositories</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, spec]) => {
            const pairs = status?.results.filter((r) => r.app === key) ?? [];
            const repos = pairs.reduce((n, p) => n + p.current.length, 0);
            return (
              <Fragment key={key}>
                <tr>
                  <td>
                    <button className="link" onClick={() => setOpen(open === key ? null : key)}>
                      {spec.name}
                    </button>
                    <div className="muted small">{key}</div>
                  </td>
                  <td>{spec.org}</td>
                  <td>{spec.enablement ? <code>{spec.enablement.topic}</code> : <span className="muted">—</span>}</td>
                  <td>
                    {spec.app ? (
                      <a className="badge ok" href={spec.app.html_url}>
                        created
                      </a>
                    ) : (
                      <span className="badge warn">approved, not created</span>
                    )}
                    {pairs.map((p) => (
                      <span key={p.org} className={`badge ${p.status === "in-sync" || p.status === "applied" ? "ok" : "warn"}`} title={p.message}>
                        {p.org}: {p.status}
                      </span>
                    ))}
                  </td>
                  <td>{spec.app ? repos : ""}</td>
                  <td>
                    {!spec.app && isAdmin && <button onClick={() => startCreation(key, spec)}>Create on GitHub</button>}
                    {spec.app && (
                      <a className="button secondary" href={installUrl(spec.app.slug)}>
                        Install
                      </a>
                    )}
                  </td>
                </tr>
                {open === key && (
                  <tr className="details">
                    <td colSpan={6}>
                      <p>{spec.purpose}</p>
                      <p className="muted">
                        Use case: {spec.use_case} · requested by @{spec.requester}
                        {spec.app && ` · created by @${spec.app.created_by} on ${new Date(spec.app.created_at).toLocaleDateString()}`}
                      </p>
                      <Permissions spec={spec} />
                      {pairs.map((p) => (
                        <p key={p.org} className="small">
                          <strong>{p.org}</strong> ({p.mode}): {p.current.join(", ") || "no repositories"}
                          {p.to_add.length > 0 && ` · to add: ${p.to_add.join(", ")}`}
                          {p.to_remove.length > 0 && ` · to remove: ${p.to_remove.join(", ")}`}
                        </p>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {isAdmin && entries.some(([, s]) => !s.app) && (
        <p className="muted small">
          “Create on GitHub” opens GitHub's app registration page for the owner org with the approved permissions filled in. You need to be an owner or app
          manager of that org. When you confirm, this page stores the private key as an encrypted Actions secret and opens a pull request that records the
          app.
        </p>
      )}
    </section>
  );
}

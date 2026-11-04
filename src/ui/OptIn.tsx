import { useEffect, useState } from "react";
import { describeError, gh } from "./api";
import type { AppData } from "./useAppData";

interface Repo {
  id: number;
  name: string;
  full_name: string;
  topics: string[];
  archived: boolean;
  permissions?: { admin: boolean };
}

export function OptIn({ data }: { data: AppData }) {
  const { config } = data;
  const [org, setOrg] = useState(config.settings.organizations[0] ?? "");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const apps = Object.entries(config.apps).filter(([, s]) => s.enablement?.orgs.some((o) => o.name === org));

  useEffect(() => {
    let live = true;
    setRepos(null);
    gh.paginate<Repo>(`/orgs/${org}/repos?type=all&sort=full_name`)
      .then((r) => live && setRepos(r.filter((x) => !x.archived)))
      .catch((e) => live && setError(describeError(e)));
    return () => {
      live = false;
    };
  }, [org]);

  async function toggle(repo: Repo, topic: string) {
    const names = repo.topics.includes(topic) ? repo.topics.filter((t) => t !== topic) : [...repo.topics, topic];
    setBusy(`${repo.id}:${topic}`);
    try {
      const r = await gh.json<{ names: string[] }>("PUT", `/repos/${repo.full_name}/topics`, { body: { names } });
      setRepos((rs) => rs?.map((x) => (x.id === repo.id ? { ...x, topics: r.names } : x)) ?? null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Enable apps on repositories</h2>
      <p className="muted">
        Adding an app's topic opts the repository in; removing it opts out. The reconciler applies the change within 15 minutes. You need admin on the
        repository.
      </p>
      <label className="inline">
        Organization{" "}
        <select value={org} onChange={(e) => setOrg(e.target.value)}>
          {config.settings.organizations.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      {!apps.length && <p className="muted">No app is enabled by topic in {org} yet.</p>}
      {repos === null ? (
        <p className="muted">Loading repositories…</p>
      ) : (
        apps.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                {apps.map(([key, s]) => (
                  <th key={key} title={`topic: ${s.enablement?.topic}`}>
                    {s.name}
                    <div className="muted small">{s.enablement?.topic}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <a href={`https://github.com/${repo.full_name}`}>{repo.name}</a>
                  </td>
                  {apps.map(([key, s]) => {
                    const topic = s.enablement!.topic;
                    return (
                      <td key={key}>
                        <input
                          type="checkbox"
                          aria-label={`${s.name} on ${repo.name}`}
                          checked={repo.topics.includes(topic)}
                          disabled={!repo.permissions?.admin || busy === `${repo.id}:${topic}`}
                          title={repo.permissions?.admin ? "" : "You need admin on this repository"}
                          onChange={() => toggle(repo, topic)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}

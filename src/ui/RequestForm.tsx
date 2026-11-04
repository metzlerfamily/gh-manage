import { useMemo, useState } from "react";
import { stringify } from "yaml";
import { appPath } from "../core/config";
import { type Access, type Level, LEVELS, PERMISSIONS } from "../core/permissions";
import { requiredApproval } from "../core/policy";
import { type AppSpec, defaultPrefix, parseApp, ValidationError } from "../core/schema";
import { describeError, openPr } from "./api";
import type { AppData } from "./useAppData";

interface Row {
  level: Level;
  perm: string;
  access: Access;
  justification: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34);

export function toYaml(spec: AppSpec): string {
  const { app, ...rest } = spec;
  const ordered = { ...rest, ...(app ? { app } : {}) };
  return `# Managed by gh-manage. Edit through pull requests.\n${stringify(ordered, { lineWidth: 0 })}`;
}

export function RequestForm({ data, onDone }: { data: AppData; onDone: () => void }) {
  const { config, user } = data;
  const orgs = config.settings.organizations;
  const [name, setName] = useState("");
  const [org, setOrg] = useState(orgs[0] ?? "");
  const [purpose, setPurpose] = useState("");
  const [useCase, setUseCase] = useState("");
  const [rows, setRows] = useState<Row[]>([{ level: "repository", perm: "contents", access: "read", justification: "" }]);
  const [topic, setTopic] = useState("");
  const [deliveryRepo, setDeliveryRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; error?: string }>({});

  const key = slugify(name);
  const raw = useMemo(() => {
    const permissions: Record<string, Record<string, { access: Access; justification: string }>> = {};
    for (const r of rows) (permissions[r.level] ??= {})[r.perm] = { access: r.access, justification: r.justification };
    return {
      name: name.trim(),
      org,
      requester: user.login,
      purpose,
      use_case: useCase,
      permissions,
      ...(deliveryRepo ? { delivery: { repo: deliveryRepo, prefix: defaultPrefix(key || "app") } } : {}),
      ...(topic ? { enablement: { topic, orgs: [{ name: org }] } } : {}),
    };
  }, [name, org, user.login, purpose, useCase, rows, deliveryRepo, topic, key]);

  const validation = useMemo(() => {
    try {
      const spec = parseApp(key || "x", raw, config.settings);
      const problems: string[] = [];
      if (config.apps[key]) problems.push(`an app named \`${key}\` already exists`);
      if (topic && Object.values(config.apps).some((a) => a.enablement?.topic === topic)) problems.push(`topic \`${topic}\` is already used`);
      return { spec, problems };
    } catch (e) {
      return { problems: e instanceof ValidationError ? e.problems.map((p) => p.replace(/^apps\/[^.:]+[.:]\s?/, "")) : [String(e)] };
    }
  }, [raw, key, config, topic]);

  const approval = validation.spec ? requiredApproval(validation.spec, undefined, config.settings) : null;
  const dupe = (i: number) => rows.some((r, j) => j !== i && r.level === rows[i].level && r.perm === rows[i].perm);
  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        const allowed = PERMISSIONS[next.level][next.perm];
        if (!allowed) next.perm = Object.keys(PERMISSIONS[next.level])[0];
        if (!PERMISSIONS[next.level][next.perm].includes(next.access)) next.access = PERMISSIONS[next.level][next.perm][0];
        return next;
      }),
    );

  async function submit() {
    if (!validation.spec || validation.problems.length) return;
    setBusy(true);
    setResult({});
    try {
      const pr = await openPr({
        branch: `request/${key}-${Date.now().toString(36)}`,
        path: appPath(key),
        content: toYaml(validation.spec),
        message: `request: ${validation.spec.name} in ${org}`,
        title: `Request for new GitHub App in ${org} org: ${validation.spec.name}`,
        body: [
          `**Purpose:** ${purpose}`,
          `**Organization:** ${org}`,
          `**Use case:** ${useCase}`,
          "",
          `Needs **${approval?.role}** approval${approval?.reasons.length ? `: ${approval.reasons.join("; ")}` : "."}`,
          "",
          "_Opened with gh-manage. The `gh-manage/approvals` check turns green once the required reviewer approves._",
        ].join("\n"),
      });
      setResult({ url: pr.html_url });
    } catch (e) {
      setResult({ error: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  if (result.url)
    return (
      <section className="card">
        <h2>Request submitted</h2>
        <p>
          Your pull request is open: <a href={result.url}>{result.url}</a>
        </p>
        <button onClick={onDone}>Back to requests</button>
      </section>
    );

  return (
    <section>
      <h2>Request a new GitHub App</h2>
      <p className="muted">
        GitHub Apps are the default for automation and org-level authentication. For a single repository, ask for a fine-grained token instead; for
        GitHub Actions, use the built-in <code>GITHUB_TOKEN</code>.
      </p>
      <div className="card form">
        <label>
          App name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Repo Factory" maxLength={34} />
          {key && <small className="muted">file: {appPath(key)}</small>}
        </label>
        <label>
          Organization
          <select value={org} onChange={(e) => setOrg(e.target.value)}>
            {orgs.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label>
          Purpose
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What the app will do" rows={2} />
        </label>
        <label>
          Use case
          <input value={useCase} onChange={(e) => setUseCase(e.target.value)} placeholder="Where it runs: Spacelift, GitHub Actions…" />
        </label>

        <fieldset>
          <legend>Permissions</legend>
          <table className="perms">
            <thead>
              <tr>
                <th>Level</th>
                <th>Permission</th>
                <th>Access</th>
                <th>Justification</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={dupe(i) ? "dupe" : ""}>
                  <td>
                    <select value={r.level} onChange={(e) => update(i, { level: e.target.value as Level })}>
                      {LEVELS.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={r.perm} onChange={(e) => update(i, { perm: e.target.value })}>
                      {Object.keys(PERMISSIONS[r.level]).map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={r.access} onChange={(e) => update(i, { access: e.target.value as Access })}>
                      {PERMISSIONS[r.level][r.perm].map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={r.justification} onChange={(e) => update(i, { justification: e.target.value })} placeholder="Why it is needed" />
                  </td>
                  <td>
                    <button className="link" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="secondary" onClick={() => setRows((rs) => [...rs, { level: "repository", perm: "metadata", access: "read", justification: "" }])}>
            Add permission
          </button>
        </fieldset>

        <label>
          Opt-in topic (optional)
          <input value={topic} onChange={(e) => setTopic(e.target.value.toLowerCase())} placeholder={key ? `${key}-enabled` : "my-app-enabled"} />
          <small className="muted">Repositories carrying this topic get the app. Without it, the app is created but not installed anywhere.</small>
        </label>
        <label>
          Deliver credentials to (optional)
          <input value={deliveryRepo} onChange={(e) => setDeliveryRepo(e.target.value)} placeholder={`${org}/my-automation`} />
          <small className="muted">
            The app ID and private key are stored as Actions variable/secret <code>{defaultPrefix(key || "app")}_APP_ID</code> and{" "}
            <code>{defaultPrefix(key || "app")}_PRIVATE_KEY</code> in this repository. Nobody sees the key.
          </small>
        </label>
      </div>

      <div className={`card ${validation.problems.length ? "warn" : "ok"}`}>
        {validation.problems.length ? (
          <>
            <strong>Not ready yet</strong>
            <ul>
              {validation.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <strong>Needs {approval?.role} approval</strong>
            {approval?.reasons.length ? (
              <ul>
                {approval.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Within the defined boundaries, so an admin can approve it directly.</p>
            )}
          </>
        )}
        <button onClick={submit} disabled={busy || !!validation.problems.length}>
          {busy ? "Opening pull request…" : "Submit request"}
        </button>
        {result.error && <p className="error">{result.error}</p>}
      </div>
    </section>
  );
}

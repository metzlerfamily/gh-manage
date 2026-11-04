import { type FormEvent, useState } from "react";
import { gh, token } from "./api";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    token.set(value.trim());
    try {
      await gh.get("/user");
      onSignedIn();
    } catch (err) {
      token.clear();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>GitHub App management</h1>
      <p>
        Request GitHub Apps, get them reviewed and created, and enable them on repositories with a topic. Everything is stored as YAML in the
        configuration repository and changed through pull requests.
      </p>
      <form onSubmit={submit} className="card">
        <label htmlFor="token">GitHub token</label>
        <input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="ghp_…" required />
        <button type="submit" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      <details className="card">
        <summary>Which token?</summary>
        <p>
          Create a{" "}
          <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=gh-manage" target="_blank" rel="noreferrer">
            classic token with <code>repo</code> and <code>workflow</code>
          </a>
          . Requesters need no access to the configuration repository: their request is opened from a fork. Admins also register apps and store their
          keys as Actions secrets, which needs admin on the configuration repository. Repository opt-in needs admin on that repository.
        </p>
        <p>
          The token stays in this browser tab (session storage) and is sent only to <code>api.github.com</code>. This demo has no OAuth proxy; see the
          README for the production sign-in design.
        </p>
      </details>
    </main>
  );
}

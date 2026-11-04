import { GitHub, GitHubError } from "../core/github";

export const CONFIG_REPO: string = import.meta.env.VITE_CONFIG_REPO || "metzlerfamily/gh-manage";
const TOKEN_KEY = "ghm.token";

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export const gh = new GitHub(() => token.get());

const utf8ToB64 = (s: string) => btoa(String.fromCodePoint(...new TextEncoder().encode(s)));
const b64ToUtf8 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, "")), (c) => c.codePointAt(0)!));

export interface User {
  login: string;
  avatar_url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login: string };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string };
  created_at: string;
}

export interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

export async function filesAt(ref: string, repo = CONFIG_REPO): Promise<Record<string, string>> {
  const tree = await gh.get<{ tree: TreeEntry[] }>(`/repos/${repo}/git/trees/${ref}?recursive=1`);
  const wanted = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith("config/"));
  const entries = await Promise.all(
    wanted.map(async (e) => {
      const blob = await gh.get<{ content: string }>(`/repos/${repo}/git/blobs/${e.sha}`);
      return [e.path, b64ToUtf8(blob.content)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function defaultBranchSha(repo = CONFIG_REPO): Promise<{ branch: string; sha: string }> {
  const info = await gh.get<{ default_branch: string }>(`/repos/${repo}`);
  const ref = await gh.get<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${info.default_branch}`);
  return { branch: info.default_branch, sha: ref.object.sha };
}

async function forkFor(login: string): Promise<string> {
  const name = CONFIG_REPO.split("/")[1];
  const existing = await gh.raw("GET", `/repos/${login}/${name}`, { allow404: true });
  if (existing.status !== 404) {
    const repo = (await existing.json()) as { fork: boolean; parent?: { full_name: string } };
    if (repo.fork && repo.parent?.full_name.toLowerCase() === CONFIG_REPO.toLowerCase()) {
      await gh.raw("POST", `/repos/${login}/${name}/merge-upstream`, { body: { branch: "main" }, allow404: true });
      return `${login}/${name}`;
    }
    throw new Error(`${login}/${name} exists and is not a fork of ${CONFIG_REPO}`);
  }
  const fork = await gh.json<{ full_name: string }>("POST", `/repos/${CONFIG_REPO}/forks`, { body: { default_branch_only: true } });
  for (let i = 0; i < 20; i++) {
    const r = await gh.raw("GET", `/repos/${fork.full_name}/git/ref/heads/main`, { allow404: true });
    if (r.status !== 404) return fork.full_name;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`fork ${fork.full_name} is not ready yet; try again in a minute`);
}

export async function openPr(opts: { branch: string; path: string; content: string; title: string; body: string; message: string }): Promise<PullRequest> {
  const [base, user, perms] = await Promise.all([
    defaultBranchSha(),
    gh.get<User>("/user"),
    gh.get<{ permissions?: { push: boolean } }>(`/repos/${CONFIG_REPO}`),
  ]);
  const target = perms.permissions?.push ? CONFIG_REPO : await forkFor(user.login);
  await gh.json("POST", `/repos/${target}/git/refs`, { body: { ref: `refs/heads/${opts.branch}`, sha: base.sha } });
  const existing = await gh.raw("GET", `/repos/${CONFIG_REPO}/contents/${opts.path}?ref=${base.branch}`, { allow404: true });
  const sha = existing.status === 404 ? undefined : ((await existing.json()) as { sha: string }).sha;
  await gh.json("PUT", `/repos/${target}/contents/${opts.path}`, {
    body: { message: opts.message, content: utf8ToB64(opts.content), branch: opts.branch, sha },
  });
  const head = target === CONFIG_REPO ? opts.branch : `${target.split("/")[0]}:${opts.branch}`;
  return gh.json<PullRequest>("POST", `/repos/${CONFIG_REPO}/pulls`, {
    body: { title: opts.title, body: opts.body, head, base: base.branch, maintainer_can_modify: false },
  });
}

export async function fileAtDefault(path: string): Promise<{ text: string; sha: string } | null> {
  const r = await gh.raw("GET", `/repos/${CONFIG_REPO}/contents/${path}`, { allow404: true });
  if (r.status === 404) return null;
  const body = (await r.json()) as { content: string; sha: string };
  return { text: b64ToUtf8(body.content), sha: body.sha };
}

export const ENFORCE_ENV = "enforce";

export async function setSecret(repo: string, name: string, value: string, environment?: string): Promise<void> {
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  const scope = environment ? `/repos/${repo}/environments/${environment}/secrets` : `/repos/${repo}/actions/secrets`;
  const key = await gh.get<{ key: string; key_id: string }>(`${scope}/public-key`);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  await gh.json("PUT", `${scope}/${name}`, {
    body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id },
  });
}

export async function setVariable(repo: string, name: string, value: string): Promise<void> {
  const r = await gh.raw("PATCH", `/repos/${repo}/actions/variables/${name}`, { body: { name, value }, allow404: true });
  if (r.status === 404) await gh.json("POST", `/repos/${repo}/actions/variables`, { body: { name, value } });
}

export function describeError(e: unknown): string {
  if (e instanceof GitHubError && (e.status === 403 || e.status === 404))
    return `${e.message}. Your token may be missing a permission for this repository (see Sign in for the required scopes).`;
  return e instanceof Error ? e.message : String(e);
}

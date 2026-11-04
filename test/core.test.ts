import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { appPath, loadConfig, SETTINGS_PATH } from "../src/core/config";
import { buildManifest, verifyConversion } from "../src/core/manifest";
import { requiredApproval } from "../src/core/policy";
import { evaluatePr } from "../src/core/review";
import { parseApp, parseSettings } from "../src/core/schema";

const settingsRaw = {
  organizations: ["acme", "acme-labs"],
  admins: ["alice"],
  managers: ["mona"],
  escalate: { organization: "read", repository: { administration: "write" } },
  defaults: { mode: "dry-run", removal_guard: { max: 10, max_percent: 20 } },
};
const settings = parseSettings(settingsRaw);

const appRaw = (over: Record<string, unknown> = {}) => ({
  name: "Repo Factory",
  org: "acme",
  requester: "bob",
  purpose: "Create repositories",
  use_case: "GitHub Actions",
  permissions: { repository: { contents: { access: "write", justification: "push scaffolding" } } },
  enablement: { topic: "repo-factory", orgs: [{ name: "acme" }] },
  ...over,
});

describe("schema", () => {
  it("parses a valid app and applies org defaults", () => {
    const app = parseApp("repo-factory", appRaw(), settings);
    expect(app.enablement?.orgs[0]).toEqual({ name: "acme", mode: "dry-run", removal_guard: { max: 10, max_percent: 20 } });
  });

  it("collects every problem", () => {
    expect(() =>
      parseApp(
        "Bad_Key",
        appRaw({ org: "elsewhere", permissions: { repository: { contents: { access: "admin" }, nope: { access: "read", justification: "x" } } } }),
        settings,
      ),
    ).toThrow(/file name[\s\S]*not a managed organization[\s\S]*access must be one of[\s\S]*justification is required[\s\S]*unknown repository permission/);
  });

  it("requires a webhook URL when events are subscribed", () => {
    expect(() => parseApp("x-app", appRaw({ events: ["push"] }), settings)).toThrow(/webhook_url is required/);
  });

  it("rejects duplicate topics across apps", () => {
    const files = {
      [SETTINGS_PATH]: stringify(settingsRaw),
      [appPath("one")]: stringify(appRaw()),
      [appPath("two")]: stringify(appRaw({ name: "Other" })),
    };
    expect(loadConfig(files).problems).toEqual(["apps/two: topic `repo-factory` is already used by apps/one"]);
  });
});

describe("policy", () => {
  it("lets admins approve repository-only requests", () => {
    expect(requiredApproval(parseApp("app-a", appRaw(), settings), undefined, settings).role).toBe("admin");
  });

  it("escalates org permissions and listed repository permissions", () => {
    const spec = parseApp(
      "app-a",
      appRaw({
        permissions: {
          organization: { members: { access: "read", justification: "list teams" } },
          repository: { administration: { access: "write", justification: "branch protection" } },
        },
      }),
      settings,
    );
    expect(requiredApproval(spec, undefined, settings)).toEqual({
      role: "manager",
      reasons: ["repository permission `administration: write`", "organization permission `members: read`"],
    });
  });

  it("only counts grants that are new or raised", () => {
    const withOrg = appRaw({ permissions: { organization: { members: { access: "write", justification: "j" } } } });
    const base = parseApp("app-a", withOrg, settings);
    const lowered = parseApp("app-a", appRaw({ permissions: { organization: { members: { access: "read", justification: "j" } } } }), settings);
    expect(requiredApproval(lowered, base, settings).role).toBe("admin");
  });

  it("escalates enabling an app outside its owner org", () => {
    const spec = parseApp("app-a", appRaw({ enablement: { topic: "t", orgs: [{ name: "acme" }, { name: "acme-labs" }] } }), settings);
    expect(requiredApproval(spec, undefined, settings).reasons).toEqual(["enabled outside its owner organization: acme-labs"]);
  });
});

describe("manifest", () => {
  it("flattens permissions and keeps the app private", () => {
    const m = buildManifest(parseApp("app-a", appRaw(), settings), "https://x.example/", "https://x.example/#/callback");
    expect(m).toMatchObject({ public: false, default_permissions: { contents: "write" }, hook_attributes: { active: false } });
  });

  it("checks the created app against the request", () => {
    const spec = parseApp("app-a", appRaw(), settings);
    expect(verifyConversion({ owner: { login: "acme" }, permissions: { contents: "write", metadata: "read" } }, spec)).toBeNull();
    expect(verifyConversion({ owner: { login: "evil" }, permissions: { contents: "write" } }, spec)).toMatch(/owned by evil/);
    expect(verifyConversion({ owner: { login: "acme" }, permissions: { contents: "write", administration: "write" } }, spec)).toMatch(/unexpected/);
    expect(verifyConversion({ owner: { login: "acme" }, permissions: { contents: "read" } }, spec)).toMatch(/unexpected/);
  });

  it("restricts where credentials can be delivered", () => {
    expect(() => parseApp("app-a", appRaw({ delivery: { repo: "evil/sink" } }), settings)).toThrow(/managed organization/);
    expect(() => parseApp("app-a", appRaw({ delivery: { repo: "acme/gh-manage" } }), settings)).toThrow(/configuration repository/);
    expect(parseApp("app-a", appRaw({ delivery: { repo: "acme/infra" } }), settings).delivery).toEqual({ repo: "acme/infra", prefix: "APP_A" });
  });
});

describe("evaluatePr", () => {
  const base = { [SETTINGS_PATH]: stringify(settingsRaw) };
  const sha = "head";
  const pr = (headFiles: Record<string, string>, changed: string[], reviews: { login: string; state: string; commit_id: string }[] = []) =>
    evaluatePr({ author: "bob", headSha: sha, baseFiles: base, headFiles: { ...base, ...headFiles }, changedPaths: changed, reviews });

  it("blocks a new request until an admin approves the current head", () => {
    const files = { [appPath("repo-factory")]: stringify(appRaw()) };
    expect(pr(files, [appPath("repo-factory")]).ok).toBe(false);
    expect(pr(files, [appPath("repo-factory")], [{ login: "alice", state: "APPROVED", commit_id: "old" }]).ok).toBe(false);
    expect(pr(files, [appPath("repo-factory")], [{ login: "alice", state: "APPROVED", commit_id: sha }]).ok).toBe(true);
  });

  it("ignores self-approval and later change requests", () => {
    const files = { [appPath("repo-factory")]: stringify(appRaw()) };
    const reviews = [
      { login: "alice", state: "APPROVED", commit_id: sha },
      { login: "alice", state: "CHANGES_REQUESTED", commit_id: sha },
    ];
    expect(pr(files, [appPath("repo-factory")], reviews).ok).toBe(false);
  });

  it("needs a manager for settings changes", () => {
    const changed = { [SETTINGS_PATH]: stringify({ ...settingsRaw, admins: ["alice", "bob"] }) };
    expect(pr(changed, [SETTINGS_PATH], [{ login: "alice", state: "APPROVED", commit_id: sha }]).ok).toBe(false);
    expect(pr(changed, [SETTINGS_PATH], [{ login: "mona", state: "APPROVED", commit_id: sha }]).ok).toBe(true);
  });

  it("lets an admin record the registered app without review", () => {
    const before = { ...base, [appPath("repo-factory")]: stringify(appRaw()) };
    const app = { id: 1, slug: "repo-factory", client_id: "Iv1", html_url: "https://github.com/apps/repo-factory", created_by: "alice", created_at: "2026-01-01" };
    const result = evaluatePr({
      author: "alice",
      headSha: sha,
      baseFiles: before,
      headFiles: { ...before, [appPath("repo-factory")]: stringify(appRaw({ app })) },
      changedPaths: [appPath("repo-factory")],
      reviews: [],
    });
    expect(result).toMatchObject({ ok: true, requirements: [{ role: "none" }] });
  });

  it("does not let a requester forge the app record", () => {
    const before = { ...base, [appPath("repo-factory")]: stringify(appRaw()) };
    const app = { id: 9, slug: "evil", client_id: "Iv1", html_url: "https://github.com/apps/evil", created_by: "bob", created_at: "2026-01-01" };
    const result = evaluatePr({
      author: "bob",
      headSha: sha,
      baseFiles: before,
      headFiles: { ...before, [appPath("repo-factory")]: stringify(appRaw({ app })) },
      changedPaths: [appPath("repo-factory")],
      reviews: [],
    });
    expect(result.ok).toBe(false);
  });

  it("allows self-approval only when settings opt in and the author wrote every commit", () => {
    const files = { [appPath("repo-factory")]: stringify(appRaw()) };
    const asAlice = (baseFiles: Record<string, string>, soleAuthor: boolean) =>
      evaluatePr({
        author: "alice",
        headSha: sha,
        baseFiles,
        headFiles: { ...baseFiles, ...files },
        changedPaths: [appPath("repo-factory")],
        reviews: [],
        soleAuthor,
      }).ok;
    const optedIn = { [SETTINGS_PATH]: stringify({ ...settingsRaw, allow_self_approval: true }) };
    expect(asAlice(base, true)).toBe(false);
    expect(asAlice(optedIn, false)).toBe(false);
    expect(asAlice(optedIn, true)).toBe(true);
  });

  it("rejects .yml and stray files under config/apps", () => {
    const result = pr({ "config/apps/repo-factory.yml": stringify(appRaw()) }, ["config/apps/repo-factory.yml"], [{ login: "alice", state: "APPROVED", commit_id: sha }]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["config/apps/repo-factory.yml: only config/apps/<name>.yaml files are allowed here"]);
  });

  it("validates the base settings, not the PR's", () => {
    const changed = { [SETTINGS_PATH]: stringify({ ...settingsRaw, admins: ["bob"] }), [appPath("x")]: stringify(appRaw()) };
    const result = pr(changed, [SETTINGS_PATH, appPath("x")], [{ login: "bob", state: "APPROVED", commit_id: sha }]);
    expect(result.ok).toBe(false);
  });
});

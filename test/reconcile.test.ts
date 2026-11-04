import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/core/config";
import { parseApp, parseSettings } from "../src/core/schema";
import { type AppBackend, appJwt, type Installation, type OrgBackend, type Repo } from "../src/reconciler/backend";
import { guardViolation, privateKeySecretName, run } from "../src/reconciler/reconcile";

const settings = parseSettings({ organizations: ["acme"], admins: ["a"], managers: ["m"] });

function config(mode: "dry-run" | "enforce", extra: Record<string, unknown> = {}): Config {
  const app = parseApp(
    "bot",
    {
      name: "Bot",
      org: "acme",
      requester: "a",
      purpose: "p",
      use_case: "u",
      permissions: { repository: { contents: { access: "read", justification: "j" } } },
      enablement: { topic: "bot-enabled", orgs: [{ name: "acme", mode, removal_guard: { max: 1, max_percent: 50 } }] },
      app: { id: 7, slug: "bot", client_id: "c", html_url: "https://github.com/apps/bot", created_by: "a", created_at: "t" },
      ...extra,
    },
    settings,
  );
  return { settings, apps: { bot: app } };
}

const repo = (id: number, name: string, topics: string[] = [], archived = false): Repo => ({ id, name, topics, archived });

class Fake implements OrgBackend {
  calls: string[] = [];
  constructor(
    public repos: Repo[],
    public selected: Repo[],
    public installs: Installation[] = [{ id: 1, account: { login: "acme", type: "Organization" }, repository_selection: "selected" }],
  ) {}
  orgRepos = async () => this.repos;
  app(): AppBackend {
    return {
      installations: async () => this.installs,
      installationRepos: async () => this.selected,
      addRepo: async (_i, id) => void this.calls.push(`+${id}`),
      removeRepo: async (_i, id) => void this.calls.push(`-${id}`),
    };
  }
}

const keys = { privateKey: () => "pem" };

describe("reconcile", () => {
  it("adds tagged repos and removes untagged ones when enforcing", async () => {
    const fake = new Fake([repo(1, "a", ["bot-enabled"]), repo(2, "b", ["bot-enabled"]), repo(3, "c")], [repo(1, "a"), repo(3, "c")]);
    const report = await run(config("enforce"), fake, { dryRun: false, ...keys });
    expect(report.results[0]).toMatchObject({ status: "applied", to_add: ["b"], to_remove: ["c"] });
    expect(fake.calls).toEqual(["+2", "-3"]);
  });

  it("only plans in dry-run mode", async () => {
    const fake = new Fake([repo(1, "a", ["bot-enabled"]), repo(2, "b", ["bot-enabled"])], [repo(1, "a")]);
    const report = await run(config("dry-run"), fake, { dryRun: false, ...keys });
    expect(report.results[0].status).toBe("planned");
    expect(fake.calls).toEqual([]);
  });

  it("skips archived repos", async () => {
    const fake = new Fake([repo(1, "a", ["bot-enabled"]), repo(2, "old", ["bot-enabled"], true)], [repo(1, "a")]);
    expect((await run(config("enforce"), fake, { dryRun: false, ...keys })).results[0].status).toBe("in-sync");
  });

  it("trips the removal guard", async () => {
    const fake = new Fake([repo(1, "a", ["bot-enabled"])], [repo(1, "a"), repo(2, "b"), repo(3, "c")]);
    const report = await run(config("enforce"), fake, { dryRun: false, ...keys });
    expect(report.results[0].status).toBe("guard-tripped");
    expect(fake.calls).toEqual([]);
  });

  it("replaces the placeholder repo picked at install time", async () => {
    const fake = new Fake([repo(1, "a", ["bot-enabled"]), repo(2, "b", ["bot-enabled"]), repo(9, "placeholder")], [repo(9, "placeholder")]);
    const report = await run(config("enforce"), fake, { dryRun: false, ...keys });
    expect(report.results[0]).toMatchObject({ status: "applied", to_add: ["a", "b"], to_remove: ["placeholder"] });
  });

  it("refuses to empty the selection", async () => {
    const fake = new Fake([repo(1, "a")], [repo(1, "a")]);
    expect((await run(config("enforce"), fake, { dryRun: false, ...keys })).results[0].status).toBe("empty-selection");
  });

  it("refuses all-repositories installations", async () => {
    const fake = new Fake([], [], [{ id: 1, account: { login: "acme", type: "Organization" }, repository_selection: "all" }]);
    expect((await run(config("enforce"), fake, { dryRun: false, ...keys })).results[0].status).toBe("all-repos-mode");
  });

  it("reports missing installs, apps and keys", async () => {
    const fake = new Fake([], [], []);
    expect((await run(config("enforce"), fake, { dryRun: false, ...keys })).results[0].status).toBe("not-installed");
    const noKey = await run(config("enforce"), fake, { dryRun: false, privateKey: () => undefined });
    expect(noKey.results[0]).toMatchObject({ status: "no-credentials", message: "secret GHM_BOT_PRIVATE_KEY is missing" });
    const notCreated = config("enforce");
    delete notCreated.apps.bot.app;
    expect((await run(notCreated, fake, { dryRun: false, ...keys })).results[0].status).toBe("not-created");
  });

  it("isolates errors per pair", async () => {
    const fake = new Fake([], []);
    fake.orgRepos = async () => {
      throw new Error("boom");
    };
    expect((await run(config("enforce"), fake, { dryRun: false, ...keys })).results[0]).toMatchObject({ status: "error", message: "boom" });
  });
});

describe("helpers", () => {
  it("computes guard limits", () => {
    expect(guardViolation({ max: 10, max_percent: 20 }, 3, 10)).toMatch(/30%/);
    expect(guardViolation({ max: 10, max_percent: 20 }, 2, 10)).toBeNull();
  });

  it("names secrets", () => {
    expect(privateKeySecretName("repo-factory")).toBe("GHM_REPO_FACTORY_PRIVATE_KEY");
  });

  it("signs a verifiable RS256 JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = appJwt(42, privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_700_000_000_000);
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_480, iss: "42" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

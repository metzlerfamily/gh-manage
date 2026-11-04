import type { Config } from "../core/config";
import type { EnablementOrg, RemovalGuard } from "../core/schema";
import type { AppBackend, OrgBackend, Repo } from "./backend";

export type Status =
  | "in-sync"
  | "planned"
  | "applied"
  | "not-created"
  | "no-credentials"
  | "not-installed"
  | "all-repos-mode"
  | "guard-tripped"
  | "empty-selection"
  | "error";

export const FAILING: Status[] = ["no-credentials", "all-repos-mode", "guard-tripped", "empty-selection", "error"];

export interface PairResult {
  app: string;
  slug?: string;
  org: string;
  topic: string;
  mode: EnablementOrg["mode"];
  status: Status;
  installation_id?: number;
  current: string[];
  desired: string[];
  to_add: string[];
  to_remove: string[];
  message?: string;
}

export interface RunReport {
  generated_at: string;
  dry_run: boolean;
  results: PairResult[];
}

export function guardViolation(guard: RemovalGuard, removals: number, current: number): string | null {
  if (removals > guard.max) return `would remove ${removals} repos (limit ${guard.max})`;
  if (current && removals * 100 > guard.max_percent * current)
    return `would remove ${removals}/${current} repos (${Math.floor((removals * 100) / current)}%, limit ${guard.max_percent}%)`;
  return null;
}

export interface RunOptions {
  dryRun: boolean;
  overrideGuard?: boolean;
  app?: string;
  privateKey(appKey: string): string | undefined;
  now?: () => Date;
}

const names = (repos: Repo[]) => repos.map((r) => r.name).sort();

async function reconcilePair(
  org: OrgBackend,
  app: AppBackend,
  base: Omit<PairResult, "status" | "current" | "desired" | "to_add" | "to_remove">,
  target: EnablementOrg,
  opts: RunOptions,
): Promise<PairResult> {
  const empty = { current: [], desired: [], to_add: [], to_remove: [] };
  const inst = (await app.installations()).find((i) => i.account.login.toLowerCase() === target.name.toLowerCase());
  if (!inst) return { ...base, ...empty, status: "not-installed", message: `${base.slug} is not installed on ${target.name}` };
  if (inst.repository_selection !== "selected")
    return { ...base, ...empty, installation_id: inst.id, status: "all-repos-mode", message: "installation covers all repositories; refusing to manage it" };

  const orgRepos = await org.orgRepos(target.name);
  const desiredRepos = orgRepos.filter((r) => r.topics.includes(base.topic) && !r.archived);
  const currentRepos = await app.installationRepos(inst.id);
  const currentIds = new Set(currentRepos.map((r) => r.id));
  const desiredIds = new Set(desiredRepos.map((r) => r.id));
  const add = desiredRepos.filter((r) => !currentIds.has(r.id));
  const remove = currentRepos.filter((r) => !desiredIds.has(r.id));
  const result: PairResult = {
    ...base,
    installation_id: inst.id,
    status: "in-sync",
    current: names(currentRepos),
    desired: names(desiredRepos),
    to_add: names(add),
    to_remove: names(remove),
  };
  if (!add.length && !remove.length) return result;

  if (!desiredRepos.length) {
    result.status = "empty-selection";
    result.message = "no repository carries the topic; a selected-repositories installation cannot be emptied";
    return result;
  }
  const bootstrap = currentRepos.every((r) => !desiredIds.has(r.id));
  const guard = bootstrap ? { ...target.removal_guard, max_percent: 100 } : target.removal_guard;
  const violation = guardViolation(guard, remove.length, currentRepos.length);
  if (violation && !opts.overrideGuard) {
    result.status = "guard-tripped";
    result.message = violation;
    return result;
  }
  if (opts.dryRun || target.mode !== "enforce") {
    result.status = "planned";
    if (target.mode !== "enforce") result.message = "org is in dry-run mode";
    return result;
  }
  for (const r of add) await app.addRepo(inst.id, r.id);
  for (const r of remove) await app.removeRepo(inst.id, r.id);
  result.status = "applied";
  return result;
}

export async function run(config: Config, org: OrgBackend, opts: RunOptions): Promise<RunReport> {
  const results: PairResult[] = [];
  for (const [key, spec] of Object.entries(config.apps)) {
    if (!spec.enablement || (opts.app && opts.app !== key)) continue;
    for (const target of spec.enablement.orgs) {
      const base = { app: key, slug: spec.app?.slug, org: target.name, topic: spec.enablement.topic, mode: target.mode };
      const empty = { current: [], desired: [], to_add: [], to_remove: [] };
      if (!spec.app) {
        results.push({ ...base, ...empty, status: "not-created", message: "approved but the GitHub App is not registered yet" });
        continue;
      }
      const pem = opts.privateKey(key);
      if (!pem) {
        results.push({ ...base, ...empty, status: "no-credentials", message: `secret ${privateKeySecretName(key)} is missing` });
        continue;
      }
      try {
        results.push(await reconcilePair(org, org.app(spec.app.id, pem), base, target, opts));
      } catch (e) {
        results.push({ ...base, ...empty, status: "error", message: (e as Error).message });
      }
    }
  }
  return { generated_at: (opts.now?.() ?? new Date()).toISOString(), dry_run: opts.dryRun, results };
}

export function privateKeySecretName(appKey: string): string {
  return `GHM_${appKey.toUpperCase().replace(/-/g, "_")}_PRIVATE_KEY`;
}

import { type Access, atLeast, type Level, LEVELS } from "./permissions";
import type { AppSpec, Settings } from "./schema";

export type Role = "admin" | "manager";

export interface PolicyResult {
  role: Role;
  reasons: string[];
}

function escalationThreshold(settings: Settings, level: Level, perm: string): Access | undefined {
  const rule = settings.escalate[level];
  if (rule === undefined) return undefined;
  return typeof rule === "string" ? rule : rule[perm];
}

function grantsOf(spec: AppSpec | undefined): Map<string, { level: Level; perm: string; access: Access }> {
  const out = new Map<string, { level: Level; perm: string; access: Access }>();
  if (!spec) return out;
  for (const level of LEVELS)
    for (const [perm, g] of Object.entries(spec.permissions[level] ?? {})) out.set(`${level}.${perm}`, { level, perm, access: g.access });
  return out;
}

function orgsOf(spec: AppSpec | undefined): string[] {
  return spec?.enablement?.orgs.map((o) => o.name) ?? [];
}

/**
 * Decides who must approve a change to an app definition. Only grants that are
 * new or raised compared with `base` count, so recording the registered app or
 * lowering a permission never needs a manager.
 */
export function requiredApproval(head: AppSpec, base: AppSpec | undefined, settings: Settings): PolicyResult {
  const reasons: string[] = [];
  const before = grantsOf(base);
  for (const [id, g] of grantsOf(head)) {
    const previous = before.get(id);
    if (previous && atLeast(previous.access, g.access)) continue;
    const threshold = escalationThreshold(settings, g.level, g.perm);
    if (threshold && atLeast(g.access, threshold)) reasons.push(`${g.level} permission \`${g.perm}: ${g.access}\``);
  }
  if (base && base.org !== head.org) reasons.push(`owner organization changed from ${base.org} to ${head.org}`);
  const newOrgs = orgsOf(head).filter((o) => !orgsOf(base).includes(o) && o !== head.org);
  if (newOrgs.length) reasons.push(`enabled outside its owner organization: ${newOrgs.join(", ")}`);
  return { role: reasons.length ? "manager" : "admin", reasons };
}

export function hasRole(login: string, role: Role, settings: Settings): boolean {
  const l = login.toLowerCase();
  const managers = settings.managers.map((m) => m.toLowerCase());
  if (role === "manager") return managers.includes(l);
  return managers.includes(l) || settings.admins.map((a) => a.toLowerCase()).includes(l);
}

export function isNoop(head: AppSpec, base: AppSpec | undefined): boolean {
  if (!base) return false;
  const strip = ({ app: _app, ...rest }: AppSpec) => JSON.stringify(rest);
  return strip(head) === strip(base);
}

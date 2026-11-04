import { LEVELS } from "./permissions";
import type { AppSpec } from "./schema";

export interface Manifest {
  name: string;
  url: string;
  description: string;
  public: false;
  redirect_url: string;
  hook_attributes: { url: string; active: boolean };
  default_permissions: Record<string, string>;
  default_events: string[];
}

export function buildManifest(spec: AppSpec, homepage: string, redirectUrl: string): Manifest {
  const default_permissions: Record<string, string> = {};
  for (const level of LEVELS) for (const [perm, g] of Object.entries(spec.permissions[level] ?? {})) default_permissions[perm] = g.access;
  return {
    name: spec.name,
    url: homepage,
    description: `${spec.purpose}\n\nUse case: ${spec.use_case}\nRequested by @${spec.requester} via gh-manage.`.slice(0, 400),
    public: false,
    redirect_url: redirectUrl,
    hook_attributes: { url: spec.webhook_url ?? homepage, active: spec.events.length > 0 },
    default_permissions,
    default_events: spec.events,
  };
}

export function manifestFormUrl(org: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

export function verifyConversion(app: { owner: { login: string }; permissions: Record<string, string> }, spec: AppSpec): string | null {
  if (app.owner.login.toLowerCase() !== spec.org.toLowerCase()) return `owned by ${app.owner.login}, expected ${spec.org}`;
  const expected = buildManifest(spec, "", "").default_permissions;
  const extra = Object.entries(app.permissions).filter(([p, a]) => p !== "metadata" && expected[p] !== a);
  if (extra.length) return `unexpected permissions ${extra.map(([p, a]) => `${p}:${a}`).join(", ")}`;
  const missing = Object.entries(expected).filter(([p, a]) => app.permissions[p] !== a);
  if (missing.length) return `missing permissions ${missing.map(([p, a]) => `${p}:${a}`).join(", ")}`;
  return null;
}

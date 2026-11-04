import { type Access, type Level, LEVELS, PERMISSIONS } from "./permissions";

export type Mode = "dry-run" | "enforce";

export interface RemovalGuard {
  max: number;
  max_percent: number;
}

export interface Grant {
  access: Access;
  justification: string;
}

export interface EnablementOrg {
  name: string;
  mode: Mode;
  removal_guard: RemovalGuard;
}

export interface RegisteredApp {
  id: number;
  slug: string;
  client_id: string;
  html_url: string;
  created_by: string;
  created_at: string;
}

export interface AppSpec {
  name: string;
  org: string;
  requester: string;
  purpose: string;
  use_case: string;
  permissions: Partial<Record<Level, Record<string, Grant>>>;
  events: string[];
  webhook_url?: string;
  delivery?: { repo: string; prefix: string };
  enablement?: { topic: string; orgs: EnablementOrg[] };
  app?: RegisteredApp;
}

export type Escalation = Partial<Record<Level, Access | Record<string, Access>>>;

export interface Settings {
  organizations: string[];
  admins: string[];
  managers: string[];
  escalate: Escalation;
  allow_self_approval: boolean;
  defaults: { mode: Mode; removal_guard: RemovalGuard };
}

export class ValidationError extends Error {
  constructor(public problems: string[]) {
    super(problems.join("\n"));
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,33}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,33}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PREFIX_RE = /^(?!GITHUB_)[A-Z][A-Z0-9_]{0,40}$/;
const MODES: Mode[] = ["dry-run", "enforce"];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(o: Obj, allowed: string[], where: string, problems: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unknown key \`${k}\``);
}

function str(o: Obj, key: string, where: string, problems: string[], re?: RegExp): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) {
    problems.push(`${where}.${key} is required`);
    return "";
  }
  if (re && !re.test(v)) problems.push(`${where}.${key} \`${v}\` is not valid`);
  return v.trim();
}

function logins(v: unknown, where: string, problems: string[]): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && LOGIN_RE.test(x))) {
    problems.push(`${where} must be a list of GitHub logins`);
    return [];
  }
  return v as string[];
}

function guard(v: unknown, fallback: RemovalGuard, where: string, problems: string[]): RemovalGuard {
  if (v === undefined) return fallback;
  if (!isObj(v)) {
    problems.push(`${where} must be a mapping`);
    return fallback;
  }
  unknownKeys(v, ["max", "max_percent"], where, problems);
  const out = { ...fallback, ...v } as RemovalGuard;
  if (!Number.isInteger(out.max) || out.max < 0) problems.push(`${where}.max must be a non-negative integer`);
  if (!Number.isInteger(out.max_percent) || out.max_percent < 0 || out.max_percent > 100)
    problems.push(`${where}.max_percent must be between 0 and 100`);
  return out;
}

function mode(v: unknown, fallback: Mode, where: string, problems: string[]): Mode {
  if (v === undefined) return fallback;
  if (!MODES.includes(v as Mode)) problems.push(`${where} must be one of ${MODES.join(", ")}`);
  return v as Mode;
}

function escalation(v: unknown, problems: string[]): Escalation {
  if (v === undefined) return {};
  if (!isObj(v)) {
    problems.push("escalate must be a mapping");
    return {};
  }
  unknownKeys(v, LEVELS, "escalate", problems);
  for (const level of LEVELS) {
    const rule = v[level];
    if (rule === undefined || typeof rule === "string") continue;
    if (!isObj(rule)) problems.push(`escalate.${level} must be an access level or a mapping`);
    else for (const p of Object.keys(rule)) if (!(p in PERMISSIONS[level])) problems.push(`escalate.${level}: unknown permission \`${p}\``);
  }
  return v as Escalation;
}

export function parseSettings(raw: unknown): Settings {
  const problems: string[] = [];
  if (!isObj(raw)) throw new ValidationError(["settings must be a mapping"]);
  unknownKeys(raw, ["organizations", "admins", "managers", "escalate", "allow_self_approval", "defaults"], "settings", problems);
  const defaults = isObj(raw.defaults) ? raw.defaults : {};
  unknownKeys(defaults, ["mode", "removal_guard"], "defaults", problems);
  if (raw.allow_self_approval !== undefined && typeof raw.allow_self_approval !== "boolean") problems.push("allow_self_approval must be true or false");
  const settings: Settings = {
    organizations: logins(raw.organizations, "organizations", problems),
    admins: logins(raw.admins, "admins", problems),
    managers: logins(raw.managers, "managers", problems),
    escalate: escalation(raw.escalate, problems),
    allow_self_approval: raw.allow_self_approval === true,
    defaults: {
      mode: mode(defaults.mode, "dry-run", "defaults.mode", problems),
      removal_guard: guard(defaults.removal_guard, { max: 10, max_percent: 20 }, "defaults.removal_guard", problems),
    },
  };
  if (problems.length) throw new ValidationError(problems);
  return settings;
}

export function defaultPrefix(key: string): string {
  return key.toUpperCase().replace(/-/g, "_");
}

export function parseApp(key: string, raw: unknown, settings: Settings): AppSpec {
  const problems: string[] = [];
  const where = `apps/${key}`;
  if (!KEY_RE.test(key)) problems.push(`${where}: file name must be lowercase letters, digits and dashes`);
  if (!isObj(raw)) throw new ValidationError([`${where} must be a mapping`]);
  unknownKeys(
    raw,
    ["name", "org", "requester", "purpose", "use_case", "permissions", "events", "webhook_url", "delivery", "enablement", "app"],
    where,
    problems,
  );

  const org = str(raw, "org", where, problems, LOGIN_RE);
  if (org && !settings.organizations.includes(org)) problems.push(`${where}.org \`${org}\` is not a managed organization`);

  const spec: AppSpec = {
    name: str(raw, "name", where, problems, NAME_RE),
    org,
    requester: str(raw, "requester", where, problems, LOGIN_RE),
    purpose: str(raw, "purpose", where, problems),
    use_case: str(raw, "use_case", where, problems),
    permissions: {},
    events: [],
  };

  if (!isObj(raw.permissions)) problems.push(`${where}.permissions is required`);
  else {
    unknownKeys(raw.permissions, LEVELS, `${where}.permissions`, problems);
    for (const level of LEVELS) {
      const block = raw.permissions[level];
      if (block === undefined) continue;
      if (!isObj(block)) {
        problems.push(`${where}.permissions.${level} must be a mapping`);
        continue;
      }
      const out: Record<string, Grant> = {};
      for (const [perm, grant] of Object.entries(block)) {
        const pw = `${where}.permissions.${level}.${perm}`;
        const allowed = PERMISSIONS[level][perm];
        if (!allowed) {
          problems.push(`${pw}: unknown ${level} permission`);
          continue;
        }
        if (!isObj(grant)) {
          problems.push(`${pw} must be {access, justification}`);
          continue;
        }
        unknownKeys(grant, ["access", "justification"], pw, problems);
        if (!allowed.includes(grant.access as Access)) problems.push(`${pw}.access must be one of ${allowed.join(", ")}`);
        const justification = str(grant, "justification", pw, problems);
        out[perm] = { access: grant.access as Access, justification };
      }
      spec.permissions[level] = out;
    }
    if (!LEVELS.some((l) => Object.keys(spec.permissions[l] ?? {}).length)) problems.push(`${where}.permissions is empty`);
  }

  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || !raw.events.every((e) => typeof e === "string")) problems.push(`${where}.events must be a list`);
    else spec.events = raw.events as string[];
  }
  if (raw.webhook_url !== undefined) {
    const url = str(raw, "webhook_url", where, problems, /^https:\/\/\S+$/);
    if (url) spec.webhook_url = url;
  }
  if (spec.events.length && !spec.webhook_url) problems.push(`${where}.webhook_url is required when events are subscribed`);

  if (raw.delivery !== undefined) {
    if (!isObj(raw.delivery)) problems.push(`${where}.delivery must be a mapping`);
    else {
      unknownKeys(raw.delivery, ["repo", "prefix"], `${where}.delivery`, problems);
      const repo = str(raw.delivery, "repo", `${where}.delivery`, problems, REPO_RE);
      const owner = repo.split("/")[0];
      if (repo && !settings.organizations.some((o) => o.toLowerCase() === owner.toLowerCase()))
        problems.push(`${where}.delivery.repo must belong to a managed organization`);
      if (repo && /\/gh-manage$/i.test(repo)) problems.push(`${where}.delivery.repo cannot be the gh-manage configuration repository`);
      const prefix = raw.delivery.prefix === undefined ? defaultPrefix(key) : String(raw.delivery.prefix);
      if (!PREFIX_RE.test(prefix)) problems.push(`${where}.delivery.prefix must be UPPER_SNAKE and not start with GITHUB_`);
      spec.delivery = { repo, prefix };
    }
  }

  if (raw.enablement !== undefined) {
    const ew = `${where}.enablement`;
    if (!isObj(raw.enablement)) problems.push(`${ew} must be a mapping`);
    else {
      unknownKeys(raw.enablement, ["topic", "orgs"], ew, problems);
      const topic = str(raw.enablement, "topic", ew, problems, TOPIC_RE);
      const orgs: EnablementOrg[] = [];
      if (!Array.isArray(raw.enablement.orgs) || !raw.enablement.orgs.length) problems.push(`${ew}.orgs must be a non-empty list`);
      else
        raw.enablement.orgs.forEach((o, i) => {
          const ow = `${ew}.orgs[${i}]`;
          if (!isObj(o)) return problems.push(`${ow} must be a mapping`);
          unknownKeys(o, ["name", "mode", "removal_guard"], ow, problems);
          const name = str(o, "name", ow, problems, LOGIN_RE);
          if (name && !settings.organizations.includes(name)) problems.push(`${ow}.name \`${name}\` is not a managed organization`);
          if (orgs.some((x) => x.name === name)) problems.push(`${ow}.name \`${name}\` is listed twice`);
          orgs.push({
            name,
            mode: mode(o.mode, settings.defaults.mode, `${ow}.mode`, problems),
            removal_guard: guard(o.removal_guard, settings.defaults.removal_guard, `${ow}.removal_guard`, problems),
          });
        });
      spec.enablement = { topic, orgs };
    }
  }

  if (raw.app !== undefined) {
    const aw = `${where}.app`;
    if (!isObj(raw.app)) problems.push(`${aw} must be a mapping`);
    else {
      unknownKeys(raw.app, ["id", "slug", "client_id", "html_url", "created_by", "created_at"], aw, problems);
      if (!Number.isInteger(raw.app.id)) problems.push(`${aw}.id must be an integer`);
      spec.app = {
        id: raw.app.id as number,
        slug: str(raw.app, "slug", aw, problems),
        client_id: str(raw.app, "client_id", aw, problems),
        html_url: str(raw.app, "html_url", aw, problems, /^https:\/\/github\.com\/apps\/[a-z0-9-]+$/),
        created_by: str(raw.app, "created_by", aw, problems, LOGIN_RE),
        created_at: str(raw.app, "created_at", aw, problems),
      };
    }
  }

  if (problems.length) throw new ValidationError(problems);
  return spec;
}

export function checkUniqueTopics(apps: Record<string, AppSpec>): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const [key, app] of Object.entries(apps)) {
    const topic = app.enablement?.topic;
    if (!topic) continue;
    const other = seen.get(topic);
    if (other) problems.push(`apps/${key}: topic \`${topic}\` is already used by apps/${other}`);
    else seen.set(topic, key);
  }
  return problems;
}

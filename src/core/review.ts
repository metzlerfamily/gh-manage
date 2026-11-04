import { appKeyFromPath, loadConfig, SETTINGS_PATH } from "./config";
import { hasRole, isNoop, requiredApproval, type Role } from "./policy";
import type { AppSpec } from "./schema";

export interface Review {
  login: string;
  state: string;
  commit_id: string;
}

export interface PrInput {
  author: string;
  headSha: string;
  baseFiles: Record<string, string>;
  headFiles: Record<string, string>;
  changedPaths: string[];
  reviews: Review[];
  soleAuthor?: boolean;
}

export interface Requirement {
  subject: string;
  role: Role | "none";
  reasons: string[];
  satisfiedBy?: string;
}

export interface PrEvaluation {
  ok: boolean;
  problems: string[];
  requirements: Requirement[];
}

export function currentApprovers(reviews: Review[], headSha: string, author: string): string[] {
  const latest = new Map<string, Review>();
  for (const r of reviews) if (r.state !== "COMMENTED") latest.set(r.login.toLowerCase(), r);
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED" && r.commit_id === headSha && r.login.toLowerCase() !== author.toLowerCase())
    .map((r) => r.login);
}

export function evaluatePr(input: PrInput): PrEvaluation {
  const base = loadConfig(input.baseFiles);
  if (!base.config) return { ok: false, problems: ["base branch configuration is invalid", ...base.problems], requirements: [] };
  const settings = base.config.settings;
  const head = loadConfig(input.headFiles);
  const problems = [...head.problems];
  const headApps: Record<string, AppSpec> = head.config?.apps ?? {};
  const requirements: Requirement[] = [];

  for (const path of [...new Set(input.changedPaths)].sort()) {
    const key = appKeyFromPath(path);
    if (path === SETTINGS_PATH) {
      requirements.push({ subject: path, role: "manager", reasons: ["changes who can approve and what escalates"] });
    } else if (!key) {
      requirements.push({ subject: path, role: "manager", reasons: ["changes a file outside config/apps"] });
    } else if (!(path in input.headFiles)) {
      requirements.push({ subject: path, role: "admin", reasons: ["deletes an app definition"] });
    } else if (headApps[key]) {
      const before = base.config.apps[key];
      const after = headApps[key];
      if (JSON.stringify(before?.app) !== JSON.stringify(after.app) && !hasRole(input.author, "admin", settings)) {
        requirements.push({ subject: path, role: "admin", reasons: ["edits the registered app record"] });
      }
      if (isNoop(after, before)) {
        if (!requirements.some((r) => r.subject === path)) requirements.push({ subject: path, role: "none", reasons: ["records the registered app"] });
        continue;
      }
      const { role, reasons } = requiredApproval(after, before, settings);
      requirements.push({ subject: path, role, reasons: reasons.length ? reasons : [before ? "updates an app definition" : "requests a new app"] });
    }
  }

  const approvers = currentApprovers(input.reviews, input.headSha, input.author);
  if (settings.allow_self_approval && input.soleAuthor) approvers.push(input.author);
  for (const req of requirements) {
    if (req.role === "none") continue;
    req.satisfiedBy = approvers.find((a) => hasRole(a, req.role as Role, settings));
  }
  const ok = !problems.length && requirements.every((r) => r.role === "none" || r.satisfiedBy);
  return { ok, problems, requirements };
}

export function renderEvaluation(e: PrEvaluation): string {
  const lines = [`## gh-manage policy: ${e.ok ? "✅ passing" : "❌ blocked"}`, ""];
  if (e.problems.length) lines.push("### Validation errors", "", ...e.problems.map((p) => `- ${p}`), "");
  if (e.requirements.length) {
    lines.push("| File | Needs | Why | Approved by |", "|---|---|---|---|");
    for (const r of e.requirements)
      lines.push(`| \`${r.subject}\` | ${r.role === "none" ? "—" : r.role} | ${r.reasons.join("; ")} | ${r.role === "none" ? "n/a" : r.satisfiedBy ? `@${r.satisfiedBy}` : "pending"} |`);
  }
  return lines.join("\n");
}

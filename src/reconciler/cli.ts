import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../core/config";
import { GitHub } from "../core/github";
import { evaluatePr, renderEvaluation, type Review } from "../core/review";
import { OrgOwnerBackend } from "./backend";
import { readConfigFiles, loadOrFail } from "./fs";
import { FAILING, privateKeySecretName, type RunReport, run } from "./reconcile";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::${name} is not set`);
    process.exit(1);
  }
  return v;
};

function summary(markdown: string) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function filesAt(ref: string): Record<string, string> {
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "config"], { encoding: "utf8" });
  const files: Record<string, string> = {};
  for (const path of listing.split("\n").filter(Boolean)) files[path] = execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  return files;
}

function validate() {
  const { problems } = loadConfig(readConfigFiles(process.cwd()));
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log("configuration is valid");
}

async function checkPr() {
  const repoPath = `/repos/${env("GITHUB_REPOSITORY")}`;
  const gh = new GitHub(() => env("GITHUB_TOKEN"));
  const pr = Number(env("PR_NUMBER"));
  const [info, repo] = await Promise.all([
    gh.get<{ user: { login: string }; head: { sha: string }; base: { ref: string } }>(`${repoPath}/pulls/${pr}`),
    gh.get<{ default_branch: string }>(repoPath),
  ]);
  const setStatus = (state: "success" | "failure", description: string) =>
    gh.json("POST", `${repoPath}/statuses/${info.head.sha}`, {
      body: {
        state,
        context: "gh-manage/approvals",
        description: description.slice(0, 140),
        target_url: `https://github.com/${env("GITHUB_REPOSITORY")}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`,
      },
    });
  if (info.base.ref !== repo.default_branch) {
    await setStatus("failure", `only pull requests into ${repo.default_branch} are evaluated`);
    summary(`PR targets \`${info.base.ref}\`, not \`${repo.default_branch}\`; refusing to evaluate.`);
    return;
  }
  execFileSync("git", ["fetch", "-q", "--no-tags", `https://github.com/${env("GITHUB_REPOSITORY")}`, `+refs/pull/${pr}/head:refs/remotes/pr/head`]);
  const fetched = execFileSync("git", ["rev-parse", "refs/remotes/pr/head"], { encoding: "utf8" }).trim();
  if (fetched !== info.head.sha) throw new Error(`PR head moved to ${fetched} while evaluating ${info.head.sha}; the next run will pick it up`);
  const changedPaths = execFileSync("git", ["diff", "--no-renames", "--name-only", `HEAD...${fetched}`], { encoding: "utf8" }).split("\n").filter(Boolean);
  const [reviews, commits] = await Promise.all([
    gh.paginate<{ user: { login: string }; state: string; commit_id: string }>(`${repoPath}/pulls/${pr}/reviews`),
    gh.paginate<{ author: { login: string } | null }>(`${repoPath}/pulls/${pr}/commits`),
  ]);
  const author = info.user.login.toLowerCase();
  const evaluation = evaluatePr({
    author: info.user.login,
    headSha: info.head.sha,
    baseFiles: filesAt("HEAD"),
    headFiles: filesAt(fetched),
    changedPaths,
    reviews: reviews.map<Review>((r) => ({ login: r.user.login, state: r.state, commit_id: r.commit_id })),
    soleAuthor: commits.every((c) => c.author?.login.toLowerCase() === author),
  });
  summary(renderEvaluation(evaluation));
  const pending = evaluation.requirements.filter((r) => r.role !== "none" && !r.satisfiedBy).map((r) => r.role);
  await setStatus(
    evaluation.ok ? "success" : "failure",
    evaluation.problems.length
      ? `${evaluation.problems.length} validation error(s)`
      : pending.length
        ? `waiting for ${[...new Set(pending)].join(" + ")} approval`
        : "all approvals present",
  );
}

function renderReport(report: RunReport): string {
  const lines = [`## Topic enablement ${report.dry_run ? "(plan)" : ""}`, "", "| App | Org | Topic | Status | Add | Remove | Note |", "|---|---|---|---|---|---|---|"];
  for (const r of report.results)
    lines.push(`| ${r.app} | ${r.org} | \`${r.topic}\` | ${r.status} | ${r.to_add.join(", ")} | ${r.to_remove.join(", ")} | ${r.message ?? ""} |`);
  if (!report.results.length) lines.push("| — | — | — | nothing to manage | | | |");
  return lines.join("\n");
}

async function reconcile() {
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");
  const overrideGuard = args.includes("--override-guard");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  const allSecrets: Record<string, string> = process.env.GHM_PRIVATE_KEYS ? JSON.parse(process.env.GHM_PRIVATE_KEYS) : {};
  delete process.env.GHM_PRIVATE_KEYS;
  const keys = Object.fromEntries(Object.entries(allSecrets).filter(([k]) => /^GHM_[A-Z0-9_]+_PRIVATE_KEY$/.test(k)));
  const config = loadOrFail(process.cwd());
  const report = await run(config, new OrgOwnerBackend(env("GHM_ADMIN_TOKEN")), {
    dryRun,
    overrideGuard,
    only: only || undefined,
    privateKey: (key) => keys[privateKeySecretName(key)],
  });
  summary(renderReport(report));
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (report.results.some((r) => FAILING.includes(r.status))) process.exit(1);
}

const commands: Record<string, () => unknown> = { validate, "check-pr": checkPr, reconcile };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`usage: ghm <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
Promise.resolve(command()).catch((e: Error) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});

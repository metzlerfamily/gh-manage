// GitHub App permissions, grouped the way the request template groups them.
// Source: components.schemas["app-permissions"] in github/rest-api-description.

export type Level = "repository" | "organization" | "account";
export type Access = "read" | "write" | "admin";

const RW: Access[] = ["read", "write"];
const RWA: Access[] = ["read", "write", "admin"];

export const PERMISSIONS: Record<Level, Record<string, Access[]>> = {
  repository: {
    actions: RW,
    administration: RW,
    artifact_metadata: RW,
    attestations: RW,
    checks: RW,
    code_quality: RW,
    codespaces: RW,
    contents: RW,
    dependabot_secrets: RW,
    deployments: RW,
    discussions: RW,
    environments: RW,
    issues: RW,
    merge_queues: RW,
    metadata: RW,
    packages: RW,
    pages: RW,
    pull_requests: RW,
    repository_custom_properties: RW,
    repository_hooks: RW,
    repository_projects: RWA,
    secret_scanning_alerts: RW,
    secrets: RW,
    security_events: RW,
    single_file: RW,
    statuses: RW,
    vulnerability_alerts: RW,
    workflows: ["write"],
  },
  organization: {
    members: RW,
    organization_administration: RW,
    organization_announcement_banners: RW,
    organization_copilot_agent_settings: RW,
    organization_copilot_requests: ["read"],
    organization_copilot_seat_management: RW,
    organization_custom_org_roles: RW,
    organization_custom_properties: RWA,
    organization_custom_roles: RW,
    organization_events: ["read"],
    organization_external_properties_for_repos: RWA,
    organization_hooks: RW,
    organization_packages: RW,
    organization_personal_access_token_requests: RW,
    organization_personal_access_tokens: RW,
    organization_plan: ["read"],
    organization_projects: RWA,
    organization_secrets: RW,
    organization_self_hosted_runners: RW,
    organization_user_blocking: RW,
  },
  account: {
    email_addresses: RW,
    followers: RW,
    git_ssh_keys: RW,
    gpg_keys: RW,
    interaction_limits: RW,
    profile: ["write"],
    starring: RW,
  },
};

export const LEVELS: Level[] = ["repository", "organization", "account"];

const RANK: Record<Access, number> = { read: 1, write: 2, admin: 3 };

export function atLeast(granted: Access, required: Access): boolean {
  return RANK[granted] >= RANK[required];
}

import { createSign } from "node:crypto";
import { GitHub } from "../core/github";

export function appJwt(appId: number, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export interface Installation {
  id: number;
  account: { login: string; type: string };
  repository_selection: "all" | "selected";
}

export interface Repo {
  id: number;
  name: string;
  topics: string[];
  archived: boolean;
}

export interface AppBackend {
  installations(): Promise<Installation[]>;
  installationRepos(installationId: number): Promise<Repo[]>;
  addRepo(installationId: number, repoId: number): Promise<void>;
  removeRepo(installationId: number, repoId: number): Promise<void>;
}

export interface OrgBackend {
  orgRepos(org: string): Promise<Repo[]>;
  app(appId: number, privateKey: string): AppBackend;
}

export class OrgOwnerBackend implements OrgBackend {
  private readonly admin: GitHub;
  private readonly repoCache = new Map<string, Promise<Repo[]>>();

  constructor(
    adminToken: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.admin = new GitHub(() => adminToken, undefined, fetchImpl);
  }

  orgRepos(org: string): Promise<Repo[]> {
    let cached = this.repoCache.get(org);
    if (!cached) {
      cached = this.admin.paginate<Repo>(`/orgs/${org}/repos?type=all`);
      this.repoCache.set(org, cached);
    }
    return cached;
  }

  app(appId: number, privateKey: string): AppBackend {
    const jwt = new GitHub(() => appJwt(appId, privateKey), undefined, this.fetchImpl);
    const { admin, fetchImpl } = this;
    return {
      installations: () => jwt.paginate<Installation>("/app/installations"),
      async installationRepos(installationId) {
        const { token } = await jwt.json<{ token: string }>("POST", `/app/installations/${installationId}/access_tokens`, {
          body: { permissions: { metadata: "read" } },
        });
        return new GitHub(() => token, undefined, fetchImpl).paginate<Repo>("/installation/repositories", "repositories");
      },
      async addRepo(installationId, repoId) {
        await admin.raw("PUT", `/user/installations/${installationId}/repositories/${repoId}`);
      },
      async removeRepo(installationId, repoId) {
        await admin.raw("DELETE", `/user/installations/${installationId}/repositories/${repoId}`);
      },
    };
  }
}

import { useCallback, useEffect, useState } from "react";
import { type Config, loadConfig } from "../core/config";
import { CONFIG_REPO, defaultBranchSha, filesAt, gh, type PullRequest, type User } from "./api";

export interface StatusReport {
  generated_at: string;
  dry_run: boolean;
  results: {
    app: string;
    org: string;
    topic: string;
    status: string;
    mode: string;
    current: string[];
    desired: string[];
    to_add: string[];
    to_remove: string[];
    message?: string;
  }[];
}

export interface AppData {
  user: User;
  config: Config;
  problems: string[];
  pulls: PullRequest[];
  status: StatusReport | null;
  reload: () => Promise<void>;
}

async function loadStatus(): Promise<StatusReport | null> {
  const r = await gh.raw("GET", `/repos/${CONFIG_REPO}/contents/status.json?ref=status`, { accept: "application/vnd.github.raw+json", allow404: true });
  return r.status === 404 ? null : ((await r.json()) as StatusReport);
}

export function useAppData(enabled: boolean) {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [user, head, pulls, status] = await Promise.all([
        gh.get<User>("/user"),
        defaultBranchSha(),
        gh.paginate<PullRequest>(`/repos/${CONFIG_REPO}/pulls?state=open`),
        loadStatus(),
      ]);
      const { config, problems } = loadConfig(await filesAt(head.sha));
      if (!config) throw new Error(problems.join("\n"));
      setData({ user, config, problems, pulls, status, reload });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { data, error, reload };
}

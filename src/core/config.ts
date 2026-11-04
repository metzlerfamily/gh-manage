import { parse } from "yaml";
import { type AppSpec, checkUniqueTopics, parseApp, parseSettings, type Settings, ValidationError } from "./schema";

export const SETTINGS_PATH = "config/settings.yaml";
export const APPS_DIR = "config/apps";

export interface Config {
  settings: Settings;
  apps: Record<string, AppSpec>;
}

export interface LoadResult {
  config?: Config;
  problems: string[];
}

export function appKeyFromPath(path: string): string | null {
  const m = path.match(/^config\/apps\/([^/]+)\.yaml$/);
  return m ? m[1] : null;
}

const isConfigPath = (path: string) => path === SETTINGS_PATH || path.startsWith(`${APPS_DIR}/`);

export function appPath(key: string): string {
  return `${APPS_DIR}/${key}.yaml`;
}

function yamlOf(text: string, where: string, problems: string[]): unknown {
  try {
    return parse(text);
  } catch (e) {
    problems.push(`${where}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    return undefined;
  }
}

export function loadConfig(files: Record<string, string>): LoadResult {
  const problems: string[] = [];
  const settingsText = files[SETTINGS_PATH];
  if (settingsText === undefined) return { problems: [`${SETTINGS_PATH} is missing`] };
  let settings: Settings;
  try {
    settings = parseSettings(yamlOf(settingsText, SETTINGS_PATH, problems));
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return { problems: [...problems, ...e.problems.map((p) => `${SETTINGS_PATH}: ${p}`)] };
  }
  const apps: Record<string, AppSpec> = {};
  for (const [path, text] of Object.entries(files).sort()) {
    if (!isConfigPath(path) || path === SETTINGS_PATH) continue;
    const key = appKeyFromPath(path);
    if (!key) {
      problems.push(`${path}: only config/apps/<name>.yaml files are allowed here`);
      continue;
    }
    try {
      apps[key] = parseApp(key, yamlOf(text, path, problems), settings);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      problems.push(...e.problems);
    }
  }
  problems.push(...checkUniqueTopics(apps));
  return { config: { settings, apps }, problems };
}

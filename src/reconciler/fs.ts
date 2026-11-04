import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_DIR, type Config, loadConfig, SETTINGS_PATH } from "../core/config";

export function readConfigFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  try {
    files[SETTINGS_PATH] = readFileSync(join(root, SETTINGS_PATH), "utf8");
  } catch {
    return files;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(join(root, APPS_DIR));
  } catch {
    entries = [];
  }
  for (const name of entries) files[`${APPS_DIR}/${name}`] = readFileSync(join(root, APPS_DIR, name), "utf8");
  return files;
}

export function loadOrFail(root: string): Config {
  const { config, problems } = loadConfig(readConfigFiles(root));
  if (!config || problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  return config;
}

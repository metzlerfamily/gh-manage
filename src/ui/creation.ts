import { parse, stringify } from "yaml";
import { appPath } from "../core/config";
import { buildManifest, manifestFormUrl, verifyConversion } from "../core/manifest";
import { type AppSpec, parseApp, type RegisteredApp, type Settings } from "../core/schema";
import { privateKeySecretName } from "../reconciler/reconcile";
import { CONFIG_REPO, ENFORCE_ENV, fileAtDefault, openPr, setSecret, setVariable } from "./api";
import { toYaml } from "./RequestForm";

const PENDING_KEY = "ghm.pending-manifest";

interface Pending {
  state: string;
  key: string;
}

interface Conversion {
  id: number;
  slug: string;
  client_id: string;
  html_url: string;
  pem: string;
  webhook_secret: string | null;
  owner: { login: string };
  permissions: Record<string, string>;
}

export interface Step {
  label: string;
  detail?: string;
}

export const homepage = () => `${location.origin}${location.pathname}`;
export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

export function startCreation(key: string, spec: AppSpec) {
  const state = crypto.randomUUID();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, key } satisfies Pending));
  const form = document.createElement("form");
  form.method = "post";
  form.action = manifestFormUrl(spec.org, state);
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(buildManifest(spec, homepage(), homepage()));
  form.append(input);
  document.body.append(form);
  form.submit();
}

export function manifestCallback(): { code: string; state: string } | null {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  return code && state ? { code, state } : null;
}

export async function completeCreation(
  code: string,
  state: string,
  login: string,
  settings: Settings,
  onStep: (steps: Step[]) => void,
): Promise<void> {
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", `${location.pathname}#/apps`);
  const pending = raw ? (JSON.parse(raw) as Pending) : null;
  if (!pending || pending.state !== state) throw new Error("This callback does not match an app creation started in this tab.");

  const steps: Step[] = [];
  const step = (label: string, detail?: string) => {
    steps.push({ label, detail });
    onStep([...steps]);
  };

  const current = await fileAtDefault(appPath(pending.key));
  if (!current) throw new Error(`${appPath(pending.key)} no longer exists on the default branch.`);
  const spec = parseApp(pending.key, parse(current.text), settings);

  const conversion = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!conversion.ok) throw new Error(`GitHub refused the manifest code (HTTP ${conversion.status}). Codes are single-use and expire after one hour.`);
  const app = (await conversion.json()) as Conversion;
  step("Registered the GitHub App", app.html_url);

  const mismatch = verifyConversion(app, spec);
  if (mismatch)
    throw new Error(`The app GitHub created does not match the approved request (${mismatch}). Delete it at ${app.html_url}/advanced and try again.`);

  const secretName = privateKeySecretName(pending.key);
  await setSecret(CONFIG_REPO, secretName, app.pem, ENFORCE_ENV);
  step("Stored the private key for the reconciler", `${CONFIG_REPO} → environment ${ENFORCE_ENV} → ${secretName}`);

  if (spec.delivery) {
    const { repo, prefix } = spec.delivery;
    await setVariable(repo, `${prefix}_APP_ID`, String(app.id));
    await setVariable(repo, `${prefix}_CLIENT_ID`, app.client_id);
    await setSecret(repo, `${prefix}_PRIVATE_KEY`, app.pem);
    const delivered = [`${prefix}_APP_ID`, `${prefix}_CLIENT_ID`, `${prefix}_PRIVATE_KEY`];
    if (app.webhook_secret) {
      await setSecret(repo, `${prefix}_WEBHOOK_SECRET`, app.webhook_secret);
      delivered.push(`${prefix}_WEBHOOK_SECRET`);
    }
    step("Delivered credentials to the requester", `${repo} → ${delivered.join(", ")}`);
  } else if (app.webhook_secret) {
    step("Webhook secret not delivered", "No delivery repository is configured; regenerate it from the app settings when needed.");
  }

  const record: RegisteredApp = {
    id: app.id,
    slug: app.slug,
    client_id: app.client_id,
    html_url: app.html_url,
    created_by: login,
    created_at: new Date().toISOString(),
  };
  const pr = await openPr({
    branch: `register/${pending.key}-${Date.now().toString(36)}`,
    path: appPath(pending.key),
    content: toYaml({ ...spec, app: record }),
    message: `register: ${spec.name} (app id ${app.id})`,
    title: `Register ${spec.name} (${app.slug})`,
    body: `Records the GitHub App created from the approved request.\n\n\`\`\`yaml\n${stringify({ app: record })}\`\`\``,
  });
  step("Opened the pull request that records the app", pr.html_url);
  if (spec.enablement)
    step(
      "Next: install it on selected repositories",
      `${installUrl(app.slug)} — choose "Only select repositories" and pick any one repository; the reconciler then keeps the selection equal to repositories tagged ${spec.enablement.topic}.`,
    );
}

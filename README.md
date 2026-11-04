# gh-manage

Self-service GitHub App management for enterprises with several organizations.
It replaces the Jira ticket workflow
([GitHub Apps: Request a New App](https://hyland.atlassian.net/wiki/spaces/GitHub/pages/3847360012/GitHub+Apps+Request+a+New+App))
with pull requests against this repository:

1. **Request.** A requester fills in the form (purpose, org, use case, per-level
   permissions with a justification for each). The page opens a PR adding
   `config/apps/<app>.yaml`.
2. **Approve.** The `gh-manage/approvals` check decides whether an **admin** is
   enough or a **manager** must approve (org- or account-level grants, sensitive
   repository grants, enabling outside the owner org, any settings change). It
   only goes green after a qualifying review on the latest commit.
3. **Create.** After merge, an admin clicks **Create on GitHub**. GitHub's own
   registration page opens with the approved permissions filled in (App
   Manifest flow). On return, the browser stores the private key as an
   encrypted Actions secret, optionally delivers the credentials to the
   requester's repository, and opens a PR recording the app ID. Nobody copies or
   e-mails a key.
4. **Enable by topic.** The app is installed in *Only select repositories* mode.
   A repository opts in by carrying the app's topic (toggle it on the
   **Enable on repos** page). The `reconcile` workflow keeps each installation's
   selection equal to the tagged repositories, with a removal circuit breaker.

Everything is static: the UI is a GitHub Pages site that talks to
`api.github.com` straight from the browser. Git holds the state, PR reviews do
the approvals, and Actions does the privileged work.

## Layout

```
config/settings.yaml        managed orgs, admins, managers, escalation rules, defaults
config/apps/<key>.yaml      one file per app: request + enablement + registered app record
src/core/                   schema, permission catalogue, approval policy, manifest builder (shared by UI and CI)
src/reconciler/             Node CLI: validate | check-pr | reconcile
src/ui/                     React SPA served from GitHub Pages
.github/workflows/
  ci.yml                    typecheck, tests, config validation, build
  policy.yml                approval check → commit status gh-manage/approvals (base-branch code only)
  policy-review-trigger.yml unprivileged relay so reviews re-run the check
  reconcile.yml             cron every 15 min, on config merge, or "Reconcile now"; publishes status.json to the `status` branch
  pages.yml                 deploys the SPA
```

## App file

```yaml
name: Repo Factory
org: metzlerfamily
requester: alice
purpose: Create repositories from templates
use_case: Spacelift stack running Terraform
permissions:
  repository:
    administration: { access: write, justification: create repos and set branch protection }
  organization:
    members: { access: read, justification: resolve team owners }
delivery:                    # optional: where the credentials go
  repo: metzlerfamily/infra
  prefix: REPO_FACTORY       # → REPO_FACTORY_APP_ID / _CLIENT_ID (variables), _PRIVATE_KEY (secret)
enablement:                  # optional: topic-gated installation
  topic: repo-factory
  orgs:
    - name: metzlerfamily
      mode: enforce          # dry-run | enforce
app:                         # written by gh-manage after creation; only admins may change it
  id: 123456
  slug: repo-factory
  ...
```

## Demo setup (free-tier org)

GitHub Free has no enterprise installation API, so the reconciler uses the
same approach as `hx-app-installer`'s `kind: owner` mode:

| Operation | Credential |
|---|---|
| List installations, read current selection | the managed app's own key (`GHM_<APP>_PRIVATE_KEY`, stored at creation) |
| Read repository topics, add/remove repositories | `GHM_ADMIN_TOKEN`: classic PAT of an org owner, `repo` scope |

The add/remove endpoints (`PUT/DELETE /user/installations/{id}/repositories/{repo}`)
are one call per repository and reject OAuth-app tokens such as `gh auth token`.

One-time setup:

1. Environment `enforce`, deployment branches limited to `main`, with secret
   `GHM_ADMIN_TOKEN` = classic PAT with `repo`. App private keys are written to
   this environment too, so no branch other than `main` can read them.
2. Settings → Pages → Source: **GitHub Actions**.
3. Ruleset on `main`: require a PR, require status `gh-manage/approvals` from
   the GitHub Actions app, require branches to be up to date, block force pushes.
4. Give write access to admins only. Requesters open PRs from forks, so they
   cannot push workflows or set commit statuses in this repository.
5. Open the site and sign in with your own classic PAT (`repo`, `workflow`).

### Trust model

- `policy.yml` runs base-branch code on `pull_request_target`. It reads the PR's
  files as data via git, evaluates only PRs into `main`, and computes the
  changed files with `git diff` instead of trusting the API listing.
- Reviews re-trigger the check through an unprivileged relay workflow. Only
  the PR number crosses the boundary, and it is validated as an integer.
- The `app:` block can only change with an admin as PR author or approver, so
  a requester cannot point a request at a different app.
- After creation, the browser checks that the app GitHub created has the
  approved owner and exactly the approved permissions before storing anything.
- Credentials are only delivered to repositories in managed orgs, never to the
  configuration repository.

## Going to an enterprise

- **Reconciler backend.** Swap `OrgOwnerBackend` for the enterprise
  installation API used by `hx-app-installer`: an enterprise-owned installer
  app with *Enterprise organization installation repositories: write*. It does
  50-repo batch PATCHes, can install apps on orgs where they are missing, and
  needs no per-app keys or PAT.
- **Sign-in.** `github.com/login/oauth/access_token` and the device flow do
  not send CORS headers, so a browser cannot finish OAuth on its own. Add a
  small token-exchange function (Cloudflare Worker / Azure Function) holding
  only a GitHub App's client secret, and sign in with GitHub App user tokens
  instead of PATs.
- **Private site.** Enterprise Cloud can publish Pages privately (org members only).
- **Separation of duties.** Set `allow_self_approval: false` and use distinct
  admins and managers; require CODEOWNERS review on `config/settings.yaml` and
  `.github/`.

## Development

```bash
npm ci
npm test                 # unit tests (core + reconciler against fakes)
npm run ghm -- validate  # validate config/
npm run dev              # local UI; sign in with a PAT
GHM_ADMIN_TOKEN=… GHM_PRIVATE_KEYS='{"GHM_X_PRIVATE_KEY":"-----BEGIN…"}' npm run ghm -- reconcile --dry-run
```

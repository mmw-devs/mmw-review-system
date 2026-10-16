# AGENTS.md

This file provides operational guidance for humans and automated agents
working in the `mmw-review-system` repository. Sections marked with a `TODO`
are intentional placeholders — fill them in as the project matures, but do
not silence them silently.

---

## 1. Project overview

- **Purpose** — _TODO: one-paragraph description of what mmw-review-system
  does, who its users are, and what success looks like._
- **Primary language** — TypeScript.
- **Repository conventions**:
  - Code formatted with the configured formatter (`TODO: prettier`).
  - Lint passes are required before merge (see CI).
  - Use [Conventional Commits](https://www.conventionalcommits.org/) for
    commit messages: `feat:`, `fix:`, `chore:`, `docs:`, etc.

---

## 2. Quick reference for agents

| Concern | Command |
|---------|---------|
| Install deps | `TODO: npm ci / pnpm install / yarn install` |
| Type-check | `TODO: tsc --noEmit` |
| Run unit tests | `TODO: npm test` |
| Run linter | `TODO: npm run lint` |
| Build production bundle | `TODO: npm run build` |
| Local dev server | `TODO: npm run dev` |

> **Performance rule for agents**: never run `npm install` (or the equivalent)
> repeatedly in a session. Use the cached `node_modules/` from the prior step.

---

## 3. Directory layout

_TODO: replace with the real layout once scaffolding lands._

```text
.
├── src/                  # Application source
├── tests/                # Test suites
├── docs/                 # Long-form documentation
├── .github/              # Workflows, templates, Renovate notes
├── AGENTS.md             # This file
├── renovate.json         # Dependency-update policy (Renovate)
└── secrets/              # NOT in git. Local-only sensitive notes.
```

> The `secrets/` directory is git-ignored. See §4 for what it should
> contain and why.

---

## 4. Production deployment — sensitive information policy

The production environment is shared, sensitive, and serves real users.
This repository **does not store production endpoints, credentials, or
key material in tracked files**. Instead, the project keeps a single
local-only file:

- **Path (in the working copy only)**: `secrets/PROD-SERVER.md`
- **Git status**: ignored via `/secrets/` in `.gitignore`
- **Authoritative values for**: `PROD_HOST`, `PROD_PORT`, `PROD_USER`,
  `PROD_DEPLOY_KEY`, `CLOUD_VENDOR`

If `secrets/PROD-SERVER.md` is **not present** in your checkout:

1. Ask another developer to share it out-of-band (encrypted message,
   in-person handoff, password manager — **not** in chat, issues, or PRs).
2. Do **not** attempt to discover the production host by cloning someone
   else's machine or scraping public sources.
3. Do **not** invent values. Deployments whose targets are unknown must
   be blocked, not guessed.

### 4.1 Production environment summary (variables only — values in secrets/)

| Property | Placeholder | Defined in |
|----------|-------------|------------|
| **Cloud vendor** | `${CLOUD_VENDOR}` | `secrets/PROD-SERVER.md` |
| **Public address** | `${PROD_HOST}` | `secrets/PROD-SERVER.md` |
| **OS user** | `${PROD_USER}` | `secrets/PROD-SERVER.md` |
| **SSH port** | `${PROD_PORT}` | `secrets/PROD-SERVER.md` |
| **Process manager** | _TODO: pick one — `pm2` or `systemd` (or both)_ | this file, §4.1 |
| **Deploy directory** | _TODO: pick one — e.g. `/opt/mmw-review-system`_ | this file, §4.1 |
| **Deploy key** | `${PROD_DEPLOY_KEY}` (named reference only) | `secrets/PROD-SERVER.md` |
| **Source of truth** | `main` branch, deployed via CI on push | this file, §4.1 |

### 4.2 Authoritative connection string template

```text
ssh ${PROD_USER}@${PROD_HOST} -p ${PROD_PORT}
```

- The SSH private key is **not** stored in this repository. The first time
  you (or your agent) need to connect, ask the project's developers for
  the location of the key file. Never paste key material into issues,
  PRs, comments, or chat transcripts.
- If you do not already have access to `PROD_DEPLOY_KEY` **and**
  `secrets/PROD-SERVER.md`, **stop and ask** — do not invent an
  alternative path.

### 4.3 Default deployment rules

1. **CI is the source of truth for deploys.** Pushing to `main` triggers the
   deploy workflow defined in `.github/workflows/`. Do not hand-deploy from a
   local laptop unless there is an active incident and CI is unavailable.
2. **Deploy only `main`.** Feature branches must be merged first.
3. **Never run destructive commands on the production host** (`rm -rf`,
   `dd`, `mkfs`, force-pushing, etc.) without a second pair of eyes and a
   written rollback plan.
4. **State must be recorded.** Every deploy — successful or not — appends a
   row to `docs/deployment-log.md` with: timestamp, commit SHA, operator,
   result.

### 4.4 Pre-deploy checklist (agent)

Before you tell CI to deploy, or before any manual SSH action:

- [ ] `secrets/PROD-SERVER.md` exists in your local checkout and is the
      current version shared by the team.
- [ ] `main` is green on the required CI checks.
- [ ] You can name the commit SHA being deployed.
- [ ] Migrations, if any, have been rehearsed on staging.
- [ ] The `PROD_DEPLOY_KEY` referenced above is loaded for the deployer
      (agent or CI runner).

### 4.5 Rollback

- Automated rollback strategy: _TODO — once the deploy workflow is written._
- Manual rollback command template:

  ```bash
  # Pseudo-rollback. Replace `${PROCESS_MANAGER}` and `${DEPLOY_DIR}` with
  # the values chosen once the deployment tooling lands. The host/port/user
  # are loaded from secrets/PROD-SERVER.md; never hard-coded here.
  # shellcheck disable=SC2154
  ssh "${PROD_USER}@${PROD_HOST}" -p "${PROD_PORT}" \
    '${PROCESS_MANAGER} restart mmw-review-system \
       --cwd ${DEPLOY_DIR}'
  ```

---

## 5. Secrets & sensitive data

- **Do not commit** any of the following to this repository in any form, even
  temporarily: SSH private keys, `.env` files containing credentials, API
  tokens, database URLs with embedded passwords, internal certificates,
  **production host/IP/port/user**.
- The single allowed home for production metadata is `secrets/PROD-SERVER.md`,
  which is `.gitignore`d and lives only in local checkouts.
- Use GitHub Actions secrets (preferred) for CI. Local development uses
  `.env.local` (already in `.gitignore` for Node projects).
- The `PROD_DEPLOY_KEY` referenced above is a **named reference** — not a
  value. The actual key file lives outside this repository.

---

## 6. What an agent must NOT do

- Do not commit secrets (see §5).
- Do not write production host/IP/port/user into any tracked file — including
  this one. Use `secrets/PROD-SERVER.md` instead.
- Do not push to `main` directly — always via PR (branch-protection rules
  are expected to be turned on; if they are not, raise an issue).
- Do not modify `renovate.json` in a way that would change automerge to
  `true` for major bumps.
- Do not expand the Renovate config to other `mmw-devs` repositories
  without explicit owner approval — that rollout is opt-in per repo.
- Do not run `npm publish` / `pnpm publish` from a local checkout.
- Do not share the contents of `secrets/PROD-SERVER.md` in issues, PRs,
  chat, or any public surface.

---

## 7. Pointers

- See [`docs/deployment.md`](docs/deployment.md) for the deployment runbook
  (once it is filled in).
- See [`.github/renovate.md`](.github/renovate.md) for the dependency-update
  policy.
- See [`renovate.json`](renovate.json) for the Renovate configuration source.
- See local-only [`secrets/PROD-SERVER.md`](secrets/PROD-SERVER.md) for the
  authoritative production environment values (not in git).

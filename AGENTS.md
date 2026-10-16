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
└── renovate.json         # Dependency-update policy (Renovate)
```

---

## 4. Production deployment

This section is for **deploying the application to the production server**.
Read this section carefully before initiating any deployment action — the
production environment is shared, sensitive, and serves real users.

### 4.1 Production environment summary

| Property | Value |
|----------|-------|
| **Cloud vendor** | Tencent Cloud |
| **Public address** | `106.54.44.57` |
| **OS user** | `ubuntu` |
| **SSH port** | `22` |
| **Process manager** | _TODO: pick one — `pm2` or `systemd` (or both)_ |
| **Deploy directory** | _TODO: pick one — e.g. `/opt/mmw-review-system`_ |
| **Deploy key** | referenced as `PROD_DEPLOY_KEY` (no raw key in this file) |
| **Source of truth** | `main` branch, deployed via CI on push |

### 4.2 Authoritative connection string

```text
ssh ubuntu@106.54.44.57 -p 22
```

- **The SSH private key is held by the project's developers, not in git.** The
  first time you (or your agent) need to connect, ask the project's developers
  for the location of the key file. Never paste key material into issues,
  PRs, comments, or chat transcripts.
- If you do not already have access to `PROD_DEPLOY_KEY`, **stop and ask** —
  do not invent an alternative path.

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
  # the values chosen once the deployment tooling lands.
  ssh ubuntu@106.54.44.57 -p 22 \
    '${PROCESS_MANAGER} restart mmw-review-system \
       --cwd ${DEPLOY_DIR}'
  ```

---

## 5. Secrets & sensitive data

- **Do not commit** any of the following to this repository in any form, even
  temporarily: SSH private keys, `.env` files containing credentials, API
  tokens, database URLs with embedded passwords, internal certificates.
- Use GitHub Actions secrets (preferred) for CI. Local development uses
  `.env.local` (already in `.gitignore` for Node projects).
- The `PROD_DEPLOY_KEY` referenced above is a **named reference** — not a
  value. The actual key file lives outside this repository.

---

## 6. What an agent must NOT do

- Do not commit secrets (see §5).
- Do not push to `main` directly — always via PR (branch-protection rules
  are expected to be turned on; if they are not, raise an issue).
- Do not modify `renovate.json` in a way that would change automerge to
  `true` for major bumps.
- Do not expand the Renovate config to other `mmw-devs` repositories
  without explicit owner approval — that rollout is opt-in per repo.
- Do not run `npm publish` / `pnpm publish` from a local checkout.

---

## 7. Pointers

- See [`docs/deployment.md`](docs/deployment.md) for the deployment runbook
  (once it is filled in).
- See [`.github/renovate.md`](.github/renovate.md) for the dependency-update
  policy.
- See [`renovate.json`](renovate.json) for the Renovate configuration source.

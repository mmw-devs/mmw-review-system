# Deployment runbook

> Status: skeleton. This file is referenced from `AGENTS.md` §4 and §7.
> The production host, port, user, and deploy key are **not** recorded in
> this file. Those values live in local-only `secrets/PROD-SERVER.md`
> (git-ignored; see `AGENTS.md` §4 and §5).

## 1. Environments

| Name | Host | Access | Purpose |
|------|------|--------|---------|
| **production** | `${PROD_HOST}` (cloud vendor `${CLOUD_VENDOR}`) | `ssh ${PROD_USER}@${PROD_HOST} -p ${PROD_PORT}` | Live user-facing service |
| staging | _TODO_ | _TODO_ | Pre-prod soak |
| local | developer laptop | — | Iterative development |

> Resolve the placeholders from your local `secrets/PROD-SERVER.md`. If
> that file is missing, request it from a project developer — do not
> look up the values from public sources.

## 2. Process manager

> _TODO — pick one and document here._ Suggested candidates:
>
> - **pm2** — convenient for Node, easy to introspect (`pm2 ls`,
>   `pm2 logs`, `pm2 restart mmw-review-system`). Ecosystem file lives in
>   `${DEPLOY_DIR}/ecosystem.config.js`.
> - **systemd** — first-class on Ubuntu, integrates with `journalctl`. Unit
>   file at `/etc/systemd/system/mmw-review-system.service`.
>
> Whichever you pick, treat its lifecycle commands
> (`pm2 restart`, `systemctl restart mmw-review-system`) as the canonical
> "restart the app" verbs.

## 3. Deploy directory

> _TODO — pick one and document here._ Common options:
>
> - `/opt/mmw-review-system` (system-owned)
> - `/srv/mmw-review-system` (service data convention)
> - `/home/ubuntu/mmw-review-system` (owner-owned)
>
> Update the `DEPLOY_DIR` reference in `AGENTS.md` §4 once decided.

## 4. CI deploy workflow

- Trigger: push to `main`.
- Workflow file: `.github/workflows/deploy.yml` _(not yet present — TODO)_.
- Required GitHub Actions secrets:
  - `PROD_DEPLOY_KEY` — SSH key for `${PROD_USER}@${PROD_HOST}:${PROD_PORT}`.
  - `PROD_HOST` — production host.
  - `PROD_USER` — production SSH user.
  - `PROD_PORT` — production SSH port.

## 5. Deploy steps (template)

```bash
# Pseudo-template. Replace placeholders with the real values once §2 and §3
# are decided. Production values are loaded from
# secrets/PROD-SERVER.md; do not paste them into this file.
# shellcheck disable=SC2154
ssh -i "$PROD_DEPLOY_KEY" -p "$PROD_PORT" "$PROD_USER@$PROD_HOST" '
  set -euo pipefail
  cd "${DEPLOY_DIR}"
  git fetch --tags --prune --prune-tags origin
  git checkout --force main
  git reset --hard origin/main
  ${INSTALL_CMD}        # e.g. "npm ci"
  ${BUILD_CMD}          # e.g. "npm run build"
  ${RESTART_CMD}        # e.g. "pm2 restart mmw-review-system" or
                        #      "systemctl restart mmw-review-system"
'
```

## 6. Smoke test after deploy

_TODO — write at least one curl/grep probe that verifies the service is
answering. Example:_

```bash
curl -fsS "https://${PROD_HOST}/healthz" | jq .
```

## 7. Rollback

_TODO — document the automated and manual rollback paths._

## 8. Deploy log

Maintain `docs/deployment-log.md` as an append-only ledger:

```text
| Timestamp (UTC) | Commit SHA | Operator | Result | Notes |
|----------------|-----------|----------|--------|-------|
```

> Do **not** paste `${PROD_HOST}` or any other production value into the
> log entries — refer to them by their placeholder names.

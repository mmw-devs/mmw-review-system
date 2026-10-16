# 部署手册

> 状态：骨架。本文件由 `AGENTS.md` §4 与 §7 引用。
> **生产主机、端口、用户与部署密钥的值不会写在本文件中**。
> 这些值保存在本地文件 `secrets/PROD-SERVER.md`（被 `.gitignore`
> 忽略；参见 `AGENTS.md` §4 与 §5）。

> 本文档中文撰写。命令、变量名、占位符保持英文。

---

## 1. 环境列表

| 名称 | 主机 | 访问方式 | 用途 |
|------|------|----------|------|
| **production** | `${PROD_HOST}`（云厂商 `${CLOUD_VENDOR}`） | `ssh ${PROD_USER}@${PROD_HOST} -p ${PROD_PORT}` | 对外服务的运行环境 |
| staging | _TODO_ | _TODO_ | 预发布浸泡 |
| local | 开发者笔记本 | — | 迭代开发 |

> 占位符从你本地的 `secrets/PROD-SERVER.md` 解析。若该文件缺失，
> 请通过带外方式向项目开发者索取——不要到公开来源去查。

---

## 2. 进程管理器

> _TODO —— 二选一并在此文档记录。_ 推荐候选：
>
> - **pm2** —— 对 Node 友好，方便自省（`pm2 ls`、`pm2 logs`、
>   `pm2 restart mmw-review-system`）。ecosystem 配置位于
>   `${DEPLOY_DIR}/ecosystem.config.js`。
> - **systemd** —— Ubuntu 原生支持，可与 `journalctl` 协作。Unit
>   文件位于 `/etc/systemd/system/mmw-review-system.service`。
>
> 选定后，将其生命周期命令（`pm2 restart` 或
> `systemctl restart mmw-review-system`）作为"重启应用"的标准动词。

---

## 3. 部署目录

> _TODO —— 二选一并在此文档记录。_ 常见选项：
>
> - `/opt/mmw-review-system`（系统级）
> - `/srv/mmw-review-system`（服务数据约定）
> - `/home/ubuntu/mmw-review-system`（用户级）
>
> 选定后请同步更新 `AGENTS.md` §4 中的 `DEPLOY_DIR` 引用。

---

## 4. CI 部署 workflow

- 触发：push 到 `main`。
- workflow 文件：`.github/workflows/deploy.yml`（**尚未创建 —— TODO**）。
- 必需的 GitHub Actions Secrets：
  - `PROD_DEPLOY_KEY` —— 用于 `${PROD_USER}@${PROD_HOST}:${PROD_PORT}` 的 SSH 私钥内容
    （由 `gh secret set PROD_DEPLOY_KEY < secrets/PROD_DEPLOY_KEY` 上传，
    本地密钥文件**默认就放在 `secrets/` 目录下**，与 `PROD-SERVER.md` 同级）。
  - `PROD_HOST` —— 生产主机。
  - `PROD_USER` —— 生产 SSH 用户。
  - `PROD_PORT` —— 生产 SSH 端口。

---

## 5. 部署步骤（模板）

```bash
# 伪命令模板。${INSTALL_CMD}/${BUILD_CMD}/${RESTART_CMD} 待 §2、§3 决策后替换。
# 生产值从 secrets/PROD-SERVER.md 加载；私钥默认也放在 secrets/PROD_DEPLOY_KEY，
# 不要把这些值粘贴到这里。
# shellcheck disable=SC2154
ssh -i "$PROD_DEPLOY_KEY" -p "$PROD_PORT" "$PROD_USER@$PROD_HOST" '
  set -euo pipefail
  cd "${DEPLOY_DIR}"
  git fetch --tags --prune --prune-tags origin
  git checkout --force main
  git reset --hard origin/main
  ${INSTALL_CMD}        # 例："npm ci"
  ${BUILD_CMD}          # 例："npm run build"
  ${RESTART_CMD}        # 例："pm2 restart mmw-review-system"
                        #  或 "systemctl restart mmw-review-system"
'
```

---

## 6. 部署后的冒烟测试

_TODO —— 至少写一条 curl/grep 探测验证服务可用。例如：_

```bash
curl -fsS "https://${PROD_HOST}/healthz" | jq .
```

---

## 7. 回滚

_TODO —— 写明自动与手动回滚路径。_

---

## 8. 部署日志

维护 `docs/deployment-log.md` 作为仅追加的账本：

```text
| 时间戳 (UTC) | Commit SHA | 操作者 | 结果 | 备注 |
|--------------|------------|--------|------|------|
```

> **不要**在日志条目中粘贴 `${PROD_HOST}` 或其它生产值——
> 用占位符名引用即可。

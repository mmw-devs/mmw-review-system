# 部署手册

> 状态：已提供 H5 服务与默认关闭的部署 workflow，尚未完成真实生产验收。当前准备顺序及模板使用方式见[部署材料](../deploy/README.md)，审核服务配置见[服务说明](review-server.md)。下文保留的 TODO 是待验收与完善事项。
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

> 当前模板采用 systemd。TODO：生产验收后确认；保留原候选说明：
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

> 当前模板采用 `/opt/mmw-review-system`。TODO：生产验收后确认；保留原候选说明：
>
> - `/opt/mmw-review-system`（系统级）
> - `/srv/mmw-review-system`（服务数据约定）
> - `${HOME}/mmw-review-system`（用户级）
>
> 选定后请同步更新 `AGENTS.md` §4 中的 `DEPLOY_DIR` 引用。

---

## 4. CI 部署 workflow

- 触发：push 到 `main` 或从 main 手动运行，且仓库变量 `PRODUCTION_DEPLOY_ENABLED=true`。
- workflow 文件：`.github/workflows/deploy.yml`（已创建；TODO：获批后启用并完成验收）。
- 必需的 GitHub Actions Secrets：
  - `PROD_DEPLOY_KEY` —— 用于 `${PROD_USER}@${PROD_HOST}:${PROD_PORT}` 的 SSH 私钥内容
    （由 `gh secret set PROD_DEPLOY_KEY < secrets/PROD_DEPLOY_KEY` 上传，
    本地密钥文件**默认就放在 `secrets/` 目录下**，与 `PROD-SERVER.md` 同级）。
  - `PROD_HOST` —— 生产主机。
  - `PROD_USER` —— 生产 SSH 用户。
  - `PROD_PORT` —— 生产 SSH 端口。
  - `PROD_KNOWN_HOSTS` —— 已通过带外核验的 SSH 主机公钥记录。

---

## 5. 部署步骤（模板）

当前 workflow 使用 systemd 和 `/opt/mmw-review-system`。它先运行测试，再检查干净工作区和最新 main 提交，检出该提交并重启。具体准备步骤见[部署材料](../deploy/README.md)。TODO：完成真实部署验收；不要执行旧的强制重置模板。

---

## 6. 部署后的冒烟测试

_TODO —— 至少写一条 curl/grep 探测验证服务可用。例如：_

```bash
curl -fsS "https://${PROD_HOST}/health" | jq .
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

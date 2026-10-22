# 部署材料（尚未启用）

本目录提供 H5 服务的 systemd、nginx、证书检查与续期模板，尚未在生产验证。提交或合并这些文件不代表已经安装、部署或发送告警。生产值仅保存在本地 `secrets/`、服务器配置或 GitHub Secrets 中。

部署 workflow 默认关闭。只有仓库变量 `PRODUCTION_DEPLOY_ENABLED=true` 且运行分支为 `main` 时才执行；启用前需要完成下列准备并获得部署授权。PR 检查只执行离线测试。

## 运行条件与模板

服务器需具备 Node.js 24 或以上、Git、Python 3、curl、OpenSSL、systemd、nginx 和支持 IP 证书的 Certbot。续期单元默认使用 `/snap/bin/certbot`，须核对实际路径并在本地调整。实际安装情况需另行核验；本目录不证明这些工具已经安装。

| 文件 | 用途 |
| --- | --- |
| `mmw-review-system.service` | 应用服务；需替换 `@SERVICE_USER@`、`@SERVICE_GROUP@`、`@NODE_BIN@` |
| `nginx-http.conf` | ACME 验证与静态连通性响应，不提供审核应用 |
| `nginx-https-ip.conf` | HTTPS 反向代理至 `127.0.0.1:4325` |
| `cert-check.sh` | 到期时间、IP 匹配及 HTTPS 健康检查 |
| `mmw-cert-check.service` / `.timer` | 每日两次检查，失败退出非零 |
| `mmw-cert-renew.service` / `.timer` | 每日两次调用 Certbot，由其判断是否续期 |
| `alert.env.example` | 本地告警配置模板，Webhook 默认留空 |

以下是部署准备顺序，不是本次 PR 已执行的操作。安装工具、改安全组、配置系统服务、签发证书和发送告警均需在部署授权范围内进行。

## 1. 准备入口与证书

安全组仅向外开放所需的 80/443，应用端口 4325 保持本机监听。先配置 HTTP 模板及 `/var/www/letsencrypt`，检查 nginx 配置再加载。静态响应仅证明 HTTP 连通，不代表应用健康。

IP 证书使用 `shortlived`，有效期 160 小时；webroot 方式要求 Certbot 5.4 或以上，见 [Let's Encrypt 官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。先核验官方安装来源和版本，不直接执行未核验的安装脚本。

下面命令中的 `PUBLIC_IP`、`CERT_EMAIL` 必须由操作者在服务器本地配置，不要将实际值提交到仓库。staging 使用独立目录，避免将不受信任的测试证书装入正式入口：

```bash
sudo certbot certonly --staging --preferred-profile shortlived \
  --config-dir /var/lib/mmw-acme-staging/config \
  --work-dir /var/lib/mmw-acme-staging/work \
  --logs-dir /var/lib/mmw-acme-staging/logs \
  --cert-name mmw-review --webroot -w /var/www/letsencrypt \
  --ip-address "$PUBLIC_IP" --email "$CERT_EMAIL" --agree-tos --no-eff-email
```

测试签发成功后再正式签发：

```bash
sudo certbot certonly --preferred-profile shortlived \
  --cert-name mmw-review --webroot -w /var/www/letsencrypt \
  --ip-address "$PUBLIC_IP" --email "$CERT_EMAIL" --agree-tos --no-eff-email \
  --deploy-hook "systemctl reload nginx"
```

正式证书位于 `/etc/letsencrypt/live/mmw-review/`。配置 HTTPS 模板前核对证书路径并执行 `nginx -t`，不得将 staging 证书用于正式登录。

两份 nginx 模板的访问日志不记录查询串、Referer 和 User-Agent，避免间接记录授权参数；该虚拟主机的错误日志写入 `/dev/null`，因为 nginx 错误日志可能包含完整请求行。代价是缺少代理错误细节，应用诊断使用 systemd journal，连接问题通过不带授权参数的健康请求复现。

## 2. 准备代码、配置和服务

部署目录约定为 `/opt/mmw-review-system`。由专用服务账号持有代码与数据目录，目录内保持干净 Git 工作区；`.env.local`、`data/` 必须被忽略。不要覆盖已有本地修改。

应用变量、加密密钥生成方法及候选飞书权限见[审核服务说明](../docs/review-server.md)。`.env.local` 由服务账号读取，限制其他用户访问，不提交到 Git。`REVIEW_ORIGIN` 填写实际的 `https://<PUBLIC_IP>`，不带末尾斜杠、路径或默认端口 `:443`；Node 的 env 文件不会展开 `${PUBLIC_IP}`。

在服务器本地副本中替换 systemd 单元的三个占位符，再安装单元；包含真实账号和路径的副本不回传仓库。应用需能写入 `data/`，其余目录按单元的只读限制运行。部署账号仅需获准重启此应用，不应授予通用免密 sudo。

H5 代码进入 `main` 之前，只准备配置，不提前启动尚不存在的服务入口。CI 只更新代码和重启服务，不安装或更新 systemd、nginx、证书、环境文件。

## 3. 启用 CI 部署

在 GitHub 的 `production` 环境或仓库中安全配置以下 Secrets；主机指纹必须通过带外渠道核对，不能只信任网络扫描结果。

| 名称 | 内容 |
| --- | --- |
| `PROD_HOST` | 生产主机 |
| `PROD_USER` | SSH 部署账号 |
| `PROD_PORT` | SSH 端口 |
| `PROD_DEPLOY_KEY` | 部署私钥 |
| `PROD_KNOWN_HOSTS` | 经核验的 SSH 主机公钥记录 |

准备完成且获得授权后，将仓库变量 `PRODUCTION_DEPLOY_ENABLED` 设为 `true`，从 `main` 手动运行首次部署。后续 main 更新会触发部署，仅修改部署日志的提交除外。

workflow 先运行测试，再检查服务器工作区无未提交修改、目标提交属于 main 且仍是最新 main，然后以 detached HEAD 检出指定提交、重启服务并检查本机 `/health`。不会使用强制重置丢弃工作区修改。main 在排队期间更新时拒绝部署旧提交，应运行最新 main。

运行摘要记录结果；服务器可连接且数据目录存在时另追加 `data/deployments.log`。CI 用 `codex/deploy-log-<RUN_ID>-<ATTEMPT>` 分支创建日志 PR，重跑不会复用旧分支。连接、推送或 PR 创建失败时需从运行摘要补录；这些记录不具备防篡改保证。GitHub 默认令牌创建的 PR 通常不会自动触发后续 workflow，合并日志前需按仓库检查策略处理。

## 4. 部署后验证与定时任务

真实 `/health` 和 `REVIEW_ORIGIN` 验证必须等 H5 代码进入 main 并部署后进行：

```bash
curl -fsS "https://${PUBLIC_IP}/health"
```

预期返回 `status: ok`，且正常证书验证通过；不要使用跳过 TLS 校验的参数。还需验证 4325 仅监听本机，并在飞书桌面端和移动端完成授权、文档拉取、审核与导出。飞书主页和回调地址必须与实际入口一致；真实权限范围仍待联调。

安装定时任务前检查已有 Certbot timer，避免重复配置。检查任务需 `/etc/mmw-review/alert.env`；从模板创建本地文件，填写实际 `CERT_HOST`，限制读取权限。Webhook 留空时只记录本地失败，填写后才发送飞书告警；真实告警测试需明确授权。证书续期 dry-run、nginx reload 和检查任务均须在服务器验收后再启用。

## 5. 回滚与剩余工作

优先通过 PR 在 main 撤回问题提交，再由 CI 部署。仅在生产故障且 CI 不可用、取得授权后，才手动检出已核验的历史 main 提交并重启；先检查工作区与数据备份，禁止强制覆盖未提交文件。不得通过切回 HTTP 代理来恢复登录。

TODO：完成真实服务器验收、备份与恢复演练、自动回滚设计；这些模板没有执行数据迁移或提供备份保证。每次实际部署均须在[部署记录](../docs/deployment-log.md)保留结果。

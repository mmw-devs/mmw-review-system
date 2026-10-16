# AGENTS.md

本文件为 `mmw-review-system` 仓库的人类与自动化代理提供操作指引。
标注 `TODO` 的小节是有意保留的占位项——后续随项目推进逐步补全，
**不要悄悄抹掉**它们。

> 本说明文档使用中文撰写（核心开发者均为中国成员）。但**目录名、
> 文件名、变量名、命令行片段、占位符 ${PLACEHOLDER} 等标识符保持英文**，
> 以兼容跨平台、CI 容器与 GitHub 生态。

---

## 1. 项目概览

- **项目目的** —— _TODO：用一段话说明 mmw-review-system 是什么、
  服务于哪些用户、成功标准是什么。_
- **主语言** —— TypeScript。
- **仓库约定**：
  - 代码由配置的格式化器格式化（`TODO：prettier`）。
  - 合并前必须通过 Lint 检查（参见 CI）。
  - 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh)：
    `feat:`、`fix:`、`chore:`、`docs:` 等。

---

## 2. 代理快速参考

| 项目 | 命令 |
|------|------|
| 安装依赖 | `TODO：npm ci / pnpm install / yarn install` |
| 类型检查 | `TODO：tsc --noEmit` |
| 运行单元测试 | `TODO：npm test` |
| 运行 Lint | `TODO：npm run lint` |
| 构建生产产物 | `TODO：npm run build` |
| 本地开发服务器 | `TODO：npm run dev` |

> **性能建议（针对代理）**：在同一会话中不要反复执行 `npm install`
> （或等价命令）。请复用上一步已经准备好的 `node_modules/` 缓存。

---

## 3. 目录结构

_TODO：脚手架落地后用真实结构替换。_

```text
.
├── src/                  # 应用程序源码
├── tests/                # 测试代码
├── docs/                 # 长篇文档（部署手册等）
├── .github/              # Workflow、PR/Issue 模板、Renovate 说明
├── AGENTS.md             # 当前文件
├── renovate.json         # 依赖更新策略（Renovate）
└── secrets/              # 不入 git，仅本地保存的敏感说明
```

> `secrets/` 目录被 `.gitignore` 忽略，详见第 4 节。

---

## 4. 生产部署 —— 敏感信息策略

生产环境多人共享、敏感、面向真实用户。本仓库**不在被 git 追踪的
文件中存放生产端点、凭据或密钥**。取而代之，项目仅在以下位置保留
**命名引用**：

- **本地文件路径**：`secrets/PROD-SERVER.md`
- **Git 状态**：由 `.gitignore` 中的 `/secrets/` 忽略
- **承载的变量**：`PROD_HOST`、`PROD_PORT`、`PROD_USER`、
  `PROD_DEPLOY_KEY`、`CLOUD_VENDOR`

如果你的 checkout 中**没有** `secrets/PROD-SERVER.md`：

1. 请通过带外方式（加密消息、线下交接、密码管理器 —— **不要**用
   聊天、工单、PR 评论）向另一位项目开发者索取。
2. **不要**通过翻看他人机器或爬取公开来源来推断生产地址。
3. **不要**编造值。目标未知的部署必须被阻断，而不是猜。

### 4.1 生产环境摘要（仅变量名，具体值见 secrets/）

| 属性 | 占位符 | 定义位置 |
|------|--------|----------|
| **云厂商** | `${CLOUD_VENDOR}` | `secrets/PROD-SERVER.md` |
| **公网地址** | `${PROD_HOST}` | `secrets/PROD-SERVER.md` |
| **登录用户** | `${PROD_USER}` | `secrets/PROD-SERVER.md` |
| **SSH 端口** | `${PROD_PORT}` | `secrets/PROD-SERVER.md` |
| **进程管理器** | _TODO：在 `pm2` 与 `systemd` 中二选一（或两者都用）_ | 本文件 §4.1 |
| **部署目录** | _TODO：例如 `/opt/mmw-review-system`_ | 本文件 §4.1 |
| **部署密钥** | `${PROD_DEPLOY_KEY}`（仅作为命名引用） | `secrets/PROD-SERVER.md` |
| **唯一来源** | `main` 分支，由 CI 在 push 时部署 | 本文件 §4.1 |

### 4.2 权威连接字符串模板

```text
ssh ${PROD_USER}@${PROD_HOST} -p ${PROD_PORT}
```

- SSH 私钥**不**存放在本仓库。第一次需要连接时，向项目开发者索取
  密钥文件的位置。**任何情况下都不要把私钥粘贴进工单、PR、评论、
  聊天记录。**
- 如果你既没有 `PROD_DEPLOY_KEY`，也没有 `secrets/PROD-SERVER.md`，
  **停下来询问，不要自行另辟路径**。

### 4.3 默认部署规则

1. **CI 是部署的唯一真理来源**。推送到 `main` 将触发
   `.github/workflows/` 下的部署 workflow。仅在生产故障且 CI 不可用
   时，才允许本地手动部署。
2. **只部署 `main`**。功能分支必须先合并。
3. **绝不在生产主机上执行破坏性命令**（`rm -rf`、`dd`、`mkfs`、
   `git push --force` 等），除非有第二人复核并已写好回滚方案。
4. **必须留下部署记录**。每次部署（无论成败）都要在
   `docs/deployment-log.md` 追加一行：时间戳、commit SHA、操作者、结果。

### 4.4 部署前清单（针对代理）

在你让 CI 部署、或手动 SSH 之前：

- [ ] 本地 checkout 中存在 `secrets/PROD-SERVER.md`，且已是团队
      分享的最新版本。
- [ ] `main` 在必需的 CI 检查上为绿。
- [ ] 你能明确说出正在部署的 commit SHA。
- [ ] 若有迁移，已在 staging 排练过。
- [ ] `PROD_DEPLOY_KEY` 已为部署者（代理或 CI runner）加载。

### 4.5 回滚

- 自动回滚策略：_TODO —— 等部署 workflow 写好后补全。_
- 手动回滚命令模板：

  ```bash
  # 伪命令模板。${PROCESS_MANAGER} 和 ${DEPLOY_DIR} 等待 PM 与部署目录
  # 决策后替换。${PROD_HOST}/${PROD_USER}/${PROD_PORT} 由 secrets/PROD-SERVER.md
  # 注入，绝不硬编码在这里。
  # shellcheck disable=SC2154
  ssh "${PROD_USER}@${PROD_HOST}" -p "${PROD_PORT}" \
    '${PROCESS_MANAGER} restart mmw-review-system \
       --cwd ${DEPLOY_DIR}'
  ```

---

## 5. 密钥与敏感数据

- **不要提交**以下任何内容到本仓库，包括临时试验：
  SSH 私钥、含凭据的 `.env` 文件、API token、带口令的数据库 URL、
  内部证书、**生产主机 / IP / 端口 / 用户**。
- 生产元数据**唯一**允许的存放位置是 `secrets/PROD-SERVER.md`，
  该文件被 `.gitignore` 忽略，只存在于本地 checkout。
- CI 推荐使用 GitHub Actions Secrets。本地开发使用 `.env.local`
  （Node 项目的 `.gitignore` 已忽略）。
- 上面提到的 `PROD_DEPLOY_KEY` 在 CI 端是 GitHub Actions Secret 名；
  在本地对应 `secrets/PROD_DEPLOY_KEY` 这一文件（同被 `/secrets/`
  忽略），由项目开发者持有且**默认就放在 `secrets/` 目录下**。

---

## 6. 代理不要做的事

- 不要提交密钥（见第 5 节）。
- 不要把生产主机 / IP / 端口 / 用户写进任何被追踪的文件，包括
  `AGENTS.md` 自己。改用 `secrets/PROD-SERVER.md`。
- 不要直接 push 到 `main`——始终走 PR（项目应有分支保护规则；
  若还没有，请提交 issue 提出）。
- 不要修改 `renovate.json` 把 major 升级改为 `automerge: true`。
- 不要把 Renovate 配置扩展到 `mmw-devs` 的其它仓库——每个仓库
  单独 opt-in。
- 不要在本地 checkout 中执行 `npm publish` / `pnpm publish`。
- 不要把 `secrets/PROD-SERVER.md` 的内容分享到工单、PR、聊天或
  任何公开场合。

---

## 7. 相关文件

- 部署手册：[`docs/deployment.md`](docs/deployment.md)
- Renovate 说明：[`.github/renovate.md`](.github/renovate.md)
- Renovate 配置：[`renovate.json`](renovate.json)
- 生产环境值（不入 git）：[`secrets/PROD-SERVER.md`](secrets/PROD-SERVER.md)

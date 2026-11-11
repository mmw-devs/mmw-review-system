# MMW 攻略审核与转换系统

`mmw-review-system` 面向 MMW 攻略组飞书组织内部人员，将飞书攻略保存为可校验的内部 JSON，经白名单校验、人工审核和必要的表现确认后，导出攻略站使用的 Astro 页面与图片包，并将文件保存到服务器本地。

**后续统一使用 H5 审核服务。** 服务直接调用飞书 API，支持用户授权、角色管理、本人任务审核及导出，无需安装飞书 CLI。导出后仍需网站维护者接入路由和副本目录、构建与发布。

当前运行能力、配置和验证范围统一以[H5 审核服务运行说明](docs/review-server.md)为准。旧 CLI 代码和[命令行说明](docs/converter-cli.md)仅保留作历史兼容参考。

## 当前能做什么

```text
飞书授权登录 → 提交文档地址、副本 ID 和名称
           ↓
读取全文和图片，保存快照，执行转换预检
           ↓
按副本基本信息和各 P 查看正文、作出审核决定
           ↓
修正必须修正项；满足审核门槛后确认表现并导出，或取消转换
           ↓
下载包含 .astro 页面、目录数据和引用图片的 tar 包
```

- 正文修改回飞书完成；当前按全文获取，不提供选区域或按阶段增量转换。
- 只维护攻略站格式白名单。无法解析的组件统一标为“必须修正”，需回飞书修改；可生成但有显示差异的内容标为“表现待确认”。没有丢弃内容后继续导出的入口。
- JSON 用于内部转换、校验和审核预览；新任务正式导出 `.astro` 页面及图片，不导出 XML。网站构建时再生成 HTML。
- 保留副本短 ID 和可选类型；游戏版本目录（例如地址中的 `/07/`）由网站侧处理。
- 每次获取使用独立任务目录，不覆盖已有正式产物，也不自动发布到网站。
- 审核与导出的具体条件见[使用流程](docs/review-server.md#2-启动与使用)。

## 启动与使用

使用 Node.js 24 或以上。项目没有第三方运行依赖，无需安装 npm 包。先按[一次性配置](docs/review-server.md#1-环境和一次性配置)在飞书后台设置应用，并在本地 `.env.local` 中填写配置。

配置完成后，在项目根目录启动服务：

```bash
npm start
```

服务监听本机回环地址；正式使用通过 HTTPS 反向代理访问。登录、角色授予、字段填写、分 P 审核和导出步骤见[服务运行说明](docs/review-server.md#2-启动与使用)。

## 生成的文件怎么用

**新任务下载的是攻略站文件包。** 包中 `pages/` 保存副本首页和各阶段的 `.astro` 页面，`public/review-assets/` 保存引用图片，`navigation.json` 提供待合并的目录数据，`README.md` 说明接入步骤。

网站维护者需确定游戏版本目录，将页面放到对应的 `src/pages/<版本>/<副本短 ID>/`，合并图片和副本目录数据，再在攻略站中构建、检查页面。目录数据不替代网站完整的副本配置，也不会自动覆盖现有文件。具体要求见[攻略站格式白名单](docs/feishu-authoring-and-conversion.md#22-攻略站实际格式与组件白名单)。

任务目录还包含候选稿、快照、报告和中间文件，供内部追溯；存储位置、恢复限制和文件用途统一见[存储与恢复](docs/review-server.md#4-存储与恢复)。当前不会自动清理这些文件。

`data/` 被 Git 忽略。自定义数据目录时也应保留相同的内部数据边界，不把整个任务目录公开。

## 当前限制

Schema 校验通过，表示字段和已检查的关联符合契约，不保证已正确识别全部业务含义，也不保证网页显示效果一致。

正文支持范围及尚未完成的联调见[服务能力边界](docs/review-server.md#5-api-读取与转换的能力边界)。[撰写和转换规则](docs/feishu-authoring-and-conversion.md)定义作者规范及目标转换规则。

## 文档导航

| 想了解的内容 | 文档 |
| --- | --- |
| 配置和使用审核服务、管理角色、理解输出文件 | [H5 服务运行说明](docs/review-server.md) |
| 平台最终服务谁、审核怎样进行、字段有什么含义 | [平台与字段设计](docs/strategy-review-platform.md) |
| 用户授权、直接读取与审核权限的设计 | [API 读取与基础权限方案](docs/feishu-api-and-permissions.md) |
| JSON 节点、必填字段和关联约束 | [JSON 结构](docs/strategy-json-format.md)、[JSON Schema](schemas/strategy.schema.json) |
| 飞书攻略怎样写、允许哪些颜色和表格、怎样映射到 Astro | [撰写规范、格式白名单与转换规则](docs/feishu-authoring-and-conversion.md) |
| 查看简短或全字段示例 | [示例说明](docs/examples/README.md) |
| 开发操作和敏感信息约束 | [AGENTS.md](AGENTS.md) |
| 未来生产部署的约束与待补全事项 | [部署手册（待生产验收）](docs/deployment.md) |
| 查阅旧 CLI 任务和命令 | [历史兼容说明](docs/converter-cli.md) |

## 开发与验证

```text
src/feishu-api.ts   官方 API 读取与文档块适配
src/review-*.ts     H5 页面、授权、权限、任务及服务入口
src/converter.ts    正文解析、结构转换和问题清单
src/astro-export.ts 内部 JSON 到攻略站页面与目录文件的转换
src/validation.ts   当前 Schema 子集校验及关联检查
src/cli.ts          保留的旧 CLI 入口
src/feishu.ts       旧 CLI 读取及共用的地址、资源辅助函数
tests/              自动化测试（含模拟飞书调用）
schemas/            攻略数据契约
docs/               使用说明、设计、示例与历史调查
```

在项目根目录运行 `npm test`，检查转换器和 H5 服务；旧 CLI 的离线回归仍保留。真实权限与网页效果需分别验证。

H5 服务测试为 `node tests/review.test.ts`；浏览器验证方法见运行说明。当前未配置独立类型检查、Lint 或构建命令。不要把尚未配置的命令标为已经通过，也不要为文档验证触发真实转换或生产部署。

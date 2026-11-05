# MMW 攻略审核与转换系统

`mmw-review-system` 面向 MMW 攻略组飞书组织内部人员，目标是将飞书攻略经过人工审核后，转换为可校验、可供网页渲染的 JSON，并将文件保存到服务器本地。

**后续统一使用 H5 审核服务。** 服务直接调用飞书 API，支持用户授权、角色管理、本人任务审核及导出，无需安装飞书 CLI。网站导入适配和发布尚未实现。

当前运行能力、配置和验证范围统一以[H5 审核服务运行说明](docs/review-server.md)为准。旧 CLI 代码和[命令行说明](docs/converter-cli.md)仅保留作历史兼容参考，不作为后续使用入口。

## 当前能做什么

```text
飞书授权登录 → 提交文档地址、副本 ID 和名称
           ↓
读取全文和图片，保存快照，执行转换预检
           ↓
按副本基本信息和各 P 查看正文、作出审核决定
           ↓
满足导出条件后，确认排除清单或取消转换
           ↓
下载包含 strategy.json 和引用图片的 tar 包
```

- 正文修改回飞书完成；当前按全文获取，不提供选区域或按阶段增量转换。
- 不支持的时间轴组件、音视频、附件和其他内容必须列出并明确处理，不默认丢弃。
- 输出只采用 JSON，不额外生成 Markdown 或 HTML。图片独立保存在本地，由 JSON 使用相对路径引用。
- 保留副本短 ID 和可选类型；游戏版本目录（例如地址中的 `/07/`）由网站侧处理。
- 每次获取使用独立任务目录，不覆盖已有正式产物，也不自动发布到网站。
- 导出成功不代表整篇人工审核通过；审核与导出的具体条件见[使用流程](docs/review-server.md#2-启动与使用)。

## 启动与使用

使用 Node.js 24 或以上。项目没有第三方运行依赖，无需安装 npm 包。先按[一次性配置](docs/review-server.md#1-环境和一次性配置)在飞书后台设置应用，并在本地 `.env.local` 中填写配置。

配置完成后，在项目根目录启动服务：

```bash
npm start
```

服务监听本机回环地址；正式使用通过 HTTPS 反向代理访问。登录、角色授予、字段填写、分 P 审核和导出步骤见[服务运行说明](docs/review-server.md#2-启动与使用)。仅启动本地进程不表示已完成飞书联调或生产部署。

## 生成的文件怎么用

**网站只需要 `strategy.json` 及其引用的 `assets/` 图片。** H5 下载包仅包含这些产物；网站仍需实现 JSON 导入和渲染适配。

任务目录还包含候选稿、快照、报告和中间文件，供内部追溯；存储位置、恢复限制和文件用途统一见[存储与恢复](docs/review-server.md#4-存储与恢复)。当前不会自动清理这些文件。

`data/` 被 Git 忽略。自定义数据目录时也应保留相同的内部数据边界，不把整个任务目录公开。

## 当前限制

Schema 校验通过，表示字段和已检查的关联符合契约，不保证已正确识别全部业务含义，也不保证网页显示效果一致。

正文支持范围及尚未完成的联调见[服务能力边界](docs/review-server.md#5-api-读取与转换的能力边界)。[撰写和转换规则](docs/feishu-authoring-and-conversion.md)定义作者规范及目标转换规则，不代表所有来源类型都已适配。

## 文档导航

| 想了解的内容 | 文档 |
| --- | --- |
| 配置和使用审核服务、管理角色、理解输出文件 | [H5 服务运行说明](docs/review-server.md) |
| 平台最终服务谁、审核怎样进行、字段有什么含义 | [平台与字段设计](docs/strategy-review-platform.md) |
| 用户授权、直接读取与审核权限的设计 | [API 读取与基础权限方案](docs/feishu-api-and-permissions.md) |
| JSON 节点、必填字段和关联约束 | [JSON 结构](docs/strategy-json-format.md)、[JSON Schema](schemas/strategy.schema.json) |
| 飞书攻略怎样写、旧文档怎样兼容 | [撰写规范与转换规则](docs/feishu-authoring-and-conversion.md) |
| 查看简短或全字段示例 | [示例说明](docs/examples/README.md) |
| 开发操作和敏感信息约束 | [AGENTS.md](AGENTS.md) |
| 未来生产部署的约束与待补全事项 | [部署手册（待生产验收）](docs/deployment.md) |
| 查阅旧 CLI 任务和命令 | [历史兼容说明](docs/converter-cli.md) |

## 开发与验证

```text
src/feishu-api.ts   官方 API 读取与文档块适配
src/review-*.ts     H5 页面、授权、权限、任务及服务入口
src/converter.ts    正文解析、结构转换和问题清单
src/validation.ts   当前 Schema 子集校验及关联检查
src/cli.ts          保留的旧 CLI 入口
src/feishu.ts       旧 CLI 读取及共用的地址、资源辅助函数
tests/              自动化测试（含模拟飞书调用）
schemas/            攻略数据契约
docs/               使用说明、设计、示例与历史调查
```

在项目根目录运行 `npm test`，检查转换器和 H5 服务；旧 CLI 的离线回归仍保留。模拟测试通过不等于真实权限或网页效果验证。

H5 服务测试为 `node tests/review.test.ts`；浏览器验证方法见运行说明。当前未配置独立类型检查、Lint 或构建命令。Node.js 直接执行 TypeScript 不等于完成类型检查。不要把尚未配置的命令标为已经通过，也不要为文档验证触发真实转换或生产部署。

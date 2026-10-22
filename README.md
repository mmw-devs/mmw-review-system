# MMW 攻略审核与转换系统

`mmw-review-system` 面向 MMW 攻略组飞书组织内部人员，目标是将飞书攻略经过人工审核后，转换为可校验、可供网页渲染的 JSON，并将文件保存到服务器本地。

**当前提供两个入口：原有 CLI 转换器，以及新增的 H5 审核服务。** H5 服务直接调用飞书 API，支持用户授权、角色管理、本人任务审核及导出；已通过模拟接口和本地浏览器验证，真实飞书组织联调尚未完成。CLI 转换成功仍不表示攻略已获人工审核通过；网站渲染适配和发布尚未实现。

网页服务的配置及支持范围见[H5 审核服务运行说明](docs/review-server.md)。下方快速使用说明针对原有 CLI 入口，两种读取路径的资源支持范围存在差异。

## 当前能做什么

```text
飞书文档地址 + 副本 ID、名称
           ↓
读取全文，保存快照，获取图片和简单电子表格
           ↓
识别阶段、机制、解法，检查结构和资源
           ↓
有不支持内容 → 列清单 → 操作者选择丢弃或取消
           ↓
校验通过并完成必要确认 → strategy.json + 引用的图片
```

- 正文修改回飞书完成；当前按全文获取，不提供选区域或按阶段增量转换。
- 不支持的时间轴组件、音视频、附件和其他内容必须列出并明确处理，不默认丢弃。
- 输出只采用 JSON，不额外生成 Markdown 或 HTML。图片独立保存在本地，由 JSON 使用相对路径引用。
- 保留副本短 ID 和可选类型；游戏版本目录（例如地址中的 `/07/`）由网站侧处理。
- 每次获取使用独立任务目录，不覆盖已有正式产物，也不自动发布到网站。

## 使用原有 CLI 入口

运行环境为 Node.js 24 或以上，以及已安装、登录且具有目标文档读取权限的飞书 CLI。项目目前没有第三方运行依赖，不需要为运行转换器安装 npm 包。

在项目根目录执行下面的命令，并替换尖括号中的值：

```bash
node src/cli.ts "<FEISHU_DOCUMENT_URL>" --duty-id "<DUTY_ID>" --duty-name "<DUTY_NAME>"
```

三个占位符都需要替换，连同 `<`、`>` 一起去掉，保留外面的双引号：

| 占位符 | 填写什么 | 示例 |
| --- | --- | --- |
| `<FEISHU_DOCUMENT_URL>` | 要转换的飞书攻略文档完整链接，从浏览器地址栏复制；不是文档标题 | `https://mmw-ffxiv.feishu.cn/wiki/ILFIward8isSn3kTjjJcZgLnn8f` |
| `<DUTY_ID>` | 副本的机器标识，写入 JSON 的 `duty.id`；与网站对接时使用网站约定的副本短 ID，不是飞书文档标识，也不含游戏版本或完整路径 | 网站地址 `/07/m5s` 对应填 `m5s`；本地恩欧测试可填 `demo-enou` |
| `<DUTY_NAME>` | 副本的可读名称，写入 JSON 的 `duty.name`；不是必须照抄的攻略文档标题 | `恩欧歼殛战` |

恩欧攻略的完整填写示例（在项目根目录运行）：

```bash
node src/cli.ts "https://mmw-ffxiv.feishu.cn/wiki/ILFIward8isSn3kTjjJcZgLnn8f" --duty-id "demo-enou" --duty-name "恩欧歼殛战"
```

`demo-enou` 仅用于本地测试，不是已确认的网站副本 ID；正式接入网站前需换成约定的 ID。攻略文档自身的标题由程序读取，保存到 `duty.title`。

支持 HTTPS 的飞书 `wiki`、`docx` 地址；例如副本短 ID 可写 `m5s`。默认按历史文档识别标题；规范模板文档可使用 `--profile standard`。只想查看转换问题、不生成正式文件时，加上 `--prepare`。

完整参数、Windows／WSL 用法、清单确认与故障处理见[命令行使用说明](docs/converter-cli.md)。

## 生成的文件怎么用

默认任务目录是 `data/runs/conversion-<RUN_ID>/`。**网站只需要 `strategy.json` 及其引用的 `assets/` 图片。**

`candidate.json` 是候选稿；`snapshot.json` 和 `report.json` 用于内部追溯；`strategy.pending.json` 与 `.bin` 是输出、下载过程中的中间文件。详细用途见[输出文件说明](docs/converter-cli.md#3-输出目录和文件用途)。当前不会自动清理这些文件。

`data/` 被 Git 忽略。自定义输出目录时也应保留相同的内部数据边界，不把整个任务目录公开。

## 当前限制

Schema 校验通过，表示字段和已检查的关联符合契约，不保证已正确识别全部业务含义，也不保证网页显示效果一致。

- 普通段落里的“解法1”“解法2”“推荐”保留为正文，不会自动生成解法选项；疑似方案提示尚未实现。
- 空机制标题可能仍出现在导航中；没有明确标题边界的末尾图组会归入当前区块，需要人工核对。
- 图片缩放、部分段落缩进和表格边框等可能没有完整还原。裁剪图片尚不转换。
- 同步块、复杂表格及未知组件的支持不完整；当前用户读取成功不代表服务器机器人身份也能读取。
- 网站导入适配与生产部署仍需建设；新增 H5 的真实授权、权限和复杂正文展示仍需联调。

具体范围以[命令行说明](docs/converter-cli.md#5-支持范围与已知限制)为准；[撰写和转换规则](docs/feishu-authoring-and-conversion.md)中的目标行为可能尚未全部实现。

## 文档导航

| 想了解的内容 | 文档 |
| --- | --- |
| 运行转换、处理错误、理解输出文件 | [命令行使用说明](docs/converter-cli.md) |
| 平台最终服务谁、审核怎样进行、字段有什么含义 | [平台与字段设计](docs/strategy-review-platform.md) |
| 配置无 CLI 的网页审核服务、管理角色与本人任务 | [H5 服务运行说明](docs/review-server.md) |
| 用户授权、直接读取与审核权限的设计 | [API 读取与基础权限方案](docs/feishu-api-and-permissions.md) |
| JSON 节点、必填字段和关联约束 | [JSON 结构](docs/strategy-json-format.md)、[JSON Schema](schemas/strategy.schema.json) |
| 飞书攻略怎样写、旧文档怎样兼容 | [撰写规范与转换规则](docs/feishu-authoring-and-conversion.md) |
| 查看简短或全字段示例 | [示例说明](docs/examples/README.md) |
| 开发操作和敏感信息约束 | [AGENTS.md](AGENTS.md) |
| 未来生产部署的约束与待补全事项 | [部署手册（待生产验收）](docs/deployment.md) |

## 开发与验证

```text
src/cli.ts          命令参数、预检、确认和本地输出
src/feishu.ts       原有飞书 CLI 调用、版本核对、表格和图片获取
src/feishu-api.ts   官方 API 读取与文档块适配
src/review-*.ts     H5 页面、授权、权限、任务及服务入口
src/converter.ts    正文解析、结构转换和问题清单
src/validation.ts   当前 Schema 子集校验及关联检查
tests/              自动化测试（含模拟飞书调用）
schemas/            攻略数据契约
docs/               使用说明、设计、示例与历史调查
```

在项目根目录运行 `node tests/converter.test.ts` 或 `npm test`。测试包括内容转换、关联检查、模拟完整命令链和确认摘要约束；模拟通过不等于真实权限或网页效果验证。

H5 服务测试为 `node tests/review.test.ts`；浏览器验证方法见运行说明。当前未配置独立类型检查、Lint 或构建命令。Node.js 直接执行 TypeScript 不等于完成类型检查。不要把尚未配置的命令标为已经通过，也不要为文档验证触发真实转换或生产部署。

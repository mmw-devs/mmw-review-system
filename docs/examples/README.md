# 攻略 JSON 示例

当前设计见[平台与字段说明](../strategy-review-platform.md)和[具体 JSON 结构](../strategy-json-format.md)，对应 [JSON Schema](../../schemas/strategy.schema.json)。

| 文件 | 用途 |
| --- | --- |
| [enou-strategy.v0.1.json](enou-strategy.v0.1.json) | 简短示例：恩欧 P1·无之膨胀节选，展示目录、机制、解法、职能说明 |
| [strategy-all-fields.v0.1.json](strategy-all-fields.v0.1.json) | 全字段示例：包含所有可选字段和正文类型，用于查看格式，不作为正式攻略 |
| [历史读取试验](../investigations/fixtures/feishu-read-probe.v0.1.json) | 验证表格和时间轴可读的历史样例；初版已排除时间轴组件，不作为当前导出样例 |
| [enou-field-example.json](enou-field-example.json) | 早期字段讨论示例，保留作参考；不符合当前三部分设计，不使用当前 Schema 校验 |

恩欧示例使用 `demo-enou` 演示副本 ID，它不是已确认的网站 ID。全字段示例的英文、日文、Beta、默认解法、宏、表格和资源路径等为演示值，不是从飞书原文确认的事实。`demo-category` 也不是已确认的业务分类枚举。全字段示例中的阶段地址仅演示网站接入时可填写的可选字段，不要求转换程序决定游戏版本目录。

示例未包含实际图片文件；当前全字段示例不含视频、音频、附件媒体块或未解析占位。普通视频链接只代表链接，不代表嵌入播放器。JSON 结构合法不代表文件可以离线完整展示。

实测节选保留了单元格值和时间轴条目，未保留表格边框、行高、竖直对齐及原时间轴组件布局。它的 ID 为演示值；详情见[读取调查](../investigations/2026-10-18-feishu-reading.md)。

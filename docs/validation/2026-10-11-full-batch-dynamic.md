# 九平台动态图文一次分发验证（2026-10-11）

> 路径迁移说明（2026-10-12）：Skill 现位于 `skills/qiushui-fast-publish/`，测试素材按场景存放于 `tests/fixtures/`，测试命令为 `python3 -m unittest discover -s tests -p 'test_*.py'`。下文的历史命令和旧路径保留执行时记录，文档链接已指向现位置。

## 内容与范围

在本机用 `.multipost-local/fullrun-2026-10-11/` 中同一份标题、正文、标签和 `test-card.png`，执行一次 `run-config`。按 `skills/multipost-publish/config/platforms.yaml` 顺序投递九个平台。未请求或点击公开发布。标签通过正文里的 `#链路验证#` 文本呈现，未验证各平台原生话题选择。

## 平台回执

| 平台 | 任务 ID | 最终状态 | 图片 | 说明 |
| --- | --- | --- | --- | --- |
| 小红书 | `56410b19-1cd0-4ccc-b058-ed8ab42f18c8` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |
| 微信公众号 | `e25c69c6-a87d-482c-a7ff-989fb29ffb41` | `draft_saved/DRAFT_ID_CONFIRMED` | 1 | 草稿 ID `100001922`，不是公开发布 |
| 微信视频号 | `2f130b1b-89df-4c64-a04e-100ee630e14c` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |
| 抖音 | `3d3f751a-13b0-4647-89c3-7ce233a4dbbb` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |
| 今日头条 | `e4b09839-7d89-4620-9804-ce8306b00503` | `filled/FIELDS_VERIFIED` | 1 | 原任务恢复后完成 |
| 即刻 | `a9e44c06-fc6b-410e-887e-65b76a2c4b2d` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |
| 知识星球 | `46b1abf1-d40b-4176-b08f-df08c5a99c27` | `filled/FIELDS_VERIFIED` | 1 | 目标 `AI咖啡馆`；原任务恢复后完成 |
| 脉脉 | `80ea0909-512b-41a1-9254-4698f780e2b9` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |
| X | `7279a72c-f73c-4891-9bf2-93afb7bace27` | `filled/FIELDS_VERIFIED` | 1 | 编辑页已填写 |

第一次 `run-config` 返回 7/9 完成，头条和知识星球遇到前一轮测试留下的正文，分别停在 `EDITOR_NOT_EMPTY`。没有重提内容包。头条原任务只读检查确认旧正文与 1 张图，随后使用旧 `filled` 任务 `0329f036-de36-43f3-9b16-dfcf8b424757` 核对来源并替换正文，保留原图。知识星球原任务只读检查确认旧正文、当前图片 0 张；使用旧 `filled` 任务 `3387a74a-0c82-4033-9971-7fe28cca1a60` 核对来源后替换正文并补传图片。两个原任务最终回执都是 `filled/FIELDS_VERIFIED`。

`filled` 仅说明插件在当前编辑器核对到期望字段与图片，不代表平台已暂存草稿或公开发布。公众号草稿具有平台返回的草稿 ID；九个平台均无公开发布回执。本机编辑器内容是否在刷新页面后保留，不能从本轮 `filled` 回执推断。

校验：`python3 -m unittest discover -s skills/multipost-publish/scripts -p 'test_*.py'` 18 项通过，`pnpm exec tsc --noEmit` 通过，`pnpm dev --no-cs-reload` 编译完成。

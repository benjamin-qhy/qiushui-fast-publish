# 纯文字动态分发验证（2026-10-11）

> 路径迁移说明（2026-10-12）：Skill 现位于 `skills/qiushui-fast-publish/`，测试素材按场景存放于 `tests/fixtures/`，测试命令为 `python3 -m unittest discover -s tests -p 'test_*.py'`。下文的历史命令和旧路径保留执行时记录，文档链接已指向现位置。

## 输入与结果语义

同一份本机内容包 `.multipost-local/textonly-2026-10-11/` 使用 `type: DYNAMIC`、无图片、`bodyFile`、独立标题“此标题不应发送”和标签“纯文字联调”。预检生成的任务数据 `title` 为空，标签以 `#纯文字联调` 文本附于正文末尾。所有任务目标动作是 `prepare`，没有点击公开发布。`filled` 仅代表当前编辑器核对通过，不保证刷新后仍存在。

## 逐站真实验证

| 平台 | 首次任务 ID | 结果 | 备注 |
| --- | --- | --- | --- |
| X | `f36c8351-a3e5-4719-aa10-0ea1bdccbf31` | `filled/FIELDS_VERIFIED` | 正文匹配，图片 0 |
| 即刻 | `4eb1b097-4032-454f-bf3b-7b386a6c6d8c` | `filled/FIELDS_VERIFIED` | 正文匹配，图片 0 |
| 脉脉 | `1ef80619-5800-429c-8121-3bff69f9f047` | `filled/FIELDS_VERIFIED` | 正文匹配，标题为空，图片 0 |
| 知识星球 | `a9756feb-9c83-43ad-9082-6ad5d5697295` | `filled/FIELDS_VERIFIED` | 目标星球“AI咖啡馆”；旧测试正文匹配且旧图片 0 后，在原任务中更换为纯文字 |
| 今日头条 | `c4d4aa78-d4b0-463a-9715-a96386c428da` | `filled/FIELDS_VERIFIED` | 旧测试正文及图片核对后，在原任务中移除旧图并填入纯文字 |

头条和知识星球第一次尝试均因上一轮编辑器内容而安全停止；没有重新提交同一任务。恢复动作先核对先前 `filled` 来源任务和页面内容，不覆盖未知内容。知识星球纯文字最终正文与图片 0 张一致；头条纯文字最终正文与图片 0 张一致。

## 一次批量调用

随后用同一内容包执行一次 `run-config`，进程退出码为 0，五个目标任务均为 `filled/FIELDS_VERIFIED`，每个回执图片数均为 0：

| 平台 | 批量任务 ID |
| --- | --- |
| 今日头条 | `e605849e-5168-41fe-9290-4512db2cca96` |
| 即刻 | `7dc4f3e9-1392-49cb-a0c6-6a9568fa3af5` |
| 知识星球 | `b8b2e93c-3f29-454c-b574-f2ed70c44e85` |
| 脉脉 | `60561fe5-14ef-4b26-a1ed-02312ff23f3d` |
| X | `8024f992-04c4-4fa5-a0e9-f682ba9b4514` |

本次批量调用针对相同文本；头条与知识星球识别编辑器已包含期望内容后只读核对，属于幂等确认，不是第二次重新填写。小红书、公众号、视频号和抖音在任务创建前被跳过，分别给出当前入口要求图片或无图未验证的原因。公众号的文字群发属于不同流程，没有混入本次图文草稿动作。

验证门槛：`python3 -m unittest discover -s skills/multipost-publish/scripts -p 'test_*.py'` 19 项通过，`pnpm exec tsc --noEmit` 通过，`pnpm dev --no-cs-reload` 编译完成。真实验证仅到编辑器填写与核对，没有草稿保存或公开发布。

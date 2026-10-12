# 当前本机动态发布流程概览

这两张图描述 `skills/qiushui-fast-publish` 经本机任务服务交给浏览器扩展的 `DYNAMIC` 流程，依据当前 `main` 的实现绘制。它们不表示旧的网页 `PUBLISH_NOW` 弹窗流程，也不覆盖文章、视频或播客。

- [图文发布流程](dynamic-image-publishing.svg)：默认配置的九个平台；小红书、抖音、头条、即刻、知识星球、脉脉和 X 以 `prepare` 为目标，公众号以 `save_draft` 为目标，视频号以 `publish` 为目标。`filled` 只说明当前页面字段和图片核对通过。视频号点击发表后若没有作品证据，结果仍为不确定。
- [纯文字发布流程](dynamic-text-only-publishing.svg)：只对 `textVerified` 中的五个平台执行 `prepare`；其余四个平台说明跳过原因。独立标题不发送，标签作为正文文本附加，结果须核对正文与图片数零。公众号纯文字群发属于另一流程。

两图中的失败、暂停与未知状态均应保留原任务 ID；涉及平台动作的未知结果先核查，不自动重新提交。Mermaid 源文件可直接修改，`.excalidraw` 文件可在 Excalidraw 中编辑。

主要依据：[Skill 运行步骤](../skills/qiushui-fast-publish/SKILL.md)、[平台配置](../skills/qiushui-fast-publish/config/platforms.yaml)、[内容目录规则](../skills/qiushui-fast-publish/references/content.md)、[本机任务执行器](../src/background/services/local-task.ts)、[纯文字验收记录](../docs/validation/2026-10-11-text-only-dynamic.md)。

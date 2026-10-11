# 微信公众号文章草稿：本机插件真实验证

日期：2026-10-11。用户先在当前 Chrome 中登录微信公众号后台。测试动作明确指定 `save_draft`，未执行公众号公开群发。

## 输入与执行

- 内容包：[weixin-article-smoke](../../skills/multipost-publish/assets/weixin-article-smoke/content.yaml)，包含 HTML 正文与封面图片。
- Agent 仅运行 `python3 skills/multipost-publish/scripts/multipost.py run skills/multipost-publish/assets/weixin-article-smoke --action save_draft --timeout 130`。
- MultiPost 扩展后台自动领取任务，打开公众号后台，上传封面、创建文章草稿并打开平台返回的编辑页。
- 任务 ID：`385fbcdd-acbb-4353-9b78-6ccccfb36655`；插件标签页 ID：`875191484`。

## 回执与边界

平台创建接口返回草稿文章 ID `100001908`；插件打开同一 ID 的编辑页后回传 `draft_saved / DRAFT_ID_CONFIRMED`。创建到回执约 39 秒。完整脱敏回执见[JSON](2026-10-11-weixin-article-draft-receipt.json)。

此证据确认草稿创建，未验证正文在编辑器中的逐字段呈现，也未确认公众号公开发布。浏览器观察工具本次未能读取该标签页，因此记录以平台创建接口的文章 ID 和插件核对后的编辑页地址为准。若后续需要核查内容细节，应在公众号草稿箱打开此 ID 对照标题、正文和封面；不要重复提交原内容包。

Python 13 项测试、TypeScript 类型检查和改动文件 Biome 检查通过。测试代码保留其他动作的显式拒绝，并禁止公众号草稿任务自动恢复创建，避免结果不确定时重复创建。

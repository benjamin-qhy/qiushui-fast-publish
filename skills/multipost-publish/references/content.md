# 内容目录

一个目录包含 `content.yaml` 或 `content.json` 和所引用的正文、图片。脚本接受两种等价的元数据格式；YAML 读取依赖 scripts/requirements.txt，JSON 使用 Python 标准库。

```yaml
type: DYNAMIC
title: 本机链路验证
bodyFile: body.md
images:
  - test-card.png
tags: [链路测试]
overrides:
  DYNAMIC_REDNOTE:
    title: 本机图文验证
```

正文也可以放在 `content` 字段中；同时提供时 `bodyFile` 优先。相对路径经真实路径解析后必须位于内容目录内。逐平台字段覆盖在校验前合并，不能改变类型或增加目标平台。

纯文字动态可省略 `images` 或设为 `[]`。Skill 只发送 `content`／`bodyFile` 正文，随后把独立 `tags` 转为 `#标签` 文本附在末尾；独立 `title` 即使提供也不会发送。无图内容按 `textVerified` 自动筛选，当前只选今日头条、即刻、知识星球、脉脉和 X；小红书、公众号、视频号、抖音会报告跳过原因。纯文字批量预检仍受各平台字数限制，X 最多 280 字符。目标列表为空时停止，不创建任务。例子：

```yaml
type: DYNAMIC
bodyFile: body.md
tags: [纯文字]
images: []
```

本期默认配置包含小红书、微信公众号、微信视频号、抖音、今日头条、即刻、知识星球、脉脉和 X 的动态图文。公众号目标动作是 `save_draft`；视频号是先填写核对、再点击发表的 `publish`；其余平台为 `prepare`。标题、正文、标签和图片按平台分别预检；X 的合并文本最多 280 字符、1–4 张图片，知识星球必须指定目标星球。预检完成后记录素材哈希，认领时重新核对，发生变化就停止。分类、原创、合集等未适配字段不应宣称已经填写。视频号发表后的作品结果尚未取得真实验证，若无平台作品证据必须报告结果不确定。

公众号文章保存草稿使用 `type: ARTICLE`、`title`、`digest`、`htmlFile` 和 `cover`。`htmlFile` 是内容目录内的 HTML 正文文件，`cover` 是 PNG、JPEG 或 WebP 封面。调用时明确指定 `--action save_draft`；默认准备动作不会自动创建草稿。示例见 `../assets/weixin-article-smoke/`。当前不处理 HTML 内嵌的本地图片，正文需使用纯文本及基础 HTML；脚本和 iframe 会被拒绝。

视频号视频准备使用 `type: VIDEO`、`title`、`content`（或 `bodyFile`）和 `video`。测试视频须为内容目录内不超过 100 MiB 的 MP4；调用时使用 `--action prepare --timeout 240`。示例见 `../assets/weixin-video-smoke/`。该适配正等待真实登录现场验收，未验证草稿保存或发表。

四种类型的平台配置格式见 `../config/platforms.yaml`，其中 `actions` 指定各平台默认目标动作，`targets.DYNAMIC_ZSXQ` 指定知识星球的目标星球。内容包也可通过 `overrides.DYNAMIC_ZSXQ.targetSphere` 指定一次任务的目标。`plan-config` 与 `run-config` 会按配置顺序逐个平台预检／执行并返回独立任务 ID。本期九个平台的动态图文已分别取得真实页面回执；公众号文章及视频号视频不在默认配置。其他类型或动作明确报告尚未验证，后续逐类扩展。

# 测试代码与素材

测试目录独立于 `skills/qiushui-fast-publish/`。安装或移植 Skill 时只携带 Skill 目录；测试素材仅供仓库开发和验收使用，用户内容包另行准备。

## 目录

```text
tests/
├── test_multipost.py
└── fixtures/
    ├── dynamic/
    │   ├── image-card/              # 通用动态卡片（单图）
    │   ├── text-only/               # 无图正文和标签
    │   └── image-card-rednote/      # 早期小红书专用单图内容
    ├── article/
    │   └── weixin-draft/            # 公众号 HTML 正文与封面
    └── video/
        └── weixinchannel-prepare/   # 视频号视频准备素材
```

`image-card` 与 `image-card-rednote` 的图片相同，但标题、正文和标签不同，保留独立测试场景。`text-only` 仅收录可复用输入，其中独立标题“此标题不应发送”用于核对无图模式忽略标题；不包含历史任务、凭证或回执。后续视频等测试在对应内容类型下添加场景目录。

## 自动化测试

在仓库根目录、安装了 Skill 依赖的 Python 环境中执行：

```bash
python3 -m pip install -r skills/qiushui-fast-publish/scripts/requirements.txt
python3 -m unittest discover -s tests -p 'test_*.py'
```

现有测试验证内容预检、平台配置、素材校验、配对与任务协议，使用临时目录及本机测试服务，不向真实平台发布。

## 素材预检

以下命令只做预检，不创建平台任务：

```bash
python3 skills/qiushui-fast-publish/scripts/multipost.py plan-config tests/fixtures/dynamic/image-card
python3 skills/qiushui-fast-publish/scripts/multipost.py plan-config tests/fixtures/dynamic/text-only
```

文章和视频未加入 Skill 默认平台配置；其预检由自动化测试使用临时的显式平台配置验证，直接使用默认配置会被拒绝。

真实平台验收须先核对账号、目标平台和动作。素材存在或预检通过不代表平台动作已验证；现有验收证据见 [docs/validation](../docs/README.md)。历史记录中的旧路径保持当时执行语义，链接已更新。

## 原素材路径对照

| 原 Skill 内路径 | 当前仓库路径 |
| --- | --- |
| `assets/dynamic-smoke/` | `tests/fixtures/dynamic/image-card/` |
| `assets/rednote-smoke/` | `tests/fixtures/dynamic/image-card-rednote/` |
| `assets/weixin-article-smoke/` | `tests/fixtures/article/weixin-draft/` |
| `assets/weixin-video-smoke/` | `tests/fixtures/video/weixinchannel-prepare/` |

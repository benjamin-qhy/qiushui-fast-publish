# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project Overview

MultiPost is a browser extension that enables one-click content publishing to multiple social media platforms. Built with Plasmo framework, it supports 30+ platforms including Zhihu, Weibo, Xiaohongshu, Bilibili, X, Instagram, and more.

## Development Commands

```bash
pnpm dev          # Start development server with hot reload
pnpm build        # Build and package extension for production
pnpm lint         # Run ESLint
pnpm lint:fix     # Auto-fix ESLint issues
```

**Note:** Do not run `pnpm build` for testing during development. Use `pnpm dev` instead.

## Architecture

### Content Types

The extension handles four content types, each with platform-specific implementations:

- **Dynamic** (`src/sync/dynamic/`): Short-form posts (text, images)
- **Article** (`src/sync/article/`): Long-form articles with HTML/Markdown
- **Video** (`src/sync/video/`): Video uploads with metadata
- **Podcast** (`src/sync/podcast/`): Audio content

### Core Data Structures (`src/sync/common.ts`)

- `SyncData`: Main payload containing platforms list, content data, and auto-publish flag
- `PlatformInfo`: Platform configuration including inject URL and function
- `DynamicData`, `ArticleData`, `VideoData`, `PodcastData`: Content-specific interfaces

### Platform Integration Pattern

Each platform has an `injectFunction` that:
1. Opens the platform's publishing page (`injectUrl`)
2. Uses DOM manipulation to fill in content
3. Handles file uploads and form submissions

Platform maps: `DynamicInfoMap`, `ArticleInfoMap`, `VideoInfoMap`, `PodcastInfoMap`

### Extension Components

- **Background** (`src/background/`): Service worker handling message routing, tab management, API services
- **Popup** (`src/popup/`): Extension popup UI
- **Sidepanel** (`src/sidepanel/`): Side panel interface
- **Content Scripts** (`src/contents/`): Page helpers and scrapers
- **Tabs** (`src/tabs/`): Standalone pages (publish, refresh-accounts, trust-domain)

### Message Flow

Background script (`src/background/index.ts`) routes messages:
- `MULTIPOST_EXTENSION_PUBLISH`: Opens publish popup
- `MULTIPOST_EXTENSION_PUBLISH_NOW`: Creates tabs and injects scripts
- `MULTIPOST_EXTENSION_PLATFORMS`: Returns available platforms
- `MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS`: Returns logged-in account info

## Tech Stack

- **Framework**: Plasmo 0.90.5 (Manifest V3)
- **UI**: HeroUI + Tailwind CSS
- **Icons**: lucide-react (prefer over @iconify/react)
- **Storage**: @plasmohq/storage

## Code Conventions

### TypeScript
- Use interfaces over types
- Use maps instead of enums
- Use functional components with TypeScript interfaces
- Naming: PascalCase for components/interfaces, camelCase for functions/variables, SNAKE_CASE for constants

### Styling
- Mobile-first responsive design
- Use `bg-background` and `text-foreground` for theme support
- Use semantic color variables (e.g., `bg-primary-600` not `bg-blue-600`)
- Use `gap` for spacing instead of margins

### i18n
- Store translations in `/locales/[locale]/messages.json`
- Use `chrome.i18n.getMessage('key')` for all UI text
- Default locale: `zh_CN`
- Console.log statements do not need i18n

## Adding a New Platform

1. Create platform handler in appropriate directory (`src/sync/dynamic/`, `src/sync/article/`, etc.)
2. Export inject function that manipulates the platform's DOM
3. Add entry to corresponding InfoMap (e.g., `DynamicInfoMap` in `src/sync/dynamic.ts`)
4. Add account getter in `src/sync/account/` if platform requires login detection
5. Add i18n keys for platform name

## Agent skills

以下配置直接维护在本文件中。使用工程技能时，从这里读取问题跟踪、分流标签和领域文档规则。

### Issue tracker

任务和规格存放于 `benjamin-qhy/qiushui-content-publish` 的 GitHub Issues。
使用 `gh` CLI，并显式指定 `--repo benjamin-qhy/qiushui-content-publish`，避免操作 `upstream` 仓库。

- 创建：`gh issue create --repo benjamin-qhy/qiushui-content-publish --title "..." --body-file <文件>`
- 读取：`gh issue view <编号> --repo benjamin-qhy/qiushui-content-publish --comments`
- 列表：`gh issue list --repo benjamin-qhy/qiushui-content-publish --state open --json number,title,body,labels`
- 评论：`gh issue comment <编号> --repo benjamin-qhy/qiushui-content-publish --body-file <文件>`
- 添加标签：`gh issue edit <编号> --repo benjamin-qhy/qiushui-content-publish --add-label "..."`
- 移除标签：`gh issue edit <编号> --repo benjamin-qhy/qiushui-content-publish --remove-label "..."`
- 关闭：`gh issue close <编号> --repo benjamin-qhy/qiushui-content-publish --comment "..."`

多行正文先写入临时文件，再通过 `--body-file` 提交。
技能要求 “publish to the issue tracker” 时，创建 GitHub Issue；要求 “fetch the relevant ticket” 时，读取对应 Issue 及其评论。

**PRs as a request surface: no.**

访问海外平台遇到连接问题时，可先设置代理后重试：

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

### Triage labels

| 技能角色 | 仓库标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交给代理执行 |
| `ready-for-human` | `ready-for-human` | 需要人工实施 |
| `wontfix` | `wontfix` | 不予处理 |

技能提到分流角色时，使用对应仓库标签。

### Domain docs

采用 **single-context** 布局：根目录 `GLOSSARY.md` 与 `docs/adr/`。

探索代码前，阅读根目录 `GLOSSARY.md`，以及 `docs/adr/` 中与当前工作相关的架构决策。
如果存在根目录 `GLOSSARY-MAP.md`，按其索引阅读相关领域词汇表；同时检查相关上下文的 `src/<context>/docs/adr/`。

这些文档不存在时，直接继续；由 `domain-modeling` 技能在术语或决策明确后按需创建。

Issue 标题、重构建议、假设和测试名称应使用词汇表定义的术语。
遇到未定义概念时，先判断是否确有缺口，再记录给 `domain-modeling`。
建议与现有 ADR 冲突时，明确指出对应 ADR 和重新讨论的理由。

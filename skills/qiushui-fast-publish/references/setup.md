# 一次性安装与移植

本机服务与CLI使用TypeScript和Bun，浏览器操作由FastPublish扩展执行。日常运行不依赖Python，也不需要Codex浏览器工具。

## 安装和运行

1. 使用Bun 1.3.14或经兼容验证的版本。开发扩展继续使用仓库原有pnpm/Plasmo流程；本次迁移不更换扩展的包管理器或构建工具。
2. 若需编译扩展，使用pnpm dev --no-cs-reload；编译完成后停止热更新再验收。加载原开发扩展并保留既有配对。
3. 每次调用前显式设置已有私有状态目录：

   ```sh
   export MULTIPOST_STATE_DIR="<现有私有状态目录绝对路径>"
   bun <skill>/scripts/multipost.ts serve
   ```

4. 新安装时使用pair配对；已有配对时直接connection，不重新配对。凭据在私有状态目录保存，不写入聊天或普通文档。不要同时启动Python和Bun服务写同一状态目录。
5. 查询连接：`bun <skill>/scripts/multipost.ts connection`。扩展最长约30秒轮询一次，最近心跳超过75秒视为离线。

`serve --read-only`仅用于迁移验收：允许账号任务与其领取/回执，阻止上传、草稿保存、发表和恢复任务，并跳过历史排队的非账号任务。此模式不能执行日常发布；后续获准执行发布时再以正常模式启动。

## CLI与接口兼容

命令、任务JSON、配对executor.json和任务ID保持兼容。CLI从server.json读取本机服务地址与管理员凭据，服务仍监听127.0.0.1:2663。/next与/result由扩展调用，Agent不代替扩展执行浏览器动作。

- connection、account：连接与只读账号核验。
- generate-video-task、plan-video-task、run-video-task：[明确视频任务接口](publication.md)。
- plan、run、plan-config、run-config：保留旧content.json/content.yaml协议。
- status、wait、resume、publish、publish-resume、reconcile、save-video-draft、reconcile-video-draft、inspect-video-drafts：保持原任务与恢复保护。

移植时保留scripts/multipost.ts、scripts/lib/、scripts/bridge.html、scripts/pair.html、config和references。运行代码只使用Bun及其内置Node兼容API，无需在部署副本安装Python或npm运行依赖。仓库内类型检查使用@types/bun，运行`pnpm typecheck:publish`；Bun测试为`pnpm test:publish`。

## 备份与回退

迁移前Python代码与原测试已备份到原私有状态目录backups/python-before-bun-<时间>/，附SHA256清单。原.py文件也保留，供测试对照；requirements.txt只供Python回归/回退使用。

需要回退时先停止Bun服务，确认无任务正在执行，再用原状态目录启动原Python服务。未知结果保持原任务，不因回退重新上传或提交。状态目录和配对不得用空目录替换。

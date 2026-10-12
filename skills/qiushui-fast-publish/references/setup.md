# 一次性安装与移植

运行前需要同一台电脑上的本机服务、已配对的 FastPublish 扩展及平台会话。浏览器由用户正常打开，Agent 无需浏览器或电脑控制工具。

## 从仓库安装

以下命令在仓库根目录执行。本机 CLI 保持 Python 实现，Skill 名称为 `qiushui-fast-publish`。

1. 执行 `pnpm install` 和 `pnpm dev --no-cs-reload`。在 Chrome 扩展管理页开启开发者模式，加载 `build/chrome-mv3-dev`。编译完成后，验收前停止热更新，以免平台编辑页丢失现场。
2. 创建并激活 Python 虚拟环境（下列激活命令适用于 macOS/Linux），安装 YAML 依赖：

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   python3 -m pip install -r skills/qiushui-fast-publish/scripts/requirements.txt
   ```

3. 在可持续运行的终端启动本机服务：

   ```bash
   python3 skills/qiushui-fast-publish/scripts/multipost.py serve
   ```

4. 在另一个终端进入仓库根目录并激活同一环境，执行配对：

   ```bash
   source .venv/bin/activate
   python3 skills/qiushui-fast-publish/scripts/multipost.py pair
   ```

   在安装 FastPublish 的浏览器打开返回的配对 URL，点击配对按钮。这是安装配置，日常任务不重复配对。凭证五分钟有效且仅可使用一次。配对后可关闭配对／桥接页；扩展后台通过 Chrome alarms 自动领取任务。

5. 查询连接状态：

   ```bash
   python3 skills/qiushui-fast-publish/scripts/multipost.py connection
   ```

`connection` 返回 `paired`、`online`、扩展 ID 和最近心跳时间。浏览器关闭、插件停用或本机服务不可达时，不会有新心跳；最近心跳超过 75 秒后判为离线，`run` 拒绝创建新任务并说明原因。在心跳尚未过期的窗口提交也可能等待超时，此时查询原任务，不重复提交。恢复浏览器后等待约 30 秒即可再次查询。

## 跨 Agent 移植

将 `skills/qiushui-fast-publish/` 作为完整 Skill 目录交给另一 Agent 系统时，保留 `SKILL.md`、`scripts/`、`config/`、`references/`。测试代码和素材位于仓库 `tests/`，不随 Skill 安装；用户内容包单独准备。移植后命令中的脚本路径应改为实际 Skill 目录。Agent 可调用同一个 CLI 或下面的本机 API；若 Skill 副本位置不同，设置 `MULTIPOST_STATE_DIR` 为已运行服务的私有状态目录绝对路径，并使用安装了 `scripts/requirements.txt` 依赖的 Python 环境。改名不迁移 `.multipost-local/`，也不改变现有配对凭证和任务格式。换电脑时重新安装服务、配对扩展并登录账号；这里的 localhost 指运行插件的电脑，不是远程 Agent 的电脑。

## 本机 API

服务仅监听 `127.0.0.1:2663`。Agent 从私有状态目录的 `server.json` 读取 CLI token，通过 `Authorization: Bearer <token>` 调用，凭证不写入报告或聊天。

- `GET /connection`：执行器配对／在线状态。
- `POST /submit`：`{"folder":"绝对内容目录", "action":"prepare", "config":"可选配置文件", "platforms":"可选逗号分隔子集"}`；返回任务 ID 与排队回执。
- `GET /status?taskId=<id>`：原任务实际回执。
- `POST /resume`：`{"taskId":"原任务ID"}`；同一任务重新排队，插件核查原页面。头条与知识星球的已知旧测试内容可附 `"replaceFrom":"来源任务ID"`；服务校验来源平台、目标与图片 SHA-256，扩展再核对原页面旧正文与图片数量后更换。
- `POST /publish`：`{"taskId":"已填写的原任务ID"}`；在已有页面创建一次关联的公开发布任务，由扩展核对内容后操作平台发布按钮。仅在用户已授权具体内容与平台时调用。
- `POST /reconcile`：`{"taskId":"公开发布任务ID"}`；仅对结果未知或待审核的原任务做只读核对，不重复点击发布。

`/next` 和 `/result` 属于插件执行协议，Agent 不代替插件调用。执行器 token 与 Agent CLI token 分离，配对信息在服务重启后保留；任务认领受串行锁保护，已认领任务不自动重复投递。上述运行链路只需要本机服务与 FastPublish 扩展，不需要 ChatGPT/Codex 的浏览器控制或电脑控制权限。

单个 `/submit` 任务只接受一个平台。需要按配置发送多个平台时，用 `plan-config` 先完成全部预检，再用 `run-config` 顺序提交；每个平台有独立任务 ID 和回执。配置里的 `actions` 为各平台指定目标动作，`targets` 为知识星球指定目标星球。某个平台执行失败时，保留它的原任务供核查，其他平台独立报告；仍在执行的任务不会与下一项重叠。

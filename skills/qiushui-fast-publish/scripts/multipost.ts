#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { readAccountInput, readAccounts, resolveAccount } from "./lib/accounts";
import { ApiError, Client } from "./lib/client";
import {
  DEFAULT_CONFIG,
  type JsonRecord,
  ROOT,
  TERMINAL,
  VIDEO,
  atomic,
  check,
  equal,
  readJson,
  readMetadata,
  uuid,
} from "./lib/core";
import { configuredPlans, preflight, textSkips } from "./lib/preflight";
import * as publication from "./lib/publication";
import { startServer } from "./lib/server";
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const state = path.resolve(process.env.MULTIPOST_STATE_DIR ?? path.join(ROOT, ".multipost-local"));
  const client = new Client(state);
  let command = "";
  const print = (v: any) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        action: { type: "string" },
        platforms: { type: "string" },
        platform: { type: "string" },
        input: { type: "string" },
        account: { type: "string" },
        "source-root": { type: "string" },
        timeout: { type: "string" },
        "allow-publish": { type: "boolean" },
        "replace-from": { type: "string" },
        "repair-rednote-host-noop": { type: "boolean" },
        "retry-after-title-repair": { type: "boolean" },
        view: { type: "string" },
        port: { type: "string" },
        "read-only": { type: "boolean" },
        "draft-only": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    const { values: v, positionals: pos } = parsed;
    command = pos[0] ?? "";
    if (v.help || !command) {
      print(
        "FastPublish Bun CLI: resolve-account, generate-video-task, plan-video-task, run-video-task, serve, connection, account, plan, submit, run, plan-config, run-config, status, wait, resume, publish, publish-resume, reconcile, save-video-draft, reconcile-video-draft, inspect-video-drafts",
      );
      return 0;
    }
    const config = v.config ? path.resolve(v.config) : DEFAULT_CONFIG;
    const action = v.action ?? "prepare";
    check(["prepare", "save_draft", "publish"].includes(action), "目标动作无效");
    const timeout =
      v.timeout === undefined
        ? ["run-video-task"].includes(command)
          ? 900
          : ["account"].includes(command)
            ? 90
            : 130
        : Number(v.timeout);
    check(Number.isFinite(timeout) && timeout >= 0, "timeout须为非负秒数");
    if (command === "serve") {
      const port = v.port === undefined ? 2663 : Number(v.port);
      check(Number.isInteger(port) && port >= 0 && port <= 65535, "port无效");
      const service = startServer({
        state,
        port,
        readOnly: v["read-only"] || process.env.FASTPUBLISH_READ_ONLY === "1",
        draftOnly: v["draft-only"] === true,
      });
      print(
        `FastPublish Bun API 已启动：http://localhost:${service.server.port}（${service.server.url.hostname}，只读=${!!(v["read-only"] || process.env.FASTPUBLISH_READ_ONLY === "1")}）`,
      );
      const stop = () => {
        service.server.stop(true);
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return 0;
    }
    if (command === "resolve-account") {
      check(v.input, "须指定 --input - 接收 Agent 从中文规范整理的 JSON，或指定旧版配置文件");
      const config =
        v.input === "-"
          ? readAccountInput(await Bun.stdin.text())
          : readAccounts(fs.readFileSync(path.resolve(v.input!), "utf8"));
      const result = resolveAccount(
        config,
        v.account,
        v.platforms
          ?.split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      );
      print(result);
      return result.status === "resolved" ? 0 : 2;
    }
    if (command === "connection") {
      print(await client.request("/connection"));
      return 0;
    }
    if (command === "pair") {
      print(await client.request("/pairing", {}));
      return 0;
    }
    if (command === "account") {
      check(v.platform, "须指定--platform");
      const task = await client.request("/account", { platform: v.platform });
      print({ taskId: task.taskId, platform: task.platform, status: task.receipt.status });
      const result = await client.wait(task, timeout);
      print(result);
      return result.receipt.status === "account_verified" ? 0 : 2;
    }
    if (
      [
        "generate-video-task",
        "plan-video-task",
        "run-video-task",
        "plan",
        "submit",
        "run",
        "plan-config",
        "run-config",
      ].includes(command)
    ) {
      check(pos[1], "须指定作品目录");
      const folder = fs.realpathSync(pos[1]);
      if (command === "generate-video-task") {
        check(v.input, "须指定--input，-表示标准输入");
        const spec = v.input === "-" ? JSON.parse(await Bun.stdin.text()) : readMetadata(path.resolve(v.input));
        const t = publication.generate(folder, spec, v["source-root"]);
        print({
          file: path.join(folder, publication.NAME),
          batchId: t.任务批次ID,
          status: t.状态,
          platforms: t.平台任务.map((i: JsonRecord) => i.平台),
        });
        return 0;
      }
      const chinese = command === "plan-video-task" || command === "run-video-task";
      const configured = chinese || command.endsWith("-config");
      const plans = configured
        ? configuredPlans(folder, config, v.platforms, chinese)
        : [preflight(folder, config, action, v.platforms)];
      const skips = chinese ? [] : textSkips(folder, config, v.platforms);
      if (command.startsWith("plan")) {
        const planned = plans.map((p) => ({
          platform: p.platform,
          action: p.action,
          title: p.data.title,
          imageCount: (p.data.images ?? []).length + Number("cover" in p.data),
          hasVideo: !!p.data.video,
          status: "preflight_passed",
        }));
        print(command === "plan" ? planned[0] : skips.length ? { planned, skipped: skips } : planned);
        return 0;
      }
      if (command === "submit") {
        check(action !== "publish", "直接发布须使用 run，让 Skill 先填写核对再关联 publish 任务");
        print(await client.request("/submit", { folder, config, action, platforms: v.platforms }));
        return 0;
      }
      check((await client.request("/connection")).online, "插件执行器离线或未配对；请打开已配对的浏览器并等待连接");
      if (chinese) {
        const snapshot = publication.load(folder);
        const file = path.join(state, "publication-batches", `${uuid(snapshot.任务批次ID)}.json`);
        check(!fs.existsSync(file) || equal(readJson(file), snapshot), "同一批次的输入已改变，请重新生成任务");
        atomic(file, snapshot);
      }
      if (skips.length) print({ skipped: skips });
      let success = true;
      for (const p of plans) {
        const result = await client.execute(folder, config, p, timeout);
        const expected = VIDEO.has(p.platform)
          ? "executed"
          : ({ prepare: "filled", save_draft: "draft_saved", publish: "published" } as JsonRecord)[p.action];
        if (result.receipt.status !== expected) success = false;
        if (!VIDEO.has(p.platform) && (!TERMINAL.has(result.receipt.status) || (chinese && !success))) break;
      }
      return success ? 0 : 2;
    }
    check(pos[1], "须指定任务ID");
    const taskId = uuid(pos[1]);
    if (command === "status" || command === "wait") {
      const t = await client.request(`/status?taskId=${taskId}`);
      const result = command === "wait" ? await client.wait(t, timeout) : t;
      print(result);
      return command === "status" || result.receipt.status === "filled" ? 0 : 2;
    }
    if (command === "resume") {
      print(await client.request("/resume", { taskId, replaceFrom: v["replace-from"] }));
      return 0;
    }
    const endpoints: Record<string, string> = {
      publish: "/publish",
      "publish-resume": "/publish-resume",
      reconcile: "/reconcile",
      "save-video-draft": "/save-video-draft",
      "reconcile-video-draft": "/reconcile-video-draft",
      "inspect-video-drafts": "/inspect-video-drafts",
    };
    check(command in endpoints, `未知命令：${command}`);
    const body: JsonRecord = { taskId, repairRednoteHostNoop: v["repair-rednote-host-noop"] ?? false };
    if (command === "inspect-video-drafts") body.view = v.view ?? "draft_manager";
    if (v["retry-after-title-repair"]) body.retryAfterTitleRepair = true;
    const t = await client.request(endpoints[command], body);
    print({ taskId: t.taskId, platform: t.platform, status: t.receipt.status });
    const result = await client.wait(t, timeout);
    print(result);
    return result.receipt.status === (command.includes("draft") ? "draft_saved" : "published") ? 0 : 2;
  } catch (error) {
    if (error instanceof ApiError) print(error.body);
    else
      print({
        status: ["plan", "run", "submit", "plan-config", "run-config", "plan-video-task", "run-video-task"].includes(
          command,
        )
          ? "preflight_failed"
          : "error",
        error: (error as Error).message,
      });
    return 2;
  }
}
if (import.meta.main) process.exitCode = await main();

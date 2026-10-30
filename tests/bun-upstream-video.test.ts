import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "../skills/qiushui-fast-publish/scripts/lib/client";
import { TERMINAL } from "../skills/qiushui-fast-publish/scripts/lib/core";
import { ACTIONS } from "../skills/qiushui-fast-publish/scripts/lib/publication";
for (const action of ["prepare", "save_draft", "publish"]) {
  test(`video ${action} directly submits upstream handler without linked actions`, async () => {
    const calls: any[] = [];
    const c = new Client("/unused");
    c.request = async (endpoint, body) => {
      calls.push({ endpoint, body });
      return { taskId: "test", receipt: { status: "executed" } };
    };
    const result = await c.execute(
      "/work",
      "/config",
      { platform: "VIDEO_WEIXINCHANNEL", action, data: {} },
      1,
      () => {},
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe("/submit");
    expect(calls[0].body.action).toBe(action === "save_draft" ? "prepare" : action);
    expect(result.receipt.status).toBe("executed");
  });
}
test("legacy draft intent means leave editor, execution is terminal but not published", () => {
  expect(ACTIONS.存草稿).toBe("prepare");
  expect(TERMINAL.has("executed")).toBe(true);
});
for (const name of ["weixinchannel", "rednote", "douyin"]) {
  test(`${name} handler preserves upstream steps outside the explicit cover adaptation`, () => {
    let actual = readFileSync(`src/sync/video/${name}.ts`, "utf8");
    const upstream = execFileSync("git", ["show", `5522ca0:src/sync/video/${name}.ts`], { encoding: "utf8" });
    // Rednote intentionally adapts only its cover upload; all other upstream steps remain intact.
    if (name === "rednote") {
      const coverStart = actual.indexOf("  // The platform may already");
      const coverEnd = actual.indexOf('  let stage = "page";', coverStart);
      const originalStart = upstream.indexOf("  // 辅助函数：上传封面");
      const originalEnd = upstream.indexOf("  // 等待页面加载", originalStart);
      actual = actual.slice(0, coverStart) + upstream.slice(originalStart, originalEnd) + actual.slice(coverEnd);
      actual = actual
        .replace(
          "export async function VideoRednote(data: SyncData, coverOnly = false)",
          "export async function VideoRednote(data: SyncData)",
        )
        .replace(/ {2}if \(coverOnly\) \{[\s\S]*?\n {2}\}\n/, "")
        .replace('  let stage = "page";\n  try {\n', "")
        .replace(/ {2}stage = "[a-z]+";\n/g, "");
      const bridge = actual.indexOf("\n  return { ok: true, coverRequested:");
      actual = `${actual.slice(0, bridge)}\n}\n`;
      actual = actual.replace(
        '    throw new Error("REDNOTE_EDITOR_NOT_READY");',
        '    console.error("未找到编辑器元素");\n    return;',
      );
    }
    if (name === "douyin") {
      const start = actual.indexOf("  // Each supplied cover");
      const end = actual.indexOf("  try {\n    if (coverOnly)", start);
      actual =
        actual.slice(0, start) +
        upstream.slice(upstream.indexOf("  // 按视频宽高比"), upstream.indexOf("  try {\n    const { content")) +
        actual.slice(end);
      actual = actual.replace(
        "export async function VideoDouyin(data: SyncData, coverOnly = false, openOnly = false, horizontalOnly = false)",
        "export async function VideoDouyin(data: SyncData)",
      );
      actual = actual.replace(/ {4}if \(coverOnly\) \{[\s\S]*?\n {4}\}\n/, "");
      const startCall = actual.indexOf("    await fillCovers();");
      const endCall = actual.indexOf("    // 处理定时发布", startCall);
      const originalStart = upstream.indexOf("    // 处理封面上传:");
      const originalEnd = upstream.indexOf("    // 处理定时发布", originalStart);
      actual = actual.slice(0, startCall) + upstream.slice(originalStart, originalEnd) + actual.slice(endCall);
      const result = actual.indexOf("    return { ok: true, coverConfirmed:");
      actual = actual.slice(0, result) + upstream.slice(upstream.lastIndexOf("  } catch (error)"));
    }
    expect(actual).toBe(upstream);
  });
}

import * as vm from "node:vm";
import ts from "typescript";
for (const platform of ["VIDEO_WEIXINCHANNEL", "VIDEO_REDNOTE", "VIDEO_DOUYIN"]) {
  test(`${platform} executor calls upstream once with requested autoPublish and no inspection gate`, async () => {
    const source = readFileSync("src/background/services/local-task.ts", "utf8");
    const start = source.indexOf("async function executeVideoTask(");
    const end = source.indexOf("\nasync function execute(", start);
    const code = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const action of ["prepare", "publish"]) {
      const invocations: any[] = [];
      const receipts: any[] = [];
      const context: any = {
        chrome: {
          tabs: { create: async () => ({ id: 12 }) },
          scripting: {
            executeScript: async (call: any) => {
              invocations.push(call);
              return [{ result: { ok: true, coverConfirmed: true } }];
            },
          },
        },
        loaded: async () => {},
        saveResult: async (_: any, r: any) => receipts.push(r),
        VideoRednote: () => {},
        VideoDouyin: () => {},
        VideoWeiXinChannel: () => {},
        videoTaskStep: () => {
          throw new Error("unexpected inspection");
        },
      };
      vm.createContext(context);
      vm.runInContext(code, context);
      await context.executeVideoTask({
        taskId: "test",
        platform,
        action,
        operation: "start",
        data: { title: "标题", content: "正文" },
      });
      expect(invocations).toHaveLength(1);
      expect(invocations[0].args[0].isAutoPublish).toBe(action === "publish");
      expect(receipts.at(-1).status).toBe("executed");
      expect(receipts.at(-1).evidence.publicationConfirmed).toBe(false);
    }
  });
}

test("rednote injected errors and missing cover confirmation cannot be reported as executed", async () => {
  const source = readFileSync("src/background/services/local-task.ts", "utf8");
  const start = source.indexOf("async function executeVideoTask(");
  const code = ts.transpileModule(source.slice(start, source.indexOf("\nasync function execute(", start)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const result of [
    [{ error: "REDNOTE_COVER_ENTRY_TIMEOUT" }],
    [{ result: { ok: false, code: "REDNOTE_COVER_INPUT_TIMEOUT" } }],
    [{ result: { ok: true, coverConfirmed: false } }],
    [],
  ]) {
    const receipts: any[] = [];
    const context: any = {
      chrome: { tabs: { create: async () => ({ id: 12 }) }, scripting: { executeScript: async () => result } },
      loaded: async () => {},
      saveResult: async (_: any, r: any) => receipts.push(r),
      VideoRednote: () => {},
      VideoDouyin: () => {},
      VideoWeiXinChannel: () => {},
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    await context.executeVideoTask({
      taskId: "test",
      platform: "VIDEO_REDNOTE",
      action: "prepare",
      operation: "start",
      data: { cover: { name: "Q25.png" } },
    });
    expect(receipts.at(-1).status).toBe("failed");
  }
});

test("explicit cover retry reuses original page and only runs cover mode without publishing", async () => {
  const source = readFileSync("src/background/services/local-task.ts", "utf8");
  const start = source.indexOf("async function executeVideoTask(");
  const code = ts.transpileModule(source.slice(start, source.indexOf("\nasync function execute(", start)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls: any[] = [];
  const receipts: any[] = [];
  const context: any = {
    chrome: {
      tabs: {
        get: async (id: number) => ({ id }),
        create: async () => {
          throw new Error("must reuse page");
        },
      },
      scripting: {
        executeScript: async (call: any) => {
          calls.push(call);
          return [{ result: { ok: true, coverConfirmed: true } }];
        },
      },
    },
    loaded: async () => {},
    saveResult: async (_: any, r: any) => receipts.push(r),
    VideoRednote: () => {},
    VideoDouyin: () => {},
    VideoWeiXinChannel: () => {},
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.executeVideoTask(
    {
      taskId: "test",
      platform: "VIDEO_REDNOTE",
      action: "prepare",
      operation: "resume",
      videoStep: "upload_cover",
      data: { cover: { name: "Q25.png" } },
    },
    { tabId: 12 },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].target.tabId).toBe(12);
  expect(calls[0].args[1]).toBe(true);
  expect(calls[0].args[0].isAutoPublish).toBe(false);
  expect(receipts.at(-1).status).toBe("executed");
});

test("cover-only retry transfers cover images without reading or embedding the video", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { TaskStore } = require("../skills/qiushui-fast-publish/scripts/lib/task-store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cover-only-"));
  try {
    const material = (name: string, contents: string, type: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, contents);
      return {
        name,
        path: file,
        type,
        size: contents.length,
        sha256: crypto.createHash("sha256").update(contents).digest("hex"),
      };
    };
    const video = material("video.mp4", "VIDEO_MUST_NOT_TRANSFER", "video/mp4");
    const cover = material("vertical.png", "VERTICAL", "image/png");
    const horizontalCover = material("horizontal.png", "HORIZONTAL", "image/png");
    const store = new TaskStore(dir);
    const task = store.fresh({
      taskId: "12345678-1234-4234-8234-123456789abc",
      platform: "VIDEO_DOUYIN",
      action: "prepare",
      data: { video, cover, horizontalCover, images: [] },
      operation: "resume",
      videoStep: "upload_cover",
    });
    const claim = store.claim(task);
    expect(claim.data.video.url).toBeUndefined();
    expect(claim.data.video.path).toBeUndefined();
    expect(claim.data.cover.url).toContain(Buffer.from("VERTICAL").toString("base64"));
    expect(claim.data.horizontalCover.url).toContain(Buffer.from("HORIZONTAL").toString("base64"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

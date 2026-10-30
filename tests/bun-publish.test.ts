import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "../skills/qiushui-fast-publish/scripts/lib/client";
import {
  DEFAULT_CONFIG,
  type JsonRecord,
  type Plan,
  ROOT,
  UUID_URL,
  atomic,
  length,
  now,
  randomUUID,
  uuid5,
  within,
} from "../skills/qiushui-fast-publish/scripts/lib/core";
import { preflight } from "../skills/qiushui-fast-publish/scripts/lib/preflight";
import { startServer } from "../skills/qiushui-fast-publish/scripts/lib/server";
import { TaskStore } from "../skills/qiushui-fast-publish/scripts/lib/task-store";
const roots: string[] = [];
const services: ReturnType<typeof startServer>[] = [];
const temp = () => {
  const p = fs.mkdtempSync(path.join(tmpdir(), "fastpublish-bun-"));
  roots.push(p);
  return p;
};
const service = (readOnly = false, state = temp()) => {
  const s = startServer({ state, port: 0, adminToken: "test-admin", readOnly });
  services.push(s);
  return s;
};
afterEach(async () => {
  mock.restore();
  for (const s of services.splice(0)) await s.server.stop(true);
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function request(
  s: ReturnType<typeof service>,
  endpoint: string,
  body?: JsonRecord,
  headers: Record<string, string> = {},
) {
  return fetch(new URL(endpoint, s.origin), {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    proxy: "",
  });
}
function executor(s: ReturnType<typeof service>) {
  s.store.write("executor.json", {
    extensionId: "a".repeat(32),
    token: "executor-test",
    lastSeen: now(),
    videoTaskProtocol: 1,
    videoTaskRevision: 35,
  });
}
const extensionHeaders = {
  Authorization: "Bearer executor-test",
  "X-MultiPost-Extension-Id": "a".repeat(32),
  "X-FastPublish-Video-Tasks": "1",
  "X-FastPublish-Video-Revision": "35",
};
function oldTask(s: ReturnType<typeof service>, operation = "start", receipt: JsonRecord = { status: "queued" }) {
  const t = s.store.fresh({
    taskId: randomUUID(),
    platform: "VIDEO_WEIXINCHANNEL",
    action: operation === "account" ? "account" : "prepare",
    data: { title: "测试", content: "正文", images: [], videos: [] },
    operation,
    receipt,
  });
  s.store.save(t);
  return t;
}
function content() {
  const folder = temp();
  fs.cpSync(path.join(ROOT, "tests/fixtures/dynamic/image-card-rednote"), folder, { recursive: true });
  return folder;
}

test("UUID5 remains compatible with RFC4122 and Python namespaces", () => {
  expect(uuid5(UUID_URL, "https://example.com")).toBe("4fd35a71-71ef-5a55-a9d9-aa75c889a6d0");
});
test("emoji title length uses Unicode code points", () => {
  expect(length("视频号😀")).toBe(4);
});
test("timestamps remain seconds", () => {
  expect(now()).toBeLessThan(1e11);
  expect(now()).toBeGreaterThan(1e9);
});
test("private task storage uses mode 0600", () => {
  const s = service();
  const t = oldTask(s);
  expect(fs.statSync(s.store.taskPath(t.taskId)).mode & 0o777).toBe(0o600);
});
test("symlink cannot escape material root", () => {
  const root = temp();
  const outside = temp();
  fs.writeFileSync(path.join(outside, "data"), "secret");
  fs.symlinkSync(path.join(outside, "data"), path.join(root, "link"));
  expect(() => within(root, "link")).toThrow("越出");
});
test("sibling prefix is not accepted as a confined directory", () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "ab"));
  fs.writeFileSync(path.join(root, "ab/data"), "test");
  expect(() => within(path.join(root, "a"), "../ab/data")).toThrow("越出");
});
test("stale running tasks become unknown rather than queued", () => {
  const s = service();
  const t = oldTask(s, "start", { status: "running" });
  t.updatedAt = now() - 901;
  s.store.save(t);
  expect(s.store.load(t.taskId).receipt.status).toBe("result_unconfirmed");
});
test("new server reads existing pairing without replacing executor token", () => {
  const state = temp();
  const store = new TaskStore(state);
  store.write("executor.json", { token: "existing", extensionId: "a".repeat(32), lastSeen: now() });
  service(false, state);
  expect(store.read("executor.json").token).toBe("existing");
});
test("Bun CLI client connects through preserved server.json format", async () => {
  const s = service();
  executor(s);
  expect((await new Client(s.store.state).request("/connection")).online).toBe(true);
});
test("wrong admin credential is rejected", async () => {
  const s = service();
  expect((await request(s, "/connection", undefined, { Authorization: "Bearer wrong" })).status).toBe(400);
});
test("untrusted web origin is rejected", async () => {
  const s = service();
  expect((await request(s, "/health", undefined, { Origin: "https://example.com" })).status).toBe(400);
});
test("parallel next polls claim exactly one task", async () => {
  const s = service();
  executor(s);
  oldTask(s, "account");
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => request(s, "/next", undefined, extensionHeaders)),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 204)).toHaveLength(19);
});
test("parallel submit with one idempotency key persists one task", async () => {
  const s = service();
  const folder = content();
  const id = randomUUID();
  const body = { folder, platforms: "DYNAMIC_REDNOTE", idempotencyKey: id };
  const responses = await Promise.all(Array.from({ length: 10 }, () => request(s, "/submit", body)));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(s.store.all()).toHaveLength(1);
});
test("read-only mode blocks every non-account mutation", async () => {
  const s = service(true);
  for (const endpoint of [
    "/submit",
    "/publish",
    "/save-video-draft",
    "/resume",
    "/reconcile",
    "/collect",
    "/metrics",
    "/pairing",
  ])
    expect((await request(s, endpoint, { taskId: randomUUID() })).status).toBe(400);
  expect(s.store.all()).toHaveLength(0);
});
test("read-only polling skips old upload tasks and claims only accounts", async () => {
  const s = service(true);
  executor(s);
  const upload = oldTask(s);
  const acct = await (await request(s, "/account", { platform: "VIDEO_WEIXINCHANNEL" })).json();
  const response = await request(s, "/next", undefined, extensionHeaders);
  expect(response.status).toBe(200);
  expect((await response.json()).taskId).toBe(acct.taskId);
  expect(s.store.load(upload.taskId).receipt.status).toBe("queued");
});
test("read-only manual claim cannot bypass upload block", async () => {
  const s = service(true);
  const t = oldTask(s);
  expect((await request(s, "/claim", { taskId: t.taskId, token: t.claimToken })).status).toBe(400);
});
test("account results are accepted in read-only mode", async () => {
  const s = service(true);
  const t = oldTask(s, "account");
  const receipt = {
    taskId: t.taskId,
    platform: t.platform,
    action: t.action,
    status: "account_verified",
    evidence: { accountId: "target" },
  };
  expect((await request(s, "/result", { taskId: t.taskId, token: t.callbackToken, receipt })).status).toBe(200);
  expect(s.store.load(t.taskId).receipt.status).toBe("account_verified");
});
test("claim cannot be repeated with the old one-use token", async () => {
  const s = service();
  const t = oldTask(s, "account");
  expect((await request(s, "/claim", { taskId: t.taskId, token: t.claimToken })).status).toBe(200);
  expect((await request(s, "/claim", { taskId: t.taskId, token: t.claimToken })).status).toBe(400);
});
test("foreign receipt cannot overwrite task status", async () => {
  const s = service();
  const t = oldTask(s, "account");
  const receipt = { taskId: t.taskId, platform: "VIDEO_DOUYIN", action: "account", status: "account_verified" };
  expect((await request(s, "/result", { taskId: t.taskId, token: t.callbackToken, receipt })).status).toBe(400);
  expect(s.store.load(t.taskId).receipt.status).toBe("queued");
});
test("request body size cap is enforced", async () => {
  const s = service();
  const r = await request(s, "/account", { platform: "VIDEO_WEIXINCHANNEL", padding: "x".repeat(1024 * 1024) });
  expect([400, 413]).toContain(r.status);
});
for (const [action, endpoint, finalStatus] of [
  ["prepare", null, "filled"],
  ["save_draft", "/save-video-draft", "draft_saved"],
  ["publish", "/publish", "published"],
] as const) {
  test(`client action ${action} preserves linked execution`, async () => {
    const client = new Client(temp());
    const filled = { taskId: "prepared", receipt: { status: "filled" } };
    const final = { taskId: "final", receipt: { status: finalStatus } };
    const calls: any[] = [];
    spyOn(client, "request").mockImplementation(async (p, b) => {
      calls.push([p, b]);
      return p === "/submit" ? filled : final;
    });
    spyOn(client, "wait").mockImplementation(async (r) => r);
    const plan: Plan = {
      platform: "VIDEO_WEIXINCHANNEL",
      action,
      data: {},
      inputFormat: "publication",
      idempotencyKey: randomUUID(),
    };
    const result = await client.execute("/work", DEFAULT_CONFIG, plan, 1, () => {});
    expect(calls[0][1].action).toBe("prepare");
    expect(calls[0][1].inputFormat).toBe("publication");
    expect(calls).toHaveLength(endpoint ? 2 : 1);
    if (endpoint) expect(calls[1][0]).toBe(endpoint);
    expect(result.receipt.status).toBe(finalStatus);
  });
}
test("unknown preparation never reaches final action", async () => {
  const c = new Client(temp());
  const unknown = { taskId: "x", receipt: { status: "result_unconfirmed" } };
  const spy = spyOn(c, "request").mockResolvedValue(unknown);
  spyOn(c, "wait").mockResolvedValue(unknown);
  await c.execute(
    "/work",
    DEFAULT_CONFIG,
    { platform: "VIDEO_WEIXINCHANNEL", action: "publish", data: {} },
    1,
    () => {},
  );
  expect(spy).toHaveBeenCalledTimes(1);
});
test("video channel title whitelist is enforced before any HTTP call", () => {
  const folder = temp();
  fs.cpSync(path.join(ROOT, "tests/fixtures/video/weixinchannel-prepare"), folder, { recursive: true });
  const file = path.join(folder, "content.yaml");
  const meta = Bun.YAML.parse(fs.readFileSync(file, "utf8")) as JsonRecord;
  fs.unlinkSync(file);
  meta.title = "标题，逗号";
  atomic(path.join(folder, "content.json"), meta);
  const config = path.join(folder, "config.json");
  atomic(config, { VIDEO: ["VIDEO_WEIXINCHANNEL"] });
  expect(() => preflight(folder, config, "prepare", "VIDEO_WEIXINCHANNEL")).toThrow("不支持的符号");
});

test("draft-only server cannot submit publicly even with an existing filled source", async () => {
  const root = temp();
  const s = startServer({ state: root, port: 0, adminToken: "test-admin", draftOnly: true });
  services.push(s);
  const t = oldTask(s, "start", { status: "filled", tabId: 42 });
  t.data.draftOnly = true;
  s.store.save(t);
  expect((await request(s, "/publish", { taskId: t.taskId })).status).toBe(400);
});
for (const platform of ["VIDEO_REDNOTE", "VIDEO_DOUYIN"])
  test(`${platform} saves a linked draft with revision36`, async () => {
    const s = service();
    executor(s);
    const e = s.store.read("executor.json");
    e.videoTaskRevision = 36;
    s.store.write("executor.json", e);
    const t = oldTask(s, "start", { status: "filled", tabId: 42 });
    t.platform = platform;
    t.data = { expectedAccountId: "target", draftOnly: true, title: "test", content: "body" };
    s.store.save(t);
    const first = await (await request(s, "/save-video-draft", { taskId: t.taskId })).json();
    expect(first.action).toBe("save_draft");
    const second = await (await request(s, "/save-video-draft", { taskId: t.taskId })).json();
    expect(first.taskId).toBe(second.taskId);
    expect(s.store.load(first.taskId).sourceTaskId).toBe(t.taskId);
    expect((await request(s, "/publish", { taskId: t.taskId })).status).toBe(400);
  });

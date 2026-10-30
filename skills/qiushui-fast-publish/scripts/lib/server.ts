import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  type JsonRecord,
  TERMINAL,
  type Task,
  UUID_URL,
  VIDEO,
  append,
  check,
  equal,
  length,
  now,
  object,
  omit,
  randomUUID,
  safeEqual,
  token,
  uuid,
  uuid5,
  validChannelTitle,
} from "./core";
import { preflight } from "./preflight";
import { TaskStore } from "./task-store";

export interface ServerOptions {
  state: string;
  port?: number;
  hostPort?: number;
  adminToken?: string;
  readOnly?: boolean;
  draftOnly?: boolean;
  validate?: typeof preflight;
}
// Body reads may overlap; every state transition is serialized, including check-and-claim.
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => T): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
}
export function startServer(options: ServerOptions) {
  const store = new TaskStore(path.resolve(options.state));
  const adminToken = options.adminToken ?? token();
  const queue = new SerialQueue();
  const readOnly = options.readOnly ?? false;
  const draftOnly = options.draftOnly ?? false;
  fs.mkdirSync(store.state, { recursive: true, mode: 0o700 });
  fs.chmodSync(store.state, 0o700);
  const validate = options.validate ?? preflight;
  let origin = "";
  const json = (value: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  const admin = (req: Request) =>
    check(safeEqual(req.headers.get("Authorization"), `Bearer ${adminToken}`), "本机 CLI 凭证无效");
  const publicTask = (task: Task) => json(store.public(task));
  function route(req: Request, url: URL, body: JsonRecord): Response {
    const endpoint = url.pathname;
    if (req.method === "GET") {
      if (endpoint === "/health") return json({ ready: true, protocol: 2, runtime: "bun", readOnly, draftOnly });
      if (endpoint === "/bridge" || endpoint === "/pair")
        return new Response(
          fs.readFileSync(
            path.resolve(import.meta.dir, "..", endpoint === "/bridge" ? "bridge.html" : "pair.html"),
            "utf8",
          ),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          },
        );
      if (endpoint === "/connection") {
        admin(req);
        return json(store.executor());
      }
      if (endpoint === "/status") {
        const task = store.load(url.searchParams.get("taskId") ?? "");
        if (!safeEqual(url.searchParams.get("token"), task.claimToken)) admin(req);
        return publicTask(task);
      }
      if (endpoint === "/next") {
        const e = store.read("executor.json");
        check(
          safeEqual(req.headers.get("Authorization"), `Bearer ${e.token}`) &&
            req.headers.get("X-MultiPost-Extension-Id") === e.extensionId,
          "插件执行器凭证无效",
        );
        const requestOrigin = req.headers.get("Origin");
        check(!requestOrigin || requestOrigin === `chrome-extension://${e.extensionId}`, "插件执行器来源不一致");
        e.videoTaskProtocol = req.headers.get("X-FastPublish-Video-Tasks") === "1" ? 1 : null;
        const revision = req.headers.get("X-FastPublish-Video-Revision") ?? "";
        e.videoTaskRevision = /^[1-9][0-9]{0,2}$/u.test(revision) ? Number(revision) : null;
        e.lastSeen = now();
        store.write("executor.json", e);
        const tasks = store.all();
        if (tasks.some((t) => ["claimed", "running"].includes(t.receipt.status))) return json({}, 204);
        const next = tasks
          .filter(
            (t) =>
              t.delivery === "automatic" &&
              t.receipt.status === "queued" &&
              !t.claimed &&
              (!readOnly || t.operation === "account") &&
              (!draftOnly ||
                t.operation === "account" ||
                (t.action === "prepare" && t.data.draftOnly === true) ||
                ["save_draft", "reconcile_draft", "inspect_drafts", "inspect_draft_editor"].includes(t.operation)),
          )
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) return json({}, 204);
        try {
          return json(store.claim(next));
        } catch (error) {
          next.receipt = { status: "failed", code: "MATERIAL_CHANGED", message: (error as Error).message };
          next.updatedAt = now();
          store.save(next);
          return json({}, 204);
        }
      }
      return json({ error: "NOT_FOUND" }, 404);
    }
    check(req.method === "POST", "仅支持GET/POST");
    check(object(body), "请求体必须为对象");
    if (readOnly && !["/account", "/claim", "/result"].includes(endpoint))
      throw new Error("当前为账号只读验收模式，不接受上传、保存草稿或公开发布");
    if (draftOnly && ["/publish", "/publish-resume", "/reconcile"].includes(endpoint))
      throw new Error("当前仅上传存草稿，禁止公开提交");
    if (endpoint === "/pairing") {
      admin(req);
      const pair = { token: token(), expiresAt: now() + 300, used: false };
      store.write("pairing.json", pair);
      return json({ pairingUrl: `${origin}/pair#${pair.token}`, expiresInSeconds: 300 });
    }
    if (endpoint === "/pair-claim") {
      const p = store.read("pairing.json");
      const id = body.extensionId ?? "";
      const o = req.headers.get("Origin");
      check(/^[a-p]{32}$/u.test(id) && (!o || o === `chrome-extension://${id}`), "插件身份无效");
      check(
        !p.used && now() <= p.expiresAt && safeEqual(String(body.token ?? ""), p.token),
        "配对凭证已使用、过期或无效",
      );
      const t = token();
      store.write("executor.json", { token: t, extensionId: id, lastSeen: 0 });
      p.used = true;
      store.write("pairing.json", p);
      return json({ executorToken: t });
    }
    if (endpoint === "/submit") {
      admin(req);
      const plan = validate(
        body.folder,
        body.config ?? DEFAULT_CONFIG,
        body.action ?? "prepare",
        body.platforms,
        body.inputFormat === "publication",
      );
      check(
        !VIDEO.has(plan.platform) || store.executor().videoTaskProtocol === 1,
        "当前已配对插件尚未报告视频任务能力，请加载本次开发版并等待心跳",
      );
      if (VIDEO.has(plan.platform)) {
        check((store.executor().videoTaskRevision ?? 0) >= 46, "请加载修订46或更高的上游视频执行器");
        if (draftOnly) check(plan.action !== "publish", "服务启动为draft-only；自动发表需使用普通服务模式");
      } else {
        check(plan.action !== "publish", "非视频内容请使用关联publish任务");
      }
      const id = body.idempotencyKey ? uuid(body.idempotencyKey) : randomUUID();
      if (fs.existsSync(store.taskPath(id))) {
        const old = store.load(id);
        check(
          ["platform", "action", "data"].every((k) => equal(old[k], plan[k])),
          "幂等键已用于不同内容，保留原任务核查",
        );
        return publicTask(old);
      }
      const task = store.fresh({ ...plan, taskId: id });
      store.save(task);
      return publicTask(task);
    }
    if (endpoint === "/account" || endpoint === "/metrics") {
      admin(req);
      const metrics = endpoint === "/metrics";
      if (metrics)
        check(
          /^[a-fA-F0-9]{24}$/u.test(body.noteId ?? "") && /^[a-fA-F0-9]{24}$/u.test(body.expectedAccountId ?? ""),
          "既有作品数据回收需要真实作品ID和目标账号ID",
        );
      else check(body.platform === "DYNAMIC_REDNOTE" || VIDEO.has(body.platform), "账号实时核对仅支持已接通的平台");
      const action = metrics ? "collect" : "account";
      const data: JsonRecord = { title: "", content: "", images: [], videos: [] };
      if (metrics) Object.assign(data, { noteId: body.noteId, expectedAccountId: body.expectedAccountId });
      const task = store.fresh({
        taskId: randomUUID(),
        platform: metrics ? "DYNAMIC_REDNOTE" : body.platform,
        action,
        operation: action,
        data,
      });
      store.save(task);
      return publicTask(task);
    }
    if (endpoint === "/collect") {
      admin(req);
      const s = store.load(body.taskId);
      const note = s.receipt.evidence?.noteId ?? "";
      check(
        s.platform === "DYNAMIC_REDNOTE" && s.receipt.status === "published" && /^[a-fA-F0-9]{24}$/u.test(note),
        "数据回收需要已确认发布的小红书原任务和作品ID",
      );
      const id = body.idempotencyKey ? uuid(body.idempotencyKey) : randomUUID();
      if (fs.existsSync(store.taskPath(id))) {
        const t = store.load(id);
        check(t.operation === "collect" && t.sourceTaskId === s.taskId, "幂等键对应其他任务");
        return publicTask(t);
      }
      const t = store.fresh({
        taskId: id,
        platform: s.platform,
        action: "collect",
        operation: "collect",
        data: { ...s.data, images: [], noteId: note },
        sourceTaskId: s.taskId,
      });
      store.save(t);
      return publicTask(t);
    }
    if (endpoint === "/save-video-draft") {
      admin(req);
      const s = store.load(body.taskId);
      check(VIDEO.has(s.platform) && s.action === "prepare", "仅已填写的原视频准备任务支持保存草稿");
      check(
        s.data.expectedAccountId && s.receipt.status === "filled" && Number.isInteger(s.receipt.tabId),
        "保存前必须核实账号、完整填写与原页面",
      );
      check(!s.publishTaskId, "原任务已有公开提交意图，先核对发表任务");
      const id = uuid5(UUID_URL, `fastpublish-video-draft:${s.taskId}`);
      if (fs.existsSync(store.taskPath(id))) {
        const t = store.load(id);
        check(t.sourceTaskId === s.taskId && t.action === "save_draft", "原视频草稿任务身份不匹配");
        if (body.retryBeforeClick === true) {
          check(
            t.receipt.status === "needs_attention" &&
              ["DRAFT_CONTROL_NOT_READY", "PREPARED_CONTENT_CHANGED", "PREPARED_MEDIA_CHANGED"].includes(
                t.receipt.code,
              ) &&
              t.receipt.evidence?.draftClickAttempted !== true,
            "仅保存点击前暂停的草稿任务允许恢复",
          );
          append(t, "attemptHistory", t.receipt);
          store.requeue(t, { operation: "save_draft", receipt: { status: "queued" } });
        }
        if (body.retryAfterTitleRepair === true) {
          check(
            t.receipt.code === "TITLE_REPAIRED_READY" && t.receipt.status === "needs_attention",
            "仅已确认短标题被拒绝并完成修复的草稿任务可重新保存",
          );
          append(t, "attemptHistory", t.receipt);
          store.requeue(t, { operation: "save_draft", receipt: { status: "queued" } });
        }
        return publicTask(t);
      }
      check(
        (store.executor().videoTaskRevision ?? 0) >= (s.platform === "VIDEO_WEIXINCHANNEL" ? 22 : 36),
        "已配对插件尚未报告视频草稿任务能力",
      );
      const t = store.fresh({
        taskId: id,
        platform: s.platform,
        action: "save_draft",
        operation: "save_draft",
        data: s.data,
        sourceTaskId: s.taskId,
        sourceTabId: s.receipt.tabId,
        preparedEvidence: s.receipt.evidence ?? {},
      });
      store.save(t);
      s.draftTaskId = id;
      store.save(s);
      return publicTask(t);
    }
    if (endpoint === "/inspect-video-drafts") {
      admin(req);
      const s = store.load(body.taskId);
      if (s.platform === "VIDEO_WEIXINCHANNEL" && s.action === "save_draft" && s.receipt.status === "draft_saved")
        return publicTask(s);
      check(
        s.platform === "VIDEO_WEIXINCHANNEL" &&
          s.action === "save_draft" &&
          s.receipt.status === "result_unconfirmed" &&
          s.sourceTaskId,
        "仅已尝试保存且结果未知的视频号草稿任务支持独立草稿读回",
      );
      check((store.executor().videoTaskRevision ?? 0) >= 27, "插件尚未报告独立草稿读回能力");
      const view = body.view ?? "manager";
      check(["manager", "editor", "draft_manager"].includes(view), "草稿读回只支持管理页或全新编辑页");
      const id = uuid5(
        UUID_URL,
        `fastpublish-video-draft-inspection:${s.taskId}${view !== "manager" ? `:${view}` : ""}`,
      );
      if (fs.existsSync(store.taskPath(id))) return publicTask(store.load(id));
      const t = store.fresh({
        taskId: id,
        platform: s.platform,
        action: "save_draft",
        data: s.data,
        sourceTaskId: s.sourceTaskId,
        draftSourceTaskId: s.taskId,
        preparedEvidence: s.preparedEvidence ?? {},
        operation: ["editor", "draft_manager"].includes(view) ? "inspect_draft_editor" : "inspect_drafts",
      });
      if (view === "draft_manager") t.readbackPath = "/platform/post/draftListManager";
      store.save(t);
      return publicTask(t);
    }
    if (endpoint === "/publish") {
      admin(req);
      const s = store.load(body.taskId);
      check(!s.data.draftOnly, "草稿准备不能直接用于公开提交，须先完整核对发布设置");
      check(
        VIDEO.has(s.platform) ||
          [
            "DYNAMIC_REDNOTE",
            "DYNAMIC_WEIXIN",
            "DYNAMIC_WEIXINCHANNEL",
            "DYNAMIC_DOUYIN",
            "DYNAMIC_TOUTIAO",
            "DYNAMIC_OKJIKE",
            "DYNAMIC_ZSXQ",
            "DYNAMIC_MAIMAI",
            "DYNAMIC_X",
          ].includes(s.platform),
        "仅支持已接通的图文或视频原任务公开发布",
      );
      check(!VIDEO.has(s.platform) || store.executor().videoTaskProtocol === 1, "当前已配对插件尚未报告视频任务能力");
      check(!VIDEO.has(s.platform) || s.data.expectedAccountId, "视频公开提交前必须提供已核对的 expectedAccountId");
      check(["filled", "draft_saved"].includes(s.receipt.status), "原任务尚未取得已填写或草稿已确认回执");
      check(Number.isInteger(s.receipt.tabId), "原任务标签页不存在，不能安全发布");
      if (s.publishTaskId) return publicTask(store.load(s.publishTaskId));
      const id = VIDEO.has(s.platform) ? uuid5(UUID_URL, `fastpublish-video-publish:${s.taskId}`) : randomUUID();
      if (VIDEO.has(s.platform) && fs.existsSync(store.taskPath(id))) {
        const old = store.load(id);
        check(old.sourceTaskId === s.taskId && old.action === "publish", "原视频发表任务身份不匹配");
        s.publishTaskId = id;
        store.save(s);
        return publicTask(old);
      }
      const t = store.fresh({
        taskId: id,
        platform: s.platform,
        action: "publish",
        operation: "publish",
        data: s.data,
        sourceTaskId: s.taskId,
        sourceTabId: s.receipt.tabId,
        preparedEvidence: s.receipt.evidence ?? {},
      });
      store.save(t);
      s.publishTaskId = id;
      store.save(s);
      return publicTask(t);
    }
    const known = [
      "/repair-video-draft-title",
      "/reconcile-video-draft",
      "/publish-resume",
      "/reconcile",
      "/resume",
      "/claim",
      "/result",
    ];
    if (!known.includes(endpoint)) return json({ error: "NOT_FOUND" }, 404);
    const task = store.load(body.taskId);
    const evidence = task.receipt.evidence ?? {};
    if (readOnly) check(task.operation === "account", "只读验收模式仅允许领取和回传账号任务");
    if (endpoint === "/repair-video-draft-title") {
      admin(req);
      const old = task.data.title ?? "";
      const observed =
        task.receipt.status === "needs_attention" &&
        task.receipt.code === "DRAFT_TITLE_REJECTED" &&
        evidence.draftTitleRejected === true;
      const reported =
        body.userConfirmedTitleRejection === true &&
        (length(old) > 16 || !validChannelTitle(old)) &&
        task.receipt.status === "result_unconfirmed" &&
        evidence.draftClickAttempted === true;
      const paused =
        task.receipt.code === "TITLE_REPAIR_NOT_ADMITTED" &&
        task.preparedEvidence?.draftTitleRejected === true &&
        typeof evidence.observedTitle === "string";
      check(
        task.platform === "VIDEO_WEIXINCHANNEL" && task.action === "save_draft" && (observed || reported || paused),
        "仅平台已明确拒绝短标题的原草稿任务可修复标题",
      );
      const plan = validate(
        body.folder,
        body.config ?? DEFAULT_CONFIG,
        "prepare",
        task.platform,
        body.inputFormat === "publication",
      );
      check(
        equal(omit(plan.data, ["title"]), omit(task.data, ["title"])) &&
          (plan.data.title !== task.data.title || paused),
        "短标题修复仅允许改标题，视频、封面、正文与账号须保持一致",
      );
      append(task, "attemptHistory", task.receipt);
      append(task, "titleCorrections", {
        at: now(),
        previousTitle: old,
        title: plan.data.title,
        rejectionSource: observed ? "platform_observation" : "explicit_user_report",
      });
      task.preparedEvidence = {
        ...task.preparedEvidence,
        previousTitle: paused ? evidence.observedTitle : old,
        draftTitleRejected: true,
      };
      task.data = plan.data;
      store.requeue(task, { operation: "repair_draft_title", receipt: { status: "queued" } });
      return publicTask(task);
    }
    if (endpoint === "/reconcile-video-draft") {
      admin(req);
      check(
        VIDEO.has(task.platform) && task.action === "save_draft" && task.sourceTaskId,
        "仅视频号原草稿任务支持只读核对",
      );
      if (task.receipt.status === "draft_saved") return publicTask(task);
      const failed =
        task.receipt.status === "failed" &&
        ["inspect_drafts", "inspect_draft_editor", "reconcile_draft"].includes(task.operation);
      check(
        task.receipt.status === "result_unconfirmed" || failed,
        "仅结果未知的原草稿任务或失败的只读任务支持只读核对",
      );
      store.requeue(task, { operation: "reconcile_draft" });
      return publicTask(task);
    }
    if (endpoint === "/publish-resume") {
      admin(req);
      check(task.operation === "publish" && task.action === "publish", "仅能恢复原公开发布任务");
      const before =
        task.receipt.status === "needs_attention" &&
        [
          "PUBLISH_CONTROL_NOT_READY",
          "PREPARED_CONTENT_CHANGED",
          "PREPARED_MEDIA_CHANGED",
          "ACCOUNT_MISMATCH",
          "ACCOUNT_UNVERIFIED",
          "VISIBILITY_UNVERIFIED",
        ].includes(task.receipt.code);
      const noop =
        body.repairRednoteHostNoop === true &&
        task.platform === "DYNAMIC_REDNOTE" &&
        task.receipt.status === "result_unconfirmed" &&
        task.receipt.code === "PUBLISH_RESULT_NOT_CONFIRMED" &&
        evidence.buttonText === "" &&
        String(evidence.customPublishControl ?? "").startsWith("<xhs-publish-btn ") &&
        evidence.url === "https://creator.xiaohongshu.com/publish/publish?target=image";
      check(before || noop, "仅点击前暂停或已证实的旧版小红书 host 空点击可恢复；其他未知结果禁止重试");
      store.requeue(task);
      return publicTask(task);
    }
    if (endpoint === "/reconcile") {
      admin(req);
      const safe =
        task.receipt.status === "failed" &&
        task.receipt.code === "INVALID_PUBLISH_SOURCE" &&
        task.operation === "reconcile";
      check(
        task.action === "publish" &&
          (["result_unconfirmed", "submitted_pending_review"].includes(task.receipt.status) || safe),
        "仅公开发布结果未确认或待审核的原任务支持只读核查",
      );
      store.requeue(task, { operation: "reconcile" });
      return publicTask(task);
    }
    if (endpoint === "/resume") {
      admin(req);
      resume(task, body, store, validate);
      return publicTask(task);
    }
    if (endpoint === "/claim") {
      check(
        safeEqual(String(body.token ?? ""), task.claimToken) && !task.claimed && now() <= task.expiresAt,
        "任务凭证已使用、过期或无效；请查询原任务",
      );
      check(
        !store.all().some((t) => t.taskId !== task.taskId && ["claimed", "running"].includes(t.receipt.status)),
        "当前有任务占用执行链路，请先完成或核查原任务",
      );
      return json(store.claim(task));
    }
    check(safeEqual(String(body.token ?? ""), task.callbackToken), "结果回传凭证无效");
    const receipt = body.receipt;
    check(
      object(receipt) &&
        receipt.taskId === task.taskId &&
        receipt.platform === task.platform &&
        receipt.action === task.action &&
        (TERMINAL.has(receipt.status) || receipt.status === "running"),
      "结果与原任务不一致",
    );
    task.receipt = receipt;
    if (["inspect_drafts", "inspect_draft_editor"].includes(task.operation) && Number.isInteger(receipt.tabId))
      task.sourceTabId = receipt.tabId;
    if (task.draftSourceTaskId && receipt.status === "draft_saved") {
      const original = store.load(task.draftSourceTaskId);
      append(original, "readbackHistory", receipt);
      original.receipt = {
        ...original.receipt,
        status: "draft_saved",
        code: "DRAFT_READBACK_CONFIRMED",
        evidence: {
          ...original.receipt.evidence,
          ...receipt.evidence,
          draftReadbackTaskId: task.taskId,
          draftReadbackTabId: receipt.tabId,
        },
      };
      original.updatedAt = now();
      store.save(original);
    }
    if (task.operation === "repair_draft_title" && receipt.code === "TITLE_REPAIRED_READY") {
      const s = store.load(task.sourceTaskId);
      append(s, "preparationHistory", { data: s.data, receipt: s.receipt });
      s.data = task.data;
      s.receipt = { ...receipt, taskId: s.taskId, action: "prepare", status: "filled", code: "VIDEO_FIELDS_VERIFIED" };
      s.updatedAt = now();
      task.preparedEvidence = receipt.evidence ?? {};
      store.save(s);
    }
    task.updatedAt = now();
    store.save(task);
    return json({ saved: true });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 2663,
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 30,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const allowedPort = options.hostPort ?? server.port;
        const host = req.headers.get("Host");
        check(host === `localhost:${allowedPort}` || host === `127.0.0.1:${allowedPort}`, "仅接受本机请求");
        const requestOrigin = req.headers.get("Origin");
        check(
          !requestOrigin || requestOrigin === origin || requestOrigin.startsWith("chrome-extension://"),
          "请求来源无效",
        );
        let body: JsonRecord = {};
        if (req.method === "POST") {
          check(Number(req.headers.get("Content-Length") ?? 0) <= 1024 * 1024, "请求过大");
          const raw = await req.arrayBuffer();
          check(raw.byteLength <= 1024 * 1024, "请求过大");
          body = JSON.parse(Buffer.from(raw).toString("utf8"));
        }
        return await queue.run(() => route(req, url, body));
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    },
  });
  origin = `http://localhost:${options.hostPort ?? server.port}`;
  store.write("server.json", { origin, token: adminToken });
  return { server, store, origin, adminToken };
}

function resume(task: Task, body: JsonRecord, store: TaskStore, validate = preflight): void {
  const e = task.receipt.evidence ?? {};
  const readPlan = () =>
    validate(body.folder, body.config ?? DEFAULT_CONFIG, "prepare", task.platform, body.inputFormat === "publication");
  if (body.omitUnsupportedHorizontalCover === true) {
    check(
      task.platform === "VIDEO_WEIXINCHANNEL" &&
        task.action === "prepare" &&
        task.receipt.status === "needs_attention" &&
        e.videoUploadStarted === true &&
        !task.publishTaskId &&
        !task.draftTaskId,
      "仅已暂停、未提交的原视频号准备任务可适配单封面",
    );
    const nodes = e.coverNodes ?? [];
    check(
      nodes.some((n: JsonRecord) => String(n.text ?? "").includes("个人主页和分享卡片(3:4)")) &&
        !nodes.some((n: JsonRecord) => String(n.className ?? "").includes("horizon")),
      "缺少当前单封面界面证据",
    );
    const p = readPlan();
    check(
      !p.data.horizontalCover && equal(omit(task.data, ["horizontalCover"]), p.data),
      "单封面适配仅允许移除横封面；其余材料和账号必须保持一致",
    );
    if (task.data.horizontalCover)
      append(task, "coverChanges", {
        at: now(),
        field: "horizontalCover",
        previous: task.data.horizontalCover,
        reason: "当前视频号仅有个人主页和分享卡片3:4封面入口；本轮按单封面执行草稿测试",
      });
    task.data.horizontalCover = undefined;
  }
  if (body.addHorizontalCover === true) {
    check(
      task.platform === "VIDEO_DOUYIN" &&
        task.action === "prepare" &&
        ["needs_attention", "result_unconfirmed"].includes(task.receipt.status) &&
        e.videoUploadStarted === true,
      "只允许给已暂停的原抖音视频准备任务追加横封面",
    );
    const p = readPlan();
    check(
      equal(omit(p.data, ["horizontalCover"]), omit(task.data, ["horizontalCover"])),
      "仅可追加横封面；视频、正文、标题、竖封面和账号必须保持一致",
    );
    const horizontal = p.data.horizontalCover;
    check(
      horizontal && (!task.data.horizontalCover || equal(task.data.horizontalCover, horizontal)),
      "横封面缺失，或已绑定了另一份横封面",
    );
    if (!task.data.horizontalCover) {
      append(task, "coverChanges", {
        at: now(),
        field: "horizontalCover",
        file: horizontal,
        reason: "用户要求分别使用已生成的B横竖封面",
      });
      task.data.horizontalCover = horizontal;
    }
  }
  const step = body.videoStep;
  if (step != null) {
    const allowed: Record<string, string[]> = {
      open_cover: ["VIDEO_REDNOTE", "VIDEO_DOUYIN"],
      finish_cover: ["VIDEO_REDNOTE", "VIDEO_DOUYIN"],
      open_horizontal_cover: ["VIDEO_DOUYIN"],
      upload_cover: ["VIDEO_REDNOTE", "VIDEO_DOUYIN"],
      upload_horizontal_cover: ["VIDEO_DOUYIN"],
      inspect_fields: ["VIDEO_REDNOTE", "VIDEO_DOUYIN"],
    };
    check(
      allowed[step]?.includes(task.platform) &&
        task.action === "prepare" &&
        (["inspect_fields", "open_cover"].includes(step)
          ? ["needs_attention", "result_unconfirmed", "filled", "executed", "failed", "claimed", "running"]
          : ["needs_attention", "result_unconfirmed"]
        ).includes(task.receipt.status),
      "封面修复只允许对应平台已暂停的原视频准备任务；不接受存草稿或发布步骤",
    );
    check(
      step === "inspect_fields" ||
        (["upload_cover", "upload_horizontal_cover", "open_cover"].includes(step) &&
          ["VIDEO_REDNOTE", "VIDEO_DOUYIN"].includes(task.platform) &&
          Number.isInteger(task.receipt.tabId)) ||
        e.videoUploadStarted === true,
      "原任务尚无视频上传意图证据",
    );
    if (step === "inspect_fields" && !Number.isInteger(task.receipt.tabId)) {
      const history = task.inspectionHistory || [];
      const prior = [...history].reverse().find((receipt: JsonRecord) => Number.isInteger(receipt.tabId));
      if (prior) task.receipt.tabId = prior.tabId;
    }
    task.videoStep = step;
    if (
      ["inspect_fields", "open_cover"].includes(step) &&
      ["filled", "executed", "failed"].includes(task.receipt.status)
    ) {
      append(task, "inspectionHistory", { ...task.receipt });
      task.receipt = { ...task.receipt, status: "needs_attention" };
    }
  } else task.videoStep = undefined;
  if (body.replaceFrom) {
    check(
      ["DYNAMIC_TOUTIAO", "DYNAMIC_ZSXQ"].includes(task.platform) && task.action === "prepare",
      "仅头条和知识星球的动态图文准备任务支持核对后替换",
    );
    check(["needs_attention", "result_unconfirmed"].includes(task.receipt.status), "当前任务状态不允许替换");
    const source = store.load(body.replaceFrom);
    check(
      source.taskId !== task.taskId &&
        source.platform === task.platform &&
        source.action === "prepare" &&
        source.receipt.status === "filled",
      "来源必须为同平台已核实填写的独立准备任务",
    );
    const oldImages = source.data.images ?? [];
    const newImages = task.data.images ?? [];
    const textWithout = task.data.textOnly && !newImages.length;
    const oldText = source.data.textOnly && !oldImages.length && newImages.length;
    check(
      textWithout ||
        oldText ||
        (oldImages.length &&
          equal(
            oldImages.map((i: JsonRecord) => i.sha256),
            newImages.map((i: JsonRecord) => i.sha256),
          )),
      "新旧任务图片须逐一相同；或严格核对来源为无图纯文字任务后上传新图",
    );
    check(
      task.platform !== "DYNAMIC_ZSXQ" || source.data.targetSphere === task.data.targetSphere,
      "新旧任务目标星球不同",
    );
    task.replaceExisting = {
      sourceTaskId: source.taskId,
      title: source.data.title,
      content: source.data.content,
      tags: source.data.tags ?? [],
      imageCount: oldImages.length,
    };
  } else task.replaceExisting = undefined;
  check(
    !["ARTICLE_WEIXIN", "DYNAMIC_WEIXIN"].includes(task.platform),
    "公众号草稿创建可能已经成功，请在原任务或草稿箱核查；当前不自动恢复创建",
  );
  check(!VIDEO.has(task.platform) || task.action === "prepare", "视频仅准备任务支持 resume；发表结果未知请 reconcile");
  check(task.receipt.status !== "filled", "任务已核对完成，无需重新执行");
  check(
    !(["claimed", "running"].includes(task.receipt.status) && now() - task.updatedAt < 120),
    "任务仍在执行，先查询结果",
  );
  check(task.receipt.status !== "queued", "任务仍在排队，先查询结果，不重复恢复");
  store.requeue(task, { operation: "resume" });
}

import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonRecord, type Plan, type Task, VIDEO, atomic, digest, now, pick, readJson, token, uuid } from "./core";
export class TaskStore {
  constructor(readonly state: string) {}
  taskPath(id: string): string {
    return path.join(this.state, "tasks", `${uuid(id)}.json`);
  }
  read(file: string): JsonRecord {
    return readJson(path.join(this.state, file));
  }
  write(file: string, value: JsonRecord): void {
    atomic(path.join(this.state, file), value);
  }
  exists(file: string): boolean {
    return fs.existsSync(path.join(this.state, file));
  }
  save(task: Task): void {
    atomic(this.taskPath(task.taskId), task);
  }
  load(id: string): Task {
    const file = this.taskPath(id);
    const task = readJson(file) as Task;
    const limit = VIDEO.has(task.platform) ? 900 : task.platform === "DYNAMIC_OKJIKE" ? 180 : 120;
    if (["claimed", "running"].includes(task.receipt.status) && now() - task.updatedAt > limit) {
      task.receipt = {
        ...task.receipt,
        status: "result_unconfirmed",
        code: "EXECUTOR_INTERRUPTED",
        message: "超过执行时限仍无回执，请先核查原任务和页面，不自动重发。",
      };
      task.updatedAt = now();
      this.save(task);
    }
    return task;
  }
  all(): Task[] {
    const dir = path.join(this.state, "tasks");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => this.load(n.slice(0, -5)))
      : [];
  }
  public(task: Task): JsonRecord {
    return pick(task, ["taskId", "platform", "action", "createdAt", "updatedAt", "receipt"]);
  }
  fresh(values: Plan & { taskId: string }): Task {
    return {
      createdAt: now(),
      updatedAt: now(),
      claimToken: token(),
      callbackToken: token(),
      claimed: false,
      delivery: "automatic",
      operation: "start",
      expiresAt: now() + 900,
      receipt: { status: "queued" },
      ...values,
    } as Task;
  }
  requeue(task: Task, values: JsonRecord = {}): Task {
    Object.assign(
      task,
      {
        claimToken: token(),
        callbackToken: token(),
        claimed: false,
        delivery: "automatic",
        expiresAt: now() + 900,
        updatedAt: now(),
        receipt: { ...task.receipt, status: "queued" },
      },
      values,
    );
    this.save(task);
    return task;
  }
  executor(): JsonRecord {
    if (!this.exists("executor.json")) return { paired: false, online: false, code: "PAIRING_REQUIRED" };
    const e = this.read("executor.json");
    return {
      paired: true,
      extensionId: e.extensionId,
      online: now() - (e.lastSeen ?? 0) < 75,
      lastSeen: e.lastSeen ?? null,
      videoTaskProtocol: e.videoTaskProtocol ?? null,
      videoTaskRevision: e.videoTaskRevision ?? null,
    };
  }
  claim(task: Task): JsonRecord {
    const special = [
      "publish",
      "reconcile",
      "collect",
      "account",
      "save_draft",
      "reconcile_draft",
      "repair_draft_title",
      "inspect_drafts",
      "inspect_draft_editor",
    ];
    if (special.includes(task.operation)) {
      task.claimed = true;
      task.receipt = { ...task.receipt, status: "claimed" };
      task.updatedAt = now();
      this.save(task);
      return pick(task, [
        "taskId",
        "platform",
        "action",
        "callbackToken",
        "operation",
        "data",
        "sourceTaskId",
        "sourceTabId",
        "preparedEvidence",
        "readbackPath",
      ]);
    }
    const previousReceipt = { ...task.receipt };
    const data: JsonRecord = { ...task.data, images: [] as JsonRecord[] };
    if (task.replaceExisting) data.replaceExisting = task.replaceExisting;
    const materials: [string | null, JsonRecord][] = (task.data.images ?? []).map((v: JsonRecord) => [null, v]);
    for (const field of ["cover", "horizontalCover", "verticalCover", "video"])
      if (field in task.data) materials.push([field, task.data[field]]);
    for (const [field, m] of materials) {
      // A cover-only operation needs video metadata, never its 80 MB payload.
      // Read-only inspection needs no media bytes at all.
      if (
        (task.operation === "resume" && task.videoStep === "inspect_fields") ||
        (task.operation === "resume" &&
          ["upload_cover", "upload_horizontal_cover"].includes(task.videoStep || "") &&
          field === "video")
      ) {
        if (field) data[field] = pick(m, ["name", "type", "size", "sha256"]);
        continue;
      }
      if (digest(m.path) !== m.sha256) throw new Error(`素材在预检后发生变化：${m.name}`);
      const packed = {
        ...pick(m, ["name", "type", "size", "sha256"]),
        url: `data:${m.type};base64,${fs.readFileSync(m.path).toString("base64")}`,
      };
      if (field) data[field] = packed;
      else data.images.push(packed);
    }
    task.claimed = true;
    task.receipt = { ...task.receipt, status: "claimed" };
    task.updatedAt = now();
    this.save(task);
    return {
      ...pick(task, ["taskId", "platform", "action", "callbackToken", "operation", "videoStep"]),
      data,
      previousReceipt,
    };
  }
}

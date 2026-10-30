import * as path from "node:path";
import { type JsonRecord, type Plan, TERMINAL, VIDEO, readJson } from "./core";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: JsonRecord,
  ) {
    super(body.error ?? `HTTP ${status}`);
  }
}
export class Client {
  constructor(readonly state: string) {}
  async request(endpoint: string, body?: JsonRecord): Promise<JsonRecord> {
    const info = readJson(path.join(this.state, "server.json"));
    const url = new URL(endpoint, info.origin);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("仅连接本机服务");
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
      proxy: "",
    });
    const result = (await response.json()) as JsonRecord;
    if (!response.ok) throw new ApiError(response.status, result);
    return result;
  }
  async wait(result: JsonRecord, timeout: number): Promise<JsonRecord> {
    const deadline = Date.now() + timeout * 1000;
    while (!TERMINAL.has(result.receipt.status) && Date.now() < deadline) {
      await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
      result = await this.request(`/status?taskId=${result.taskId}`);
    }
    return result;
  }
  async execute(
    folder: string,
    config: string,
    plan: Plan,
    timeout: number,
    log: (v: any) => void = console.log,
  ): Promise<JsonRecord> {
    if (VIDEO.has(plan.platform)) {
      const action = plan.action === "save_draft" ? "prepare" : plan.action;
      let result = await this.request("/submit", {
        folder,
        config,
        action,
        platforms: plan.platform,
        inputFormat: plan.inputFormat,
        idempotencyKey: plan.idempotencyKey,
      });
      result = await this.wait(result, timeout);
      log(JSON.stringify(result));
      return result;
    }
    const linkedDraft = VIDEO.has(plan.platform) && plan.action === "save_draft";
    const prepare = plan.action === "publish" || linkedDraft ? "prepare" : plan.action;
    const body: JsonRecord = { folder, config, action: prepare, platforms: plan.platform };
    if (plan.inputFormat) body.inputFormat = plan.inputFormat;
    if (plan.idempotencyKey) body.idempotencyKey = plan.idempotencyKey;
    let result = await this.request("/submit", body);
    log(JSON.stringify({ taskId: result.taskId, platform: plan.platform, action: prepare, status: "queued" }));
    result = await this.wait(result, timeout);
    log(JSON.stringify(result));
    if ((plan.action !== "publish" && !linkedDraft) || result.receipt.status !== "filled") return result;
    try {
      let final = await this.request(linkedDraft ? "/save-video-draft" : "/publish", { taskId: result.taskId });
      log(
        JSON.stringify({
          taskId: final.taskId,
          sourceTaskId: result.taskId,
          platform: plan.platform,
          action: plan.action,
          status: final.receipt.status,
        }),
      );
      final = await this.wait(final, timeout);
      log(JSON.stringify(final));
      return final;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return {
        ...result,
        receipt: {
          status: "needs_attention",
          code: "FINAL_ACTION_NOT_STARTED",
          sourceStatus: result.receipt.status,
          httpStatus: error.status,
        },
      };
    }
  }
}

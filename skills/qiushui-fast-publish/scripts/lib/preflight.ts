import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  type JsonRecord,
  type Plan,
  TEXT,
  VIDEO,
  check,
  imageFile,
  length,
  object,
  readMetadata,
  truth,
  uuid5,
  videoFile,
  within,
} from "./core";
import * as publication from "./publication";
export function readContent(folder: string): JsonRecord {
  const file = ["content.yaml", "content.json"].map((n) => path.join(folder, n)).find(fs.existsSync);
  check(file, "内容目录缺少 content.yaml 或 content.json");
  return readMetadata(file);
}
export function xWeightedLength(value: string): number {
  return value
    .split(/(https?:\/\/\S+)/u)
    .reduce(
      (total, part) =>
        total +
        (/^https?:\/\/\S+$/u.test(part)
          ? 23
          : Array.from(part).reduce((n, c) => n + (c.codePointAt(0)! > 0x10ff ? 2 : 1), 0)),
      0,
    );
}
const tagsValid = (tags: any) =>
  Array.isArray(tags) && tags.every((t) => typeof t === "string" && t.length > 0 && !/[#\n\r]/u.test(t));
function unsupported(e: JsonRecord, keys: string[], message: string): void {
  const extra = Object.keys(e).filter((k) => !keys.includes(k));
  check(!extra.length, message + (extra.length ? `：${extra.sort().join(", ")}` : ""));
}
export function preflight(
  folder: string,
  config = DEFAULT_CONFIG,
  action = "prepare",
  subset?: string,
  chinese = false,
): Plan {
  folder = fs.realpathSync(folder);
  const translated = chinese ? publication.translate(folder, subset) : null;
  const content = translated ? translated[1] : readContent(folder);
  const configuration = translated ? translated[2] : readMetadata(config);
  check(object(content), "内容元数据必须是对象");
  const kind = content.type;
  check(["DYNAMIC", "ARTICLE", "VIDEO", "PODCAST"].includes(kind), "type 必须为 DYNAMIC、ARTICLE、VIDEO 或 PODCAST");
  check(object(configuration), "平台配置必须是按内容类型分组的对象");
  const configured = configuration[kind] ?? [];
  check(Array.isArray(configured) && configured.every((p) => typeof p === "string"), "平台配置必须是平台键列表");
  const platforms = subset ? subset.split(",") : configured;
  check(
    platforms.length &&
      new Set(platforms).size === platforms.length &&
      platforms.every((p: string) => configured.includes(p)),
    "目标平台须为该类型已配置平台的非空、不重复子集",
  );
  check(platforms.length === 1, "单任务只接受一个平台；多个平台请使用 plan-config 或 run-config");
  const platform = platforms[0];
  const overrides = content.overrides ?? {};
  check(
    object(overrides) && Object.entries(overrides).every(([k, v]) => configured.includes(k) && object(v)),
    "overrides 只能包含已配置平台",
  );
  const e = { ...content, ...overrides[platform] };
  const make = (data: JsonRecord): Plan => ({ platform, action, data });
  if (
    kind === "DYNAMIC" &&
    Array.isArray(content.images ?? []) &&
    !(content.images ?? []).length &&
    !truth(content.videos)
  ) {
    check(TEXT.has(platform) && action === "prepare", `${platform} 当前动态入口的纯文字准备未验证，不发送无图内容`);
    unsupported(
      e,
      ["type", "title", "content", "bodyFile", "tags", "images", "videos", "targetSphere", "overrides"],
      "纯文字内容包含未适配字段或改变了内容类型",
    );
    check(
      e.type === kind && Array.isArray(e.images ?? []) && !(e.images ?? []).length && !truth(e.videos),
      "纯文字平台覆盖不能增加图片或视频",
    );
    const body = "bodyFile" in e ? fs.readFileSync(within(folder, e.bodyFile), "utf8").trimEnd() : (e.content ?? "");
    const tags = e.tags ?? [];
    check(tagsValid(tags), "tags 须为非空字符串列表，不包含 # 或换行");
    check(typeof body === "string" && body.trim(), "纯文字正文不能为空");
    const full = body.trimEnd() + (tags.length ? `\n${tags.map((t: string) => `#${t}`).join(" ")}` : "");
    const limit = platform === "DYNAMIC_X" ? 280 : platform === "DYNAMIC_ZSXQ" ? 10000 : 1000;
    check(length(full) <= limit, `${platform} 纯文字正文包含标签后最多 ${limit} 字符`);
    const data: JsonRecord = { title: "", content: full, tags: [], images: [], videos: [], textOnly: true };
    if (platform === "DYNAMIC_ZSXQ") {
      const sphere = e.targetSphere ?? configuration.targets?.DYNAMIC_ZSXQ;
      check(typeof sphere === "string" && sphere.trim(), "知识星球纯文字必须指定 targetSphere");
      data.targetSphere = sphere.trim();
    } else check(!("targetSphere" in e), "只有知识星球接受 targetSphere");
    return make(data);
  }
  if (kind === "ARTICLE" && platform === "ARTICLE_WEIXIN") {
    check(action === "save_draft", "微信公众号文章当前仅开放 save_draft 测试；不降级目标动作");
    unsupported(e, ["type", "title", "digest", "htmlFile", "cover", "overrides"], "公众号文章尚未适配这些字段");
    check(e.type === kind, "逐平台覆盖不能改变内容类型");
    check(
      typeof e.title === "string" && length(e.title) >= 1 && length(e.title) <= 64,
      "公众号文章标题须为 1–64 个字符",
    );
    const summary = e.digest ?? "";
    check(typeof summary === "string" && length(summary) <= 120, "公众号文章摘要最多 120 个字符");
    const html = fs.readFileSync(within(folder, e.htmlFile), "utf8");
    check(html.trim() && !/<script|<iframe/i.test(html), "文章 HTML 不能为空且不接受脚本或 iframe");
    return make({
      title: e.title,
      digest: summary,
      htmlContent: html,
      markdownContent: "",
      cover: imageFile(folder, e.cover),
      images: [],
    });
  }
  if (kind === "VIDEO" && VIDEO.has(platform)) {
    check(["prepare", "publish", "save_draft"].includes(action), "视频动作无效");
    unsupported(
      e,
      [
        "type",
        "title",
        "content",
        "bodyFile",
        "video",
        "cover",
        "horizontalCover",
        "verticalCover",
        "expectedAccountId",
        "visibility",
        "overrides",
        "tags",
        "scheduledPublishTime",
        "original",
        "description",
        "category",
        "collectionId",
        "draftOnly",
      ],
      "视频内容包含未适配字段或改变了内容类型",
    );
    check(e.type === kind, "逐平台覆盖不能改变内容类型");
    const title = e.title;
    const body = "bodyFile" in e ? fs.readFileSync(within(folder, e.bodyFile), "utf8").trimEnd() : (e.content ?? "");
    check(typeof title === "string" && typeof body === "string", "标题和描述须为文本");
    const id = e.expectedAccountId;
    const tags = e.tags ?? [];
    check(Array.isArray(tags) && tags.every((tag: unknown) => typeof tag === "string"), "话题须为文本列表");
    const scheduled = e.scheduledPublishTime ?? 0;
    check(typeof scheduled === "number" && Number.isFinite(scheduled), "定时须为时间戳");
    const data: JsonRecord = {
      title,
      content: body,
      video: videoFile(folder, e.video),
      tags,
      visibility: "公开",
      scheduledPublishTime: scheduled,
    };
    if ("draftOnly" in e) {
      check(typeof e.draftOnly === "boolean", "draftOnly须为布尔值");
      data.draftOnly = e.draftOnly;
    }
    if ("original" in e) data.original = e.original;
    if ("description" in e) data.description = body;
    if (id) data.expectedAccountId = id;
    for (const field of ["cover", "horizontalCover", "verticalCover"])
      if (e[field] != null) data[field] = imageFile(folder, e[field]);
    check(platform !== "VIDEO_REDNOTE" || !data.horizontalCover, "小红书视频当前使用单张 cover，不接受横封面字段");
    check(
      platform === "VIDEO_WEIXINCHANNEL" || !data.verticalCover,
      "小红书和抖音视频当前使用单张 cover，不接受竖封面字段",
    );
    check(!(data.cover && data.verticalCover), "cover 与 verticalCover 不能同时填写，避免封面选择歧义");
    return make(data);
  }
  const policies: Record<
    string,
    { name: string; maxTitle?: number; maxImages: number; actions: string[]; hashEnd?: boolean }
  > = {
    DYNAMIC_DOUYIN: { name: "抖音", maxTitle: 30, maxImages: 9, actions: ["prepare"] },
    DYNAMIC_TOUTIAO: { name: "今日头条", maxImages: 9, actions: ["prepare"], hashEnd: true },
    DYNAMIC_OKJIKE: { name: "即刻", maxImages: 9, actions: ["prepare"] },
    DYNAMIC_ZSXQ: { name: "知识星球", maxImages: 9, actions: ["prepare"] },
    DYNAMIC_MAIMAI: { name: "脉脉", maxImages: 9, actions: ["prepare"] },
    DYNAMIC_X: { name: "X", maxImages: 4, actions: ["prepare"] },
    DYNAMIC_WEIXINCHANNEL: { name: "视频号", maxTitle: 22, maxImages: 18, actions: ["prepare", "publish"] },
    DYNAMIC_WEIXIN: { name: "公众号", maxTitle: 64, maxImages: 20, actions: ["save_draft"] },
    DYNAMIC_REDNOTE: { name: "小红书", maxTitle: 20, maxImages: 18, actions: ["prepare"], hashEnd: true },
  };
  const rule = policies[platform];
  check(kind === "DYNAMIC" && rule, "首版执行适配仅开放 DYNAMIC / DYNAMIC_REDNOTE；其他类型或平台动作尚未验证");
  check(rule.actions.includes(action), `${rule.name}当前仅开放 ${rule.actions.join(" 或 ")}；不降级目标动作`);
  const keys = ["type", "title", "content", "bodyFile", "tags", "images", "videos", "overrides"];
  if (platform === "DYNAMIC_REDNOTE") keys.push("expectedAccountId");
  if (platform === "DYNAMIC_ZSXQ") keys.push("targetSphere");
  unsupported(e, keys, `${rule.name}尚未适配这些字段`);
  check(e.type === kind, "逐平台覆盖不能改变内容类型");
  const title = e.title ?? "";
  const body = "bodyFile" in e ? fs.readFileSync(within(folder, e.bodyFile), "utf8").trimEnd() : (e.content ?? "");
  const tags = e.tags ?? [];
  check(
    typeof title === "string" && title.trim() && (!rule.maxTitle || length(title) <= rule.maxTitle),
    `${rule.name}标题须为 1–${rule.maxTitle ?? "非空"} 个字符`,
  );
  check(typeof body === "string" && body.trim(), `${rule.name}正文不能为空`);
  check(tagsValid(tags), "tags 须为非空字符串列表，不包含 # 或换行");
  const suffix = tags.length ? ` ${tags.map((t: string) => `#${t}${rule.hashEnd ? "#" : ""}`).join(" ")}` : "";
  const combined =
    platform === "DYNAMIC_TOUTIAO"
      ? `${title}\n\n${body}${suffix}`
      : platform === "DYNAMIC_X"
        ? `${title}\n${body}${suffix}`
        : body + suffix;
  check(
    platform === "DYNAMIC_X" ? xWeightedLength(combined) <= 280 : length(combined) <= 1000,
    platform === "DYNAMIC_X"
      ? "X 动态图文合并标题、正文和标签后超过平台的 280 加权字符限制"
      : `${rule.name}正文包含标签超过 1000 字符限制`,
  );
  const images = e.images ?? [];
  check(
    Array.isArray(images) && images.length >= 1 && images.length <= rule.maxImages && !truth(e.videos),
    `${rule.name}动态图文须包含 1–${rule.maxImages} 张图片，不接受视频`,
  );
  const data: JsonRecord = {
    title,
    content: body,
    tags,
    images: images.map((n: string) => imageFile(folder, n)),
    videos: [],
  };
  if (platform === "DYNAMIC_ZSXQ") {
    check(configuration.targets == null || object(configuration.targets), "平台目标配置 targets 必须是对象");
    const sphere = e.targetSphere ?? configuration.targets?.DYNAMIC_ZSXQ;
    check(typeof sphere === "string" && sphere.trim(), "知识星球动态图文必须指定 targetSphere");
    data.targetSphere = sphere.trim();
  }
  if (platform === "DYNAMIC_REDNOTE") {
    const id = e.expectedAccountId;
    check(
      id == null || (typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(id)),
      "expectedAccountId 必须是已登记的平台稳定账号ID",
    );
    if (id) data.expectedAccountId = id;
  }
  return make(data);
}
export function textSkips(folder: string, config = DEFAULT_CONFIG, subset?: string): JsonRecord[] {
  const file = ["content.yaml", "content.json"].map((n) => path.join(folder, n)).find(fs.existsSync);
  if (!file) return [];
  const content = readMetadata(file);
  if (content.type !== "DYNAMIC" || truth(content.images) || truth(content.videos)) return [];
  const conf = readMetadata(config);
  const selected = subset ? subset.split(",") : (conf.DYNAMIC ?? []);
  const verified = conf.textVerified ?? [];
  const reasons: Record<string, string> = {
    DYNAMIC_REDNOTE: "当前小红书图文入口要求图片",
    DYNAMIC_WEIXIN: "当前公众号图文草稿入口要求图片；文字群发属于另一流程",
    DYNAMIC_WEIXINCHANNEL: "当前视频号图文入口要求图片，纯文字未验证",
    DYNAMIC_DOUYIN: "当前抖音图文入口要求图片，纯文字未验证",
  };
  return selected
    .filter((p: string) => !verified.includes(p))
    .map((p: string) => ({
      platform: p,
      status: "skipped",
      reason: reasons[p] ?? "当前动态入口尚无插件纯文字填写回执",
    }));
}
export function configuredPlans(folder: string, config = DEFAULT_CONFIG, subset?: string, chinese = false): Plan[] {
  if (chinese) {
    const [task, , configuration] = publication.translate(folder, subset);
    return Object.entries(configuration.actions).map(([platform, action]) => ({
      ...preflight(folder, config, "prepare", platform, true),
      action: action as string,
      inputFormat: "publication",
      idempotencyKey: uuid5(task.任务批次ID, `upstream-v1:${platform}`),
    }));
  }
  const content = readContent(folder);
  const configuration = readMetadata(config);
  check(object(content) && object(configuration), "内容元数据和平台配置必须为对象");
  const configured = configuration[content.type] ?? [];
  let selected = subset ? subset.split(",") : configured;
  check(
    Array.isArray(configured) &&
      configured.length &&
      selected.length &&
      new Set(selected).size === selected.length &&
      selected.every((p: string) => configured.includes(p)),
    "目标平台须为该类型已配置平台的非空、不重复子集",
  );
  check(configuration.actions == null || object(configuration.actions), "平台目标动作配置必须为对象");
  if (content.type === "DYNAMIC" && !truth(content.images) && !truth(content.videos)) {
    const verified = configuration.textVerified ?? [];
    check(Array.isArray(verified) && verified.every((p) => TEXT.has(p)), "textVerified 只能包含已适配的纯文字候选平台");
    selected = selected.filter((p: string) => verified.includes(p));
    check(
      selected.length,
      `没有经本机插件真实验证的纯文字目标平台；不发送。跳过原因：${textSkips(folder, config, subset)
        .map((i) => `${i.platform}: ${i.reason}`)
        .join("；")}`,
    );
  }
  return selected.map((platform: string) =>
    preflight(folder, config, configuration.actions?.[platform] ?? "prepare", platform),
  );
}

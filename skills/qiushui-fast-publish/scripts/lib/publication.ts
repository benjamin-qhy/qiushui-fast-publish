import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonRecord, atomic, check, digest, equal, object, omit, randomUUID, readJson, within } from "./core";
export const PLATFORMS: Record<string, string> = {
  视频号: "VIDEO_WEIXINCHANNEL",
  小红书: "VIDEO_REDNOTE",
  抖音: "VIDEO_DOUYIN",
};
export const ACTIONS: Record<string, string> = { 填完保持不动: "prepare", 存草稿: "prepare", 直接发布: "publish" };
export const NAME = "发布任务.json";
export function validateFields(task: JsonRecord): void {
  check(object(task) && typeof task.作品 === "string" && task.作品.trim(), "任务须明确作品名称");
  check(task.时区 === "Asia/Shanghai", "当前任务时区须明确为Asia/Shanghai");
  check(typeof task.视频文件 === "string" || task.视频文件 === null, "视频文件须为相对路径或null");
  check(Array.isArray(task.来源文件) && task.来源文件.length, "须明确非空来源文件列表");
  check(Array.isArray(task.平台任务) && task.平台任务.length, "平台任务须为非空列表");
  const seen = new Set();
  const required = [
    "平台",
    "账号",
    "封面",
    "标题",
    "描述",
    "话题",
    "合集",
    "定时发表",
    "定时发表时间",
    "声明原创",
    "目标动作",
    "待补充",
  ];
  for (const item of task.平台任务) {
    check(object(item) && required.every((k) => k in item), "平台任务缺少明确字段；不自动补默认值");
    check(item.平台 in PLATFORMS && !seen.has(item.平台), "平台须已接通且不重复");
    seen.add(item.平台);
    check(
      object(item.账号) && equal(Object.keys(item.账号).sort(), ["名称", "账号ID"].sort()),
      "账号须明确名称和账号ID",
    );
    check(
      Object.values(item.账号).every((v) => typeof v === "string" || v === null),
      "账号名称和ID须为字符串或null",
    );
    check(
      object(item.封面) && equal(Object.keys(item.封面).sort(), ["竖版", "横版"].sort()),
      "封面须明确竖版和横版路径",
    );
    check(
      Object.values(item.封面).every((v) => typeof v === "string" || v === null),
      "封面路径须为字符串或null",
    );
    check(
      Array.isArray(item.待补充) && item.待补充.every((v: unknown) => typeof v === "string"),
      "待补充须为字符串列表",
    );
    check(typeof item.定时发表 === "boolean" && typeof item.声明原创 === "boolean", "定时发表和声明原创须为明确布尔值");
    check(item.目标动作 in ACTIONS, "目标动作无效");
    for (const k of ["标题", "描述", "合集", "定时发表时间"])
      check(typeof item[k] === "string" || item[k] === null, `${k}须为字符串或null`);
    check(
      item.话题 === null || (Array.isArray(item.话题) && item.话题.every((v: unknown) => typeof v === "string")),
      "话题须为字符串列表或null",
    );
  }
}
export function generate(folder: string, spec: JsonRecord, sourceRoot?: string): JsonRecord {
  folder = fs.realpathSync(folder);
  const root = fs.realpathSync(sourceRoot ?? folder);
  check(
    object(spec) &&
      Object.keys(spec).every((k) => ["作品", "时区", "视频文件", "来源文件", "本次覆盖", "平台任务"].includes(k)),
    "输入只能包含作品、时区、视频文件、来源文件、本次覆盖、平台任务",
  );
  validateFields(spec);
  const task = structuredClone(spec);
  check(
    spec.来源文件.every((v: unknown) => typeof v === "string") && new Set(spec.来源文件).size === spec.来源文件.length,
    "输入来源文件须为不重复的相对路径列表",
  );
  const local = `${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19)}+08:00`;
  Object.assign(task, {
    格式版本: "1.1",
    任务批次ID: randomUUID(),
    生成时间: local,
    来源根目录: root,
    视频SHA256: null,
  });
  task.来源文件 = spec.来源文件.map((name: string) => ({ 路径: name, SHA256: digest(within(root, name)) }));
  if (task.视频文件) task.视频SHA256 = digest(within(folder, task.视频文件));
  let incomplete = !task.视频文件;
  for (const item of task.平台任务) {
    item.封面SHA256 = Object.fromEntries(
      Object.entries(item.封面).map(([role, file]) => [role, file ? digest(within(folder, file)) : null]),
    );
    incomplete ||=
      !!item.待补充.length ||
      !item.封面.竖版 ||
      ["标题", "描述"].some((k) => [null, "", "无", "待补充"].includes(item[k])) ||
      item.话题 === null;
  }
  task.状态 = incomplete ? "待补充" : "待预检";
  const file = path.join(folder, NAME);
  if (fs.existsSync(file)) {
    const old = readJson(file);
    if (equal(omit(old, ["任务批次ID", "生成时间"]), omit(task, ["任务批次ID", "生成时间"]))) return old;
  }
  atomic(file, task, false);
  return task;
}
export function load(folder: string): JsonRecord {
  folder = fs.realpathSync(folder);
  const task = readJson(within(folder, NAME));
  check(task.格式版本 === "1.1" && task.时区 === "Asia/Shanghai", "不支持的发布任务版本或时区");
  validateFields(task);
  return task;
}
export function translate(folder: string, subset?: string): [JsonRecord, JsonRecord, JsonRecord] {
  const task = load(folder);
  const items = task.平台任务;
  const reverse = Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [v, k]));
  const selected = (subset ? subset.split(",") : items.map((i: JsonRecord) => i.平台)).map(
    (p: string) => reverse[p] ?? p,
  );
  check(
    selected.length &&
      new Set(selected).size === selected.length &&
      selected.every((p: string) => items.some((i: JsonRecord) => i.平台 === p)),
    "执行范围只能缩小到任务中已选平台",
  );
  const content: JsonRecord = { type: "VIDEO", video: task.视频文件, overrides: {} };
  const actions: JsonRecord = {};
  const problems: string[] = [];
  for (const item of items) {
    const name = item.平台;
    if (!selected.includes(name)) continue;
    const errors = [...item.待补充];
    for (const field of ["标题", "描述"])
      if ([null, "", "无", "待补充"].includes(item[field])) errors.push(`${field}缺失`);
    if (item.话题 === null) errors.push("话题意图缺失");

    const scheduled = item.定时发表 ? Date.parse(item.定时发表时间 ?? "") : 0;
    if (!Number.isFinite(scheduled)) errors.push("定时发表时间无效");
    if (item.合集 !== null) errors.push("指定合集尚未接通");

    const covers = item.封面;
    if (!covers.竖版) errors.push("指定竖版封面缺失");
    if (name !== "抖音" && covers.横版) errors.push("当前平台封面字段不匹配");

    if (errors.length) {
      problems.push(`${name}：${errors.join("、")}`);
      continue;
    }
    const key = PLATFORMS[name];
    actions[key] = ACTIONS[item.目标动作];
    content.overrides[key] = {
      title: item.标题,
      content: item.描述,
      description: item.描述,
      tags: item.话题,
      collectionId: null,
      scheduledPublishTime: scheduled,
      original: item.声明原创,

      expectedAccountId: item.账号.账号ID,
      cover: covers.竖版,
      visibility: "公开",
    };
    if (covers.横版) content.overrides[key].horizontalCover = covers.横版;
  }
  check(!problems.length, `预检未通过；未创建任务。${problems.join("；")}`);
  return [task, content, { VIDEO: Object.keys(actions), actions }];
}

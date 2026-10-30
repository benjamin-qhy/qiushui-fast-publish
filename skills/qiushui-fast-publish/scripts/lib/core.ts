import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// JSON payloads stay extensible because existing platform receipts have platform-specific evidence.
export interface JsonRecord {
  [key: string]: any;
}
export interface Plan extends JsonRecord {
  platform: string;
  action: string;
  data: JsonRecord;
}
export interface Task extends Plan {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  receipt: JsonRecord;
}
export interface Material {
  name: string;
  path: string;
  type: string;
  size: number;
  sha256: string;
}
export const VIDEO = new Set(["VIDEO_WEIXINCHANNEL", "VIDEO_REDNOTE", "VIDEO_DOUYIN"]);
export const TEXT = new Set(["DYNAMIC_TOUTIAO", "DYNAMIC_OKJIKE", "DYNAMIC_ZSXQ", "DYNAMIC_MAIMAI", "DYNAMIC_X"]);
export const TERMINAL = new Set([
  "executed",
  "account_verified",
  "metrics_collected",
  "filled",
  "draft_saved",
  "published",
  "submitted_pending_review",
  "needs_attention",
  "failed",
  "result_unconfirmed",
  "unsupported",
  "unverified",
]);
export const DEFAULT_CONFIG = path.resolve(import.meta.dir, "../../config/platforms.yaml");
export const ROOT = path.resolve(import.meta.dir, "../../../..");
export const now = () => Date.now() / 1000;
export const token = () => randomBytes(32).toString("base64url");
export const object = (v: unknown): v is JsonRecord => v !== null && typeof v === "object" && !Array.isArray(v);
export const length = (v: string) => Array.from(v).length;
export const truth = (v: any): boolean =>
  v != null &&
  v !== false &&
  v !== 0 &&
  v !== "" &&
  (!Array.isArray(v) || v.length > 0) &&
  (!object(v) || Object.keys(v).length > 0);
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const equal = (a: any, b: any) => Bun.deepEquals(a, b);
export const pick = (v: JsonRecord, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]]));
export const omit = (v: JsonRecord, keys: string[]) =>
  Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
export const append = (v: JsonRecord, key: string, value: any) => (v[key] ??= []).push(value);
export function uuid(value: string): string {
  check(typeof value === "string", "无效任务UUID");
  const compact = value
    .replace(/^urn:uuid:/i, "")
    .replace(/[{}-]/g, "")
    .toLowerCase();
  check(/^[0-9a-f]{32}$/.test(compact), "无效任务UUID");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
export const UUID_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export function uuid5(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(uuid(namespace).replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  return uuid(hash.toString("hex"));
}
export { randomUUID };
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function readJson(file: string): JsonRecord {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function readMetadata(file: string): JsonRecord {
  const text = fs.readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : (Bun.YAML.parse(text) as JsonRecord);
}
export function atomic(file: string, value: any, privateFile = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: privateFile ? 0o600 : 0o644, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function within(folder: string, name: unknown): string {
  check(typeof name === "string" && name.length > 0, "素材路径必须是非空字符串");
  let base: string;
  let target: string;
  try {
    base = fs.realpathSync(folder);
    target = fs.realpathSync(path.resolve(base, name));
  } catch {
    throw new Error(`文件不存在或越出目录：${name}`);
  }
  const relative = path.relative(base, target);
  check(
    relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      fs.statSync(target).isFile(),
    `文件不存在或越出内容目录：${name}`,
  );
  return target;
}
export function digest(file: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) h.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
export function material(folder: string, name: unknown, video = false): Material {
  const file = within(folder, name);
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  const head = Buffer.alloc(32);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 32, 0);
  } finally {
    fs.closeSync(fd);
  }
  let mime = "video/mp4";
  if (video)
    check(
      ext === ".mp4" && size > 0 && size <= 100 * 1024 * 1024 && head.includes(Buffer.from("ftyp")),
      "视频任务须为 100 MiB 内的有效 MP4",
    );
  else {
    mime = (
      { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
        string,
        string
      >
    )[ext];
    check(mime && size > 0 && size <= 32 * 1024 * 1024, `图片格式或大小不合要求：${name}`);
    const valid =
      mime === "image/png"
        ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg"
          ? head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          : head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP";
    check(valid, `图片内容与后缀不一致：${name}`);
  }
  return { name: path.basename(file), path: file, type: mime, size, sha256: digest(file) };
}
export const imageFile = (folder: string, name: unknown) => material(folder, name);
export const videoFile = (folder: string, name: unknown) => material(folder, name, true);
export const validChannelTitle = (text: string) =>
  Array.from(text).every((c) => /[\p{L}\p{N}]/u.test(c) || " 《》“”‘’\"':：+＋?？%％℃".includes(c));

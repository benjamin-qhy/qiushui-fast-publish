import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import ts from "typescript";
const source = readFileSync("src/sync/video/douyin.ts", "utf8");
const start = source.indexOf("  async function uploadCover(");
const code = ts.transpileModule(source.slice(start, source.indexOf("  let stage =", start)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
async function run(role = "vertical", opts: any = {}) {
  let time = 0;
  let ticks = 0;
  let uploads = 0;
  let clicked = "";
  let closed = false;
  let open = false;
  let confirmations = 0;
  const node = (x: any = {}) => ({
    getClientRects: () => [{ width: 10, height: 10 }],
    getAttribute: () => null,
    children: [],
    disabled: false,
    textContent: "",
    ...x,
  });
  const image = node({ src: "old-frame", complete: true, naturalWidth: 100, currentSrc: "" });
  const button = node({
    textContent: "完成",
    click: () => {
      confirmations++;
      closed = !opts.stuck;
    },
  });
  Object.defineProperty(button, "disabled", { get: () => ticks < 5 });
  const input = node({
    accept: "image/png,image/jpeg,image/jpg",
    className: "upload-btn-input-UY_qeY",
    parentElement: node({ textContent: "点击上传文件或拖拽文件到这里" }),
    dispatchEvent: (e: Event) => {
      if (e.type === "change") uploads++;
    },
  });
  const modal = node({
    querySelectorAll: (s: string) => {
      if (s === 'input[type="file"]')
        return opts.missingInput
          ? []
          : [node({ accept: "image/png", className: "semi-upload-hidden-input", parentElement: node() }), input];
      if (s === "img") return [image];
      if (s === "canvas") return [];
      if (s === "span, p, div") return opts.failed && uploads ? [node({ textContent: "上传失败" })] : [];
      if (s.includes("progressbar")) return uploads && (opts.busy || ticks < 5) ? [node()] : [];
      if (s === 'button, [role="button"]') return [button];
      throw new Error(s);
    },
  });
  const label = opts.chooseLabel ? "选择封面" : "编辑封面";
  const panels = ["vertical", "horizontal"].map((r) =>
    node({
      textContent: label + (r === "vertical" ? "竖封面3:4" : "横封面4:3"),
      querySelectorAll: () => [
        node({
          textContent: label,
          getClientRects: () => [],
          click: () => {
            clicked = r;
            open = true;
          },
        }),
      ],
    }),
  );
  const document = {
    querySelectorAll: (s: string) =>
      s === '[class*="coverControl-"]'
        ? opts.missingEntry
          ? []
          : panels
        : s === ".dy-creator-content-modal"
          ? open && !closed
            ? [modal]
            : []
          : [],
  };
  const ctx: any = {
    document,
    File,
    Event,
    Blob,
    Date: { now: () => time },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    fetch: async () => ({ ok: !opts.fetchFailed, blob: async () => new Blob(["Q25"]) }),
    DataTransfer: class {
      files: any[] = [];
      items = { add: (f: any) => this.files.push(f) };
    },
    setTimeout: (fn: () => void, ms: number) => {
      time += ms;
      ticks++;
      if (uploads && !opts.noPreview && ticks >= 4) image.src = "new-q25";
      fn();
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  let error = "";
  try {
    await ctx.uploadCover({ url: "data:cover", name: "q25.png", type: "image/png" }, role);
  } catch (e) {
    error = String(e);
  }
  return { error, clicked, uploads, confirmations, ticks };
}
for (const role of ["vertical", "horizontal"])
  test(`updates correct ${role} slot using current classes and hover-only edit control`, async () => {
    const r = await run(role);
    expect(r.error).toBe("");
    expect(r.clicked).toBe(role);
    expect(r.uploads).toBe(1);
    expect(r.confirmations).toBe(1);
    expect(r.ticks).toBeGreaterThanOrEqual(5);
  });
for (const [opts, error] of [
  [{ missingEntry: true }, "ENTRY_TIMEOUT"],
  [{ missingInput: true }, "INPUT_TIMEOUT"],
  [{ failed: true }, "UPLOAD_FAILED"],
  [{ busy: true }, "PROCESSING_TIMEOUT"],
  [{ noPreview: true }, "PROCESSING_TIMEOUT"],
  [{ fetchFailed: true }, "FILE_READ_FAILED"],
  [{ stuck: true }, "CONFIRM_TIMEOUT"],
] as const)
  test(`returns DOUYIN_COVER_${error}`, async () => {
    const r = await run("vertical", opts);
    expect(r.error).toContain(`DOUYIN_COVER_${error}`);
    expect(r.uploads).toBeLessThanOrEqual(1);
  });
test("provided vertical and horizontal covers are both uploaded in separate calls", async () => {
  const start = source.indexOf("  const fillCovers =");
  const end = source.indexOf("  try {\n    if (coverOnly)", start);
  const code = ts.transpileModule(
    `let stage="";const coverResults=[];${source.slice(start, end)};this.run=fillCovers;this.results=coverResults;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const calls: any[] = [];
  const vertical = { name: "vertical.png" };
  const horizontal = { name: "horizontal.png" };
  const ctx: any = {
    data: { data: { cover: vertical, horizontalCover: horizontal } },
    uploadCover: async (file: any, role: any) => calls.push([file.name, role]),
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  await ctx.run();
  expect(calls).toEqual([
    ["vertical.png", "vertical"],
    ["horizontal.png", "horizontal"],
  ]);
  expect([...ctx.results]).toEqual(["vertical", "horizontal"]);
});

test("current page 选择封面 entry is recognized", async () => {
  const r = await run("vertical", { chooseLabel: true });
  expect(r.error).toBe("");
  expect(r.clicked).toBe("vertical");
});

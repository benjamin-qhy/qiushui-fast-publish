import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import ts from "typescript";
const source = readFileSync("src/sync/video/rednote.ts", "utf8");
const start = source.indexOf("  async function uploadCover(");
const end = source.indexOf('  let stage = "page";', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
async function run({
  entry = "edit",
  hiddenEdit = false,
  missingInput = false,
  fail = false,
  busyForever = false,
  fetchOk = true,
  disabledForever = false,
  previewNeverChanges = false,
  confirmStuck = false,
}: any = {}) {
  let clock = 0;
  let ticks = 0;
  let opened = false;
  let closed = false;
  let uploads = 0;
  let confirmations = 0;
  let entryClicks = 0;
  const node = (extra: any = {}) => ({
    getClientRects: () => [{ width: 10, height: 10 }],
    getAttribute: () => null,
    hasAttribute: () => false,
    children: [],
    textContent: "",
    disabled: false,
    ...extra,
  });
  const image: any = node({ src: "old-frame.jpg", currentSrc: "", complete: true, naturalWidth: 100 });
  const confirm: any = node({
    textContent: "确定",
    get disabled() {
      return disabledForever || ticks < 4;
    },
    click: () => {
      confirmations++;
      if (!confirmStuck) closed = true;
    },
  });
  // Preserve the accessor rather than spreading it into node().
  Object.defineProperty(confirm, "disabled", { get: () => disabledForever || ticks < 4 });
  const input: any = node({
    accept: "image/*,.webp",
    className: "upload",
    dispatchEvent: (event: Event) => {
      if (event.type === "change") uploads++;
    },
  });
  const modal: any = node({
    querySelectorAll: (selector: string) => {
      if (selector === 'input[type="file"]') return missingInput ? [] : [input];
      if (selector === "img") return [image];
      if (selector === "canvas") return [];
      if (selector === "span, p, div") return fail && uploads ? [node({ textContent: "上传失败" })] : [];
      if (selector.includes("progressbar")) return uploads && (busyForever || ticks < 4) ? [node()] : [];
      if (selector === 'button, [role="button"]') return [confirm];
      throw new Error(`unknown modal selector ${selector}`);
    },
  });
  const trigger = node({
    getClientRects: () => (hiddenEdit ? [] : [{ width: 10, height: 10 }]),
    textContent: "编辑封面",
    click: () => {
      opened = true;
      entryClicks++;
    },
  });
  const root = node({ querySelectorAll: () => [trigger] });
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === "div.noCover.uploadCover") return entry === "empty" ? [trigger] : [];
      if (selector === ".cover-plugin-preview .cover--column") return entry === "edit" ? [root] : [];
      if (selector === ".main-cover-editor-modal") return opened && !closed ? [modal] : [];
      throw new Error(`unknown document selector ${selector}`);
    },
  };
  const context: any = {
    document,
    console: { info: () => {} },
    Date: { now: () => clock },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    setTimeout: (fn: () => void, ms: number) => {
      clock += ms;
      ticks++;
      if (uploads && !previewNeverChanges && ticks >= 3) image.src = "new-q25.png";
      fn();
    },
    fetch: async () => ({ ok: fetchOk, blob: async () => new Blob(["Q25"]) }),
    File,
    Event,
    DataTransfer: class {
      files: any[] = [];
      items = { add: (file: any) => this.files.push(file) };
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  let error = "";
  try {
    await context.uploadCover({ url: "data:approved", type: "image/png", name: "Q25.png" });
  } catch (e) {
    error = String(e);
  }
  return { error, uploads, confirmations, entryClicks, ticks };
}
for (const entry of ["edit", "empty"])
  test(`${entry} cover entry uploads once and waits for changed preview and enabled confirmation`, async () => {
    const r = await run({ entry });
    expect(r.error).toBe("");
    expect(r.uploads).toBe(1);
    expect(r.confirmations).toBe(1);
    expect(r.ticks).toBeGreaterThanOrEqual(4);
  });
for (const [options, expected] of [
  [{ entry: "missing" }, "REDNOTE_COVER_ENTRY_TIMEOUT"],
  [{ missingInput: true }, "REDNOTE_COVER_INPUT_TIMEOUT"],
  [{ fail: true }, "REDNOTE_COVER_UPLOAD_FAILED"],
  [{ fetchOk: false }, "REDNOTE_COVER_FILE_READ_FAILED"],
  [{ busyForever: true }, "REDNOTE_COVER_PROCESSING_TIMEOUT"],
  [{ disabledForever: true }, "REDNOTE_COVER_PROCESSING_TIMEOUT"],
  [{ previewNeverChanges: true }, "REDNOTE_COVER_PROCESSING_TIMEOUT"],
  [{ confirmStuck: true }, "REDNOTE_COVER_CONFIRM_TIMEOUT"],
] as const)
  test(`reports ${expected} without silently succeeding`, async () => {
    const r = await run(options);
    expect(r.error).toContain(expected);
    expect(r.confirmations).toBe(options.confirmStuck ? 1 : 0);
    expect(r.uploads).toBeLessThanOrEqual(1);
  });

test("existing frame cover supports its hover-only edit control", async () => {
  const r = await run({ hiddenEdit: true });
  expect(r.error).toBe("");
  expect(r.uploads).toBe(1);
  expect(r.confirmations).toBe(1);
});

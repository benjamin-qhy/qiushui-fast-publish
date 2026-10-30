import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/sync/article/weixin.ts", "utf8");

test("公众号主图使用独立的 2.35:1 图片，裁切元数据来自实际图片尺寸", async () => {
  const start = source.indexOf("  function calculateCropConfig(");
  const end = source.indexOf("  // 上传图片", start);
  const assignment = source.slice(
    source.indexOf("    const ratios ="),
    source.indexOf("    // 创建文章", source.indexOf("    const ratios =")),
  );
  const fields = source.slice(source.indexOf("    // 封面图片配置"), source.indexOf("    // 其他必要参数"));
  const code = `${source.slice(start, end)}\nthis.run = async () => {\n${assignment}\nconst formData = new FormData();\n${fields}\nreturn formData;\n};`;
  const context: any = {
    width: 1919,
    height: 820,
    uploadResult: {},
    console: { debug() {} },
    FormData,
    cropImage: async (_: unknown, configs: any[]) =>
      configs.map((_: any, i: number) => ({ url: `https://example.test/cover-${i}`, fileId: i + 1 })),
  };
  vm.createContext(context);
  vm.runInContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context,
  );
  const form = await context.run();
  expect(form.get("cdn_235_1_url0")).toBe("https://example.test/cover-0");
  expect(form.get("cdn_url0")).toBe("https://example.test/cover-0");
  expect(form.get("cdn_1_1_url0")).toBe("https://example.test/cover-2");
  const crops = JSON.parse(form.get("crop_list0"));
  const main = crops.crop_list.find((c: any) => c.ratio === "2.35_1");
  expect(main.x1).toBe(0);
  expect(main.x2).toBe(1919);
  expect((main.x2 - main.x1) / (main.y2 - main.y1)).toBeCloseTo(2.35, 2);
  expect(crops.crop_list_percent.find((c: any) => c.ratio === "2.35_1").x2).toBe(1);
});

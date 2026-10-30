import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import ts from "typescript";
import { readAccounts, resolveAccount } from "../skills/qiushui-fast-publish/scripts/lib/accounts";
const binding = { accountId: "stable-id", nickname: "我叫秋水", browser: "chrome", profile: "秋水" };
function rules() {
  return {
    defaultAccount: "主号",
    accounts: [
      {
        id: "main",
        name: "我叫秋水",
        aliases: ["秋水", "主号"],
        platforms: { 小红书: binding, 抖音: { ...binding, accountId: "dy-id", nickname: "另一个昵称" } },
      },
      {
        id: "other",
        name: "海奇AI",
        aliases: ["产品号"],
        platforms: { 小红书: { ...binding, accountId: "other-id", browser: "edge" } },
      },
    ],
  };
}
const markdown = (c: unknown) =>
  `# 发布规范\n\n## 发布账号配置\n\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\`\n\n## 其他\n`;
test("actual name and aliases resolve same cross-platform group; override never changes default", () => {
  const c = readAccounts(markdown(rules()));
  const before = JSON.stringify(c);
  for (const name of ["我叫秋水", "秋水", "主号"])
    expect(resolveAccount(c, name, ["小红书", "抖音"]).account.id).toBe("main");
  expect(resolveAccount(c, "产品号", ["小红书"]).platforms.小红书.browser).toBe("edge");
  expect(resolveAccount(c, undefined, ["抖音"]).platforms.抖音.accountId).toBe("dy-id");
  expect(JSON.stringify(c)).toBe(before);
});
test("conflicting alias or actual name and invalid defaults are rejected", () => {
  const c = rules();
  c.accounts[1].aliases.push("主号");
  expect(() => readAccounts(markdown(c))).toThrow("冲突");
  const d = rules();
  d.defaultAccount = "不存在";
  expect(() => readAccounts(markdown(d))).toThrow("默认账号");
});
test("unknown names, unmapped platforms and missing identity cannot silently fall back", () => {
  const c = readAccounts(markdown(rules()));
  expect(() => resolveAccount(c, "不存在", ["小红书"])).toThrow("未配置");
  expect(resolveAccount(c, undefined, ["公众号"]).status).toBe("needs_attention");
  c.accounts[0].platforms.小红书.accountId = null;
  expect(resolveAccount(c, undefined, ["小红书"]).status).toBe("needs_attention");
  expect(() => resolveAccount(c)).toThrow("目标平台");
});
for (const platform of ["VIDEO_WEIXINCHANNEL", "VIDEO_REDNOTE", "VIDEO_DOUYIN"]) {
  test(`${platform}: identity checked before handler; mismatch and unreadable identity prevent upload`, async () => {
    const source = readFileSync("src/background/services/local-task.ts", "utf8");
    const start = source.indexOf("async function executeVideoTask(");
    const code = ts.transpileModule(source.slice(start, source.indexOf("\nasync function execute(", start)), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const actual of ["stable-id", "wrong-id", null]) {
      const calls: any[] = [];
      const receipts: any[] = [];
      const identity = () => {};
      const context: any = {
        chrome: {
          tabs: { create: async () => ({ id: 12 }) },
          scripting: {
            executeScript: async (call: any) => {
              calls.push(call);
              return [
                {
                  result:
                    call.func === identity
                      ? { status: actual ? "account_verified" : "needs_attention", evidence: { accountId: actual } }
                      : { ok: true, coverConfirmed: true },
                },
              ];
            },
          },
        },
        loaded: async () => {},
        saveResult: async (_: any, r: any) => receipts.push(r),
        videoTaskStep: identity,
        VideoRednote: () => {},
        VideoDouyin: () => {},
        VideoWeiXinChannel: () => {},
      };
      vm.createContext(context);
      vm.runInContext(code, context);
      await context.executeVideoTask({
        taskId: "test",
        platform,
        action: "publish",
        operation: "start",
        data: { expectedAccountId: "stable-id" },
      });
      expect(calls[0].args[2]).toBe("account");
      expect(calls.length).toBe(actual === "stable-id" ? 2 : 1);
      expect(receipts.at(-1).status).toBe(actual === "stable-id" ? "executed" : "needs_attention");
    }
  });
}

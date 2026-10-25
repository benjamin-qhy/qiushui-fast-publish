const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function compile(file, context) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...context });
  return exports;
}
const id = 'a'.repeat(24);
function metrics(text, cardId = id) {
  const card = { querySelectorAll: () => [], innerText: text, getAttribute: () => JSON.stringify({ noteTarget: { value: { noteId: cardId } } }) };
  return compile('src/sync/dynamic/rednote-metrics.ts', {
    location: { origin: 'https://creator.xiaohongshu.com', pathname: '/new/note-manager', href: 'https://creator.xiaohongshu.com/new/note-manager' },
    document: { querySelectorAll: () => [card] },
  }).collectRednoteMetrics(id);
}
async function accountGate(actual) {
  const receipts = []; let tabCalls = 0;
  const source = fs.readFileSync('src/background/services/local-task.ts', 'utf8') + '\nexport { execute as testExecute };';
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: (name) => name === '~sync/account/rednote' ? { getRednoteAccountInfo: async () => actual ? { accountId: actual } : null } : {},
    chrome: { i18n: { getMessage: () => '' }, storage: { local: { get: async () => ({}), set: async () => {} } }, tabs: { create: async () => { tabCalls += 1; throw Error('unexpected tab'); } } },
    fetch: async (_url, options) => { receipts.push(JSON.parse(options.body).receipt); return { ok: true }; },
  });
  await exports.testExecute({ taskId: 'test', platform: 'DYNAMIC_REDNOTE', action: 'prepare', operation: 'start', data: { expectedAccountId: 'target' } });
  assert.equal(tabCalls, 0);
  assert.equal(receipts.at(-1).status, 'needs_attention');
  assert.equal(receipts.at(-1).code, actual ? 'ACCOUNT_MISMATCH' : 'ACCOUNT_UNVERIFIED');
}
(async () => {
assert.equal((await metrics('阅读\n1,234\n点赞 0\n收藏\n5')).evidence.metrics['阅读'], 1234);
assert.equal((await metrics('点赞 0')).evidence.metrics['点赞'], 0);
assert.equal((await metrics('阅读 1.2万')).evidence.metrics['阅读'], null);
assert.equal((await metrics('未提供阅读')).evidence.metrics['阅读'], null);
assert.equal((await metrics('阅读 10', 'b'.repeat(24))).status, 'needs_attention');

  await accountGate('other'); await accountGate(null);
  console.log('7 local-operation assertions passed (metrics identity, missing/zero/abbreviated counts, account gates).');
})().catch((e) => { console.error(e); process.exitCode = 1; });

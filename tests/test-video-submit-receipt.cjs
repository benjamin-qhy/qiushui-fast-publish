const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the background task with a simulated original video-channel tab.
// No browser or platform requests are made by this test.
const source = ts.transpileModule(
  fs.readFileSync('src/background/services/local-task.ts', 'utf8') + '\nexport { executeVideoTask };',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

async function scenario(operation, verification, clickStatus = 'clicked', readbackPath) {
  const exports = {};
  const receipts = [];
  const modes = [];
  vm.runInNewContext(source, {
    exports,
    require: () => ({}),
    setTimeout: (callback, ms) => ms >= 10000 ? setTimeout(callback, ms).unref() : (callback(), 0),
    clearTimeout,
    fetch: async (_url, options) => {
      receipts.push(JSON.parse(options.body).receipt);
      return { ok: true };
    },
    chrome: {
      i18n: { getMessage: () => '' },
      storage: { local: { set: async () => {} } },
      tabs: {
        get: async () => ({ id: 7, status: 'complete' }),
        create: async () => { throw Error('Must reuse original tab'); },
        update: async () => {},
      },
      scripting: { executeScript: async ({ args }) => {
        const mode = args[2];
        modes.push(mode);
        return [{ result: (mode === 'click' || mode === 'save_draft')
          ? { status: clickStatus, code: 'CLICK_RESULT', evidence: { clickAttempted: clickStatus === 'clicked' } }
          : { status: verification, code: 'ACCOUNT_UNVERIFIED', evidence: {} } }];
      } },
    },
  });
  await exports.executeVideoTask({
    taskId: 'test-submit', sourceTaskId: 'test-prepare', sourceTabId: 7, readbackPath,
    platform: 'VIDEO_WEIXINCHANNEL', action: operation.includes('draft') ? 'save_draft' : 'publish', operation,
    data: { title: 'test', content: 'test', video: {} },
  });
  return { receipt: receipts.at(-1), modes };
}

async function uploadGate(initialCode) {
  const exports = {};
  const receipts = [];
  let gates = 0;
  let uploads = 0;
  vm.runInNewContext(source, {
    exports, require: () => ({}),
    setTimeout: (callback, ms) => ms >= 10000 ? setTimeout(callback, ms).unref() : (callback(), 0),
    clearTimeout,
    fetch: async (_url, options) => { receipts.push(JSON.parse(options.body).receipt); return { ok: true }; },
    chrome: {
      i18n: { getMessage: () => '' },
      storage: { local: { set: async () => {} } },
      tabs: { create: async () => ({ id: 7, status: 'complete' }), get: async () => ({ id: 7, status: 'complete' }) },
      scripting: { executeScript: async ({ args }) => {
        const mode = args[2];
        if (mode === 'gate') {
          gates += 1;
          const code = initialCode === 'delayed' && gates > 1 ? 'VIDEO_UPLOAD_ADMITTED' : initialCode === 'delayed' ? 'UPLOAD_PAGE_REQUIRED' : initialCode;
          return [{ result: { status: code === 'VIDEO_UPLOAD_ADMITTED' ? 'ready' : 'needs_attention', code, evidence: {} } }];
        }
        if (mode === 'inspect') return [{ result: { status: 'filled', code: 'TEST', evidence: {} } }];
        uploads += 1;
        assert.equal(args[0].isAutoPublish, false);
        assert.equal(receipts.at(-1).evidence.videoUploadStarted, true);
        return [];
      } },
    },
  });
  await exports.executeVideoTask({ taskId: 'test-prepare', platform: 'VIDEO_WEIXINCHANNEL', action: 'prepare', operation: 'start', data: { video: {} } });
  return { gates, uploads, receipt: receipts.at(-1) };
}

(async () => {
  for (const status of ['needs_attention', 'result_unconfirmed', 'published', 'submitted_pending_review']) {
    const expected = ['published', 'submitted_pending_review'].includes(status) ? status : 'result_unconfirmed';
    const run = await scenario('publish', status);
    assert.equal(run.receipt.status, expected);
    assert.equal(run.receipt.evidence.clickAttempted, true);
    assert.equal(run.modes.filter(mode => mode === 'click').length, 1);
    const reconciled = await scenario('reconcile', status);
    assert.equal(reconciled.receipt.status, expected);
    assert.ok(reconciled.modes.every(mode => mode === 'verify'));
  }
  const paused = await scenario('publish', 'published', 'needs_attention');
  assert.equal(paused.receipt.status, 'needs_attention');
  assert.deepEqual(paused.modes, ['click']);
  const draft = await scenario('save_draft', 'needs_attention');
  assert.equal(draft.receipt.status, 'result_unconfirmed');
  assert.equal(draft.receipt.evidence.draftClickAttempted, true);
  assert.equal(draft.modes.filter(mode => mode === 'save_draft').length, 1);
  assert.ok(!draft.modes.includes('click'));
  const readDraft = await scenario('reconcile_draft', 'result_unconfirmed');
  assert.ok(readDraft.modes.every(mode => mode === 'verify_draft'));
  const managerRead = await scenario('reconcile_draft', 'draft_saved', 'clicked', '/platform/post/draftListManager');
  assert.equal(managerRead.receipt.status, 'draft_saved');
  assert.ok(managerRead.modes.every(mode => mode === 'verify_draft'));
  const wrongRead = await scenario('reconcile_draft', 'draft_saved', 'clicked', '/other');
  assert.equal(wrongRead.receipt.status, 'failed');
  assert.equal(wrongRead.modes.length, 0);
  const delayed = await uploadGate('delayed');
  assert.equal(delayed.gates, 2);
  assert.equal(delayed.uploads, 1);
  assert.equal(delayed.receipt.status, 'filled');
  const missing = await uploadGate('UPLOAD_PAGE_REQUIRED');
  assert.equal(missing.gates, 6);
  assert.equal(missing.uploads, 0);
  const login = await uploadGate('LOGIN_REQUIRED');
  assert.equal(login.gates, 1);
  assert.equal(login.uploads, 0);
  console.log('Video submission receipt checks passed: post-click uncertainty, pre-click pause, read-only reconciliation.');
})().catch(error => { console.error(error); process.exitCode = 1; });

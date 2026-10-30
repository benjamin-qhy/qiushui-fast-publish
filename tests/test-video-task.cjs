const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('src/sync/video/task.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function editor({ platform = 'VIDEO_REDNOTE', apiBody, apiStatus = 200, invalidJson = false, weixinIds = [], scheduled, originalRequested, originalChecked = false, scheduleChecked = false, tags = [], nativeTopics = false, hiddenCoverDialog = false, validationErrorText = '', repairCurrentTitle = null, draftRows = 0, draftWrongBody = false, draftTimestamp = true, draftBoxHeading = true, pathName = null, reopenedDraft = false, withSameOriginFrame = false, withDraftButton = false, closedDraftRoot = false, draftAlready = false, horizontalUpload = false, coverEditable = false, coverSelected = false, mode = 'click', actualAccount = 'account', changed = false, clicked = false, publicVisible = true, stateMissing = false, genericSuccess = false } = {}) {
  let clicks = 0; let draftClicks = 0; let coverClicks = 0; let uploadedInput = ''; const requests = [];
  const coverBlob = new Blob(['approved-landscape']);
  const data = { title: 'AI需求澄清', content: '真实正文', expectedAccountId: 'account', tags, video: { sha256: 'a'.repeat(64) } };
  if (closedDraftRoot) data.draftOnly = true;
  if (scheduled !== undefined) data.scheduledPublishTime = scheduled;
  if (originalRequested !== undefined) data.original = originalRequested;
  if (horizontalUpload) data.horizontalCover = { url: 'data:approved-cover', name: 'landscape.png', type: 'image/png', sha256: require('node:crypto').createHash('sha256').update('approved-landscape').digest('hex') };
  if (coverEditable || coverSelected) data.cover = { sha256: 'b'.repeat(64) };
  const node = (extra) => ({ getClientRects: () => [{ width: 100, height: 100 }], getAttribute: () => null, children: [], childNodes: [], dispatchEvent: () => {}, ...extra });
  const title = node({ value: repairCurrentTitle !== null ? repairCurrentTitle : changed ? '被替换的标题' : data.title });
  const body = node({ innerText: [data.content, ...tags.map(tag => '#' + tag + (nativeTopics ? '[话题]#' : ''))].join(' '), querySelectorAll: selector => nativeTopics && (selector.includes('tiptap-topic') || selector === 'span.hl.topic') ? tags.map(tag => node({ textContent: '#' + tag + '[话题]#' })) : [] });
  const preview = node({ currentSrc: 'blob:original' });
  const button = node({ textContent: '发布', disabled: false, click: () => { clicks += 1; } });
  const input = node({ accept: 'video/*', files: [] });
  const selected = JSON.stringify({ selected: ['a'.repeat(64), ...(coverSelected ? ['b'.repeat(64)] : [])], pending: 0, startedAt: 1, clickAttempted: clicked, draftAttempted: draftAlready });
  const store = new Map(stateMissing ? [] : [['fastpublish.video.task', selected]]);
  const exports = {};
  const frame = node({ tagName: 'IFRAME', contentDocument: { querySelectorAll: selector => selector === '*' ? [frame, node({ textContent: '草稿箱' })] : [] } });
  const closedHost = node({ tagName: 'XHS-PUBLISH-BTN' });
  const closedButton = node({ textContent: '暂存离开', disabled: false, click: () => { draftClicks += 1; } });
  const closedRoot = { querySelectorAll: selector => selector === '*' || selector === 'button' ? [closedButton] : [] };
  const document = {
    body: { innerText: reopenedDraft ? '重新上传' : genericSuccess ? '发布成功 已发布' : '' },
    querySelectorAll: (selector) => {
      if (selector === '*') return [...(closedDraftRoot ? [closedHost] : []), ...(validationErrorText ? [node({ textContent: validationErrorText })] : []), ...(withSameOriginFrame ? [frame] : [])];
      if (selector === 'iframe' && withSameOriginFrame) return [frame];
      if (selector === '.title-name' && draftRows && draftBoxHeading) return [node({ textContent: '草稿箱' })];
      if (selector === '.post-title') return Array.from({ length: draftRows }, () => node({ textContent: draftWrongBody ? '其他内容' : data.content, parentElement: { querySelectorAll: () => draftTimestamp ? [node({ textContent: '2026年10月27日 11:48' })] : [] } }));
      if (platform === 'VIDEO_WEIXINCHANNEL' && selector === '.form-item') return [node({ textContent: '声明原创', querySelectorAll: () => [node({ checked: originalChecked })] })];
      if (platform === 'VIDEO_WEIXINCHANNEL' && selector === '.weui-desktop-form__check-label') return ['不定时', '定时'].map(textContent => node({ textContent, querySelectorAll: () => [node({ checked: textContent === '定时' ? scheduleChecked : !scheduleChecked })] }));
      if (hiddenCoverDialog && selector === '.main-cover-editor-modal') return [node({ getClientRects: () => [{ width: 0, height: 0 }] })];
      if (selector === '[data-finder-username]') return weixinIds.map(id => node({ getAttribute: () => id }));
      if (selector === '.custom-switch-card') return [['定时发布', scheduleChecked], ['原创声明', originalChecked]].map(([textContent, checked]) => node({ textContent, querySelectorAll: () => [node({ checked })] }));
      if (horizontalUpload && selector.includes('.dy-creator-content-modal div')) return [node({ textContent: '横封面预览（4:3）' })];
      if (horizontalUpload && selector === '.dy-creator-content-modal') return [node({ textContent: '设置横封面', querySelectorAll: () => ['generic', 'upload-area'].map((id) => node({ accept: 'image/png', className: 'semi-upload-hidden-input', parentElement: node({ textContent: id === 'upload-area' ? '点击上传文件或拖拽文件到这里' : '' }), dispatchEvent: () => { uploadedInput = id; } })) })];
      if (selector === '.cover-plugin-preview .cover--column' && coverEditable) return [node({ querySelectorAll: () => [node({ textContent: '编辑封面', children: [], click: () => { coverClicks += 1; } })] })];
      if (selector === '.dy-creator-content-modal' && coverSelected) return [node({ textContent: '设置竖封面 封面检测完成', querySelectorAll: () => [node({ textContent: '完成', disabled: false, click: () => { coverClicks += 1; } })] })];
      if (selector.includes('input[placeholder')) return [title];
      if (selector === '[contenteditable="true"]' || selector === 'div[data-placeholder="添加描述"]') return [body];
      if (selector === 'video') return [preview];
      if (selector === 'input[type="file"]') return [input];
      if (selector === 'button') return [button, ...(withDraftButton ? [node({ textContent: '保存草稿', disabled: false, click: () => { draftClicks += 1; } })] : [])];
      if (selector.includes('aria-checked')) return publicVisible ? [node({ textContent: '公开' })] : [];
      return [];
    },
  };
  vm.runInNewContext(source, {
    exports, document, chrome: { dom: { openOrClosedShadowRoot: node => closedDraftRoot && node === closedHost ? closedRoot : null } }, window: { top: null }, navigator: { userAgent: "test" }, MutationObserver: class { observe() {} disconnect() {} }, HTMLInputElement: class { set value(value) { Object.defineProperty(this, "value", { value, writable: true, configurable: true }); } }, URL, TextEncoder, AbortSignal, File: require('node:buffer').File, Event, DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } }, setTimeout: callback => callback(), crypto: require('node:crypto').webcrypto, location: { origin: platform === 'VIDEO_DOUYIN' ? 'https://creator.douyin.com' : platform === 'VIDEO_WEIXINCHANNEL' ? 'https://channels.weixin.qq.com' : 'https://creator.xiaohongshu.com', pathname: pathName || '/publish/publish' },
    sessionStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
    fetch: async (url, options) => { requests.push({ url, options }); return url === 'data:approved-cover' ? { ok: true, blob: async () => coverBlob } : ({ ok: apiStatus >= 200 && apiStatus < 300, status: apiStatus, json: async () => { if (invalidJson) throw new SyntaxError('private-response-must-not-be-returned'); return apiBody || ({ code: 0, success: true, data: { userId: actualAccount } }); } }); },
  });
  const result = await exports.videoTaskStep(platform, data, mode, 'task', { videoSources: [require('node:crypto').createHash('sha256').update('blob:original').digest('hex')], coverSources: [], previousTitle: repairCurrentTitle, draftTitleRejected: repairCurrentTitle !== null, draftReopened: reopenedDraft });
  return { result, clicks, draftClicks, coverClicks, store, uploadedInput, requests };
}

(async () => {
  let run = await editor({ mode: 'account', stateMissing: true });
  assert.equal(run.result.status, 'account_verified');
  assert.equal(run.result.evidence.accountId, 'account');
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_DOUYIN', mode: 'account', stateMissing: true,
    apiBody: { status_code: 0, user: { sec_uid: 'target-sec', nickname: 'creator', session_token: 'private-secret' } } });
  assert.equal(run.result.status, 'account_verified');
  assert.equal(run.result.evidence.accountId, 'target-sec');
  assert.equal(run.result.evidence.username, 'creator');
  assert.ok(!JSON.stringify(run.result).includes('private-secret'));
  run = await editor({ platform: 'VIDEO_DOUYIN', mode: 'account', stateMissing: true, apiBody: { status_code: 8, error: 'do-not-return-raw-errors' } });
  assert.equal(run.result.status, 'needs_attention');
  assert.equal(run.result.evidence.accountRead.responseCode, 8);
  assert.ok(!JSON.stringify(run.result).includes('do-not-return-raw-errors'));
  const finderResponse = { errCode: 0, data: { finderUser: { finderUsername: 'account', nickname: 'channel-name' }, userAttr: { username: 'wechat-user-not-channel', nickname: 'different-name', access_token: 'private-secret' }, session: 'private-session' } };
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'account', stateMissing: true, apiBody: finderResponse });
  assert.equal(run.result.status, 'account_verified');
  assert.equal(run.result.evidence.accountId, 'account');
  assert.equal(run.result.evidence.username, 'channel-name');
  assert.equal(run.result.evidence.accountRead.identitySource, 'finderUser.finderUsername');
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].url, '/cgi-bin/mmfinderassistant-bin/auth/auth_data');
  assert.equal(run.requests[0].options.method, 'POST');
  assert.equal(run.requests[0].options.credentials, 'include');
  assert.equal(JSON.parse(run.requests[0].options.body).rawKeyBuff, null);
  assert.ok(!JSON.stringify(run.result).includes('private-'));
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'account', stateMissing: true, apiStatus: 201, apiBody: finderResponse });
  assert.equal(run.result.status, 'account_verified');
  assert.equal(run.result.evidence.accountRead.httpStatus, 201);
  for (const options of [
    { apiBody: { errCode: 1, data: finderResponse.data } },
    { apiBody: { errCode: 0, data: { userAttr: { username: 'account' } } } },
    { apiBody: { errCode: 0, data: { finderUser: { nickname: 'account' } } } },
    { apiBody: { errCode: 0, data: { finderUser: { finderUsername: 'invalid identity' } } } },
    { apiBody: finderResponse, apiStatus: 403 },
    { invalidJson: true },
  ]) {
    run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'account', stateMissing: true, weixinIds: ['account'], ...options });
    assert.equal(run.result.code, 'ACCOUNT_UNVERIFIED');
    assert.equal(run.result.evidence.accountId, null);
    assert.equal(run.clicks, 0);
    assert.equal(run.coverClicks, 0);
    assert.ok(!JSON.stringify(run.result).includes('private-'));
  }
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'gate', stateMissing: true, apiBody: { errCode: 0, data: { finderUser: { finderUsername: 'other@finder' } } } });
  assert.equal(run.result.code, 'ACCOUNT_MISMATCH');
  assert.equal(run.clicks, 0);
  for (const changed of [false, true]) {
    run = await editor({ platform: 'VIDEO_DOUYIN', mode: 'verify_draft', draftAlready: true, reopenedDraft: true, changed,
      pathName: '/creator-micro/content/post/video', apiBody: { status_code: 0, user: { sec_uid: 'account' } } });
    assert.equal(run.result.status, changed ? 'result_unconfirmed' : 'draft_saved');
    assert.equal(run.clicks, 0);
    assert.equal(run.draftClicks, 0);
  }
  run = await editor({ platform: 'VIDEO_REDNOTE', mode: 'save_draft', closedDraftRoot: true });
  assert.equal(run.result.status, 'clicked');
  assert.equal(run.draftClicks, 1);
  assert.equal(run.clicks, 0);
  run = await editor();
  assert.equal(run.result.status, 'clicked');
  assert.equal(run.clicks, 1);
  assert.equal(JSON.parse(run.store.get('fastpublish.video.task')).clickAttempted, true);
  for (const [options, code] of [
    [{ actualAccount: 'someone-else' }, 'ACCOUNT_MISMATCH'],
    [{ actualAccount: '' }, 'ACCOUNT_UNVERIFIED'],
    [{ changed: true }, 'PREPARED_CONTENT_CHANGED'],
    [{ clicked: true }, 'PUBLISH_ALREADY_ATTEMPTED'],
    [{ publicVisible: false }, 'VISIBILITY_UNVERIFIED'],
    [{ stateMissing: true }, 'ORIGINAL_PAGE_REQUIRED'],
  ]) {
    run = await editor(options);
    assert.equal(run.result.code, code);
    assert.equal(run.clicks, 0);
  }
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'inspect', scheduled: 0, originalRequested: true, originalChecked: true, tags: ['AI开发'], nativeTopics: true, apiBody: finderResponse });
  assert.equal(run.result.status, 'filled');
  assert.equal(run.result.evidence.nativeTopicsMatched, true);
  assert.equal(run.result.evidence.originalMatched, true);
  assert.equal(run.result.evidence.scheduleMatched, true);
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'inspect', scheduled: 0, scheduleChecked: true, apiBody: finderResponse });
  assert.equal(run.result.code, 'SCHEDULE_SETTING_NOT_VERIFIED');
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'inspect', originalRequested: true, apiBody: finderResponse });
  assert.equal(run.result.code, 'ORIGINAL_SETTING_NOT_VERIFIED');
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'save_draft', withDraftButton: true, apiBody: finderResponse });
  assert.equal(run.result.status, 'clicked');
  assert.equal(run.draftClicks, 1);
  assert.equal(run.clicks, 0);
  assert.equal(JSON.parse(run.store.get('fastpublish.video.task')).draftAttempted, true);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'save_draft', withDraftButton: true, draftAlready: true, apiBody: finderResponse });
  assert.equal(run.result.code, 'DRAFT_ALREADY_ATTEMPTED');
  assert.equal(run.draftClicks, 0);
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'verify_draft', withDraftButton: true, apiBody: finderResponse });
  assert.equal(run.result.status, 'result_unconfirmed');
  assert.equal(run.draftClicks, 0);
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'verify_draft', validationErrorText: '短标题不能包含特殊字符', apiBody: finderResponse });
  assert.equal(run.result.code, 'DRAFT_TITLE_REJECTED');
  assert.equal(run.result.evidence.draftTitleRejected, true);
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'verify_draft', withSameOriginFrame: true, apiBody: finderResponse });
  assert.equal(run.result.evidence.managerFrameCount, 1);
  assert.ok(run.result.evidence.draftPageLabels.includes('草稿箱'));
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'repair_title', repairCurrentTitle: '旧标题，', draftAlready: true, apiBody: finderResponse });
  assert.equal(run.result.code, 'TITLE_REPAIRED_VERIFY');
  assert.equal(JSON.parse(run.store.get('fastpublish.video.task')).draftAttempted, false);
  assert.equal(run.clicks, 0);
  assert.equal(run.draftClicks, 0);
  run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'verify_draft', draftRows: 1, pathName: '/platform/post/draftListManager', apiBody: finderResponse });
  assert.equal(run.result.status, 'draft_saved');
  assert.equal(run.result.evidence.draftTimeLabel, '2026年10月27日 11:48');
  assert.equal(run.clicks, 0);
  assert.equal(run.draftClicks, 0);
  for (const variation of [{ draftRows: 2 }, { draftWrongBody: true }, { draftTimestamp: false }, { draftBoxHeading: false }, { pathName: '/platform/post/list' }]) {
    run = await editor({ platform: 'VIDEO_WEIXINCHANNEL', mode: 'verify_draft', draftRows: 1, pathName: '/platform/post/draftListManager', apiBody: finderResponse, ...variation });
    assert.equal(run.result.status, 'result_unconfirmed');
    assert.equal(run.clicks, 0);
    assert.equal(run.draftClicks, 0);
  }
  run = await editor({ mode: 'inspect', hiddenCoverDialog: true });
  assert.equal(run.result.status, 'filled');
  assert.equal(run.result.evidence.coverEditorOpen, false);
  run = await editor({ mode: 'save_draft' });
  assert.equal(run.result.code, 'VIDEO_STEP_NOT_SUPPORTED');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'open_cover', coverEditable: true });
  assert.equal(run.result.code, 'COVER_EDITOR_OPENED');
  assert.equal(run.coverClicks, 1);
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_DOUYIN', mode: 'finish_cover', coverSelected: true, apiBody: { status_code: 0, user: { sec_uid: 'account' } } });
  assert.equal(run.result.code, 'COVER_EDITOR_CONFIRMED');
  assert.equal(run.coverClicks, 1);
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect', clicked: true });
  assert.equal(run.result.status, 'filled');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'verify', genericSuccess: true });
  assert.equal(run.result.status, 'result_unconfirmed');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'gate' });
  assert.equal(run.result.code, 'VIDEO_UPLOAD_ALREADY_STARTED');
  assert.equal(run.clicks, 0);
  run = await editor({ platform: 'VIDEO_DOUYIN', mode: 'upload_horizontal_cover', horizontalUpload: true, apiBody: { status_code: 0, user: { sec_uid: 'account' } } });
  assert.equal(run.result.code, 'COVER_FILE_SELECTED');
  assert.equal(run.uploadedInput, 'upload-area');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect', tags: ['AI开发'] });
  assert.equal(run.result.code, 'NATIVE_TOPICS_NOT_VERIFIED');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect', tags: ['AI开发', '需求分析'], nativeTopics: true });
  assert.equal(run.result.evidence.bodyMatched, true);
  assert.equal(run.result.evidence.nativeTopicsMatched, true);
  assert.equal(run.result.status, 'filled');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect', scheduled: 0, originalRequested: false });
  assert.equal(run.result.status, 'filled');
  assert.equal(run.result.evidence.scheduleMatched, true);
  assert.equal(run.result.evidence.originalMatched, true);
  run = await editor({ mode: 'inspect', scheduled: 0, originalRequested: true });
  assert.equal(run.result.code, 'ORIGINAL_SETTING_NOT_VERIFIED');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect', scheduled: 0, scheduleChecked: true });
  assert.equal(run.result.code, 'SCHEDULE_SETTING_NOT_VERIFIED');
  assert.equal(run.clicks, 0);
  run = await editor({ mode: 'inspect_fields' });
  assert.equal(run.result.code, 'VIDEO_OPTIONS_INSPECTED');
  assert.equal(run.clicks, 0);
  await taskLifecycle('start');
  await taskLifecycle('resume');
  await taskLifecycle('reconcile');
  await taskLifecycle('resume', 'upload_cover');
  console.log('Video task checks passed: identity/audience/media guards, persisted upload intent, no resume re-upload, one click, read-only reconcile and no false publication.');
})().catch((error) => { console.error(error); process.exitCode = 1; });

async function taskLifecycle(operation, videoStep) {
  const receipts = [];
  let uploads = 0;
  const steps = [];
  const step = () => {};
  const handler = () => {};
  const background = fs.readFileSync('src/background/services/local-task.ts', 'utf8') + '\nexport { execute as testExecute };';
  const exports = {};
  vm.runInNewContext(ts.transpileModule(background, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (name) => name === '~sync/video/task' ? { videoTaskStep: step }
      : name === '~sync/video/rednote' ? { VideoRednote: handler } : {},
    setTimeout: (callback, ms) => { if (ms >= 10000) return setTimeout(callback, ms).unref(); callback(); },
    clearTimeout,
    fetch: async (_url, options) => { receipts.push(JSON.parse(options.body).receipt); return { ok: true }; },
    chrome: {
      i18n: { getMessage: () => '' },
      storage: { local: { get: async () => operation === 'resume' ? {
        'multipost.local-task.task': { tabId: 7, evidence: { videoUploadStarted: true } },
      } : {}, set: async () => {} } },
      tabs: { create: async () => ({ id: 7, status: 'complete' }), get: async () => ({ id: 7, status: 'complete' }), update: async () => {} },
      scripting: { executeScript: async ({ func, args }) => {
        if (func === handler) {
          uploads += 1;
          assert.equal(args[0].isAutoPublish, false);
          assert.equal(args[0].data.video.url, 'data:video/mp4;base64,upload-only');
          assert.equal(receipts.at(-1).evidence.videoUploadStarted, true);
          return [];
        }
        assert.equal(func, step);
        assert.equal(args[1].video.url, '');
        assert.equal(args[1].video.sha256, 'approved-video-hash');
        assert.equal(args[1].cover.url, args[2] === 'upload_cover' ? 'data:image/png;base64,cover-only' : '');
        steps.push(args[2]);
        return [{ result: { status: args[2] === 'gate' ? 'ready' : args[2] === 'verify' ? 'result_unconfirmed' : 'filled', code: 'TEST', evidence: {} } }];
      } },
    },
  });
  await exports.testExecute({ taskId: 'task', platform: 'VIDEO_REDNOTE', operation,
    action: operation === 'reconcile' ? 'publish' : 'prepare',
    ...(operation === 'reconcile' ? { sourceTaskId: 'prepared', sourceTabId: 7 } : {}),
    ...(videoStep ? { videoStep } : {}),
    data: { title: 'approved title', content: 'body', video: { url: 'data:video/mp4;base64,upload-only', sha256: 'approved-video-hash' }, cover: { url: 'data:image/png;base64,cover-only', sha256: 'cover-hash' } } });
  assert.equal(uploads, operation === 'start' ? 1 : 0);
  if (operation === 'resume') assert.deepEqual(steps, videoStep ? [videoStep] : ['inspect']);
  if (operation === 'reconcile') assert.ok(steps.length && steps.every((mode) => mode === 'verify'));
  assert.equal(receipts.at(-1).status, operation === 'reconcile' ? 'result_unconfirmed' : 'filled');
}

// An interactive creator tab may keep loading media. A readiness probe must
// execute immediately, rather than waiting for the idle state it is probing.
async function interactiveReadiness() {
  const exports = {};
  let tick = 0;
  const original = fs.readFileSync('src/background/services/local-task.ts', 'utf8') + '\nexport { loaded as testLoaded };';
  vm.runInNewContext(ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: () => ({}), Date: { now: () => { tick += 6000; return tick; } },
    chrome: { tabs: { get: async () => ({ id: 7, status: 'loading' }) }, scripting: { executeScript: async (options) => {
      if (!options.injectImmediately) return new Promise(() => {});
      return [{ result: 'interactive' }];
    } } }, setTimeout,
  });
  let timer;
  try {
    await Promise.race([exports.testLoaded(7, true), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Readiness probe waited for idle on an already interactive page')), 50); })]);
  } finally { clearTimeout(timer); }
}
interactiveReadiness().catch(error => { console.error(error.message); process.exitCode = 1; });

async function resumeWakesOriginalPage(discarded = false) {
  const exports = {}; const receipts = []; let active = false;
  const step = () => {};
  const original = fs.readFileSync('src/background/services/local-task.ts', 'utf8') + '\nexport { execute as testExecute };';
  vm.runInNewContext(ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: name => name === '~sync/video/task' ? { videoTaskStep: step } : {},
    setTimeout: (callback, ms) => { if (ms >= 10000) return setTimeout(callback, ms).unref(); callback(); }, clearTimeout,
    fetch: async (_url, options) => { receipts.push(JSON.parse(options.body).receipt); return { ok: true }; },
    chrome: { i18n: { getMessage: () => '' }, storage: { local: { get: async () => ({ 'multipost.local-task.sleeping': { tabId: 7, evidence: { videoUploadStarted: true } } }), set: async () => {} } },
      tabs: { get: async () => ({ id: 7, status: 'complete', active, discarded }), create: async () => { throw Error('Original page must be reused'); }, update: async (id, options) => { assert.equal(id, 7); assert.equal(options.active, true); active = true; } },
      scripting: { executeScript: async ({ args }) => active ? [{ result: { status: 'filled', code: 'TEST', evidence: {} } }] : new Promise(() => {}) },
    },
  });
  let watchdog;
  try {
    await Promise.race([exports.testExecute({ taskId: 'sleeping', platform: 'VIDEO_REDNOTE', operation: 'resume', action: 'prepare', data: { title: 'title', content: 'body' } }), new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('Resume did not wake the original inactive editor')), 100); })]);
    if (discarded) { assert.equal(active, false); assert.equal(receipts.at(-1).code, 'ORIGINAL_PAGE_REQUIRED'); }
    else { assert.equal(active, true); assert.equal(receipts.at(-1).status, 'filled'); }
  } finally { clearTimeout(watchdog); }
}
resumeWakesOriginalPage().catch(error => { console.error(error.message); process.exitCode = 1; });

resumeWakesOriginalPage(true).catch(error => { console.error(error.message); process.exitCode = 1; });

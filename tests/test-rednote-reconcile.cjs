const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.cwd() + '/node_modules/typescript');
const exportsForTest = {};
let refreshes = 0, clicks = 0, checks = 0;
const receipts = [];
const source = fs.readFileSync('src/background/services/local-task.ts','utf8') + '\nexport { execute as testExecute };';
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {
 exports:exportsForTest, require:()=>({}), setTimeout:fn=>fn(),
 chrome:{i18n:{getMessage:()=>''},storage:{local:{get:async()=>({}),set:async()=>{}}},
 tabs:{get:async()=>({id:1,windowId:1,status:'complete',url:'https://creator.xiaohongshu.com/new/note-manager'}),update:async()=>{},reload:async()=>{refreshes++},remove:async()=>{}},
 windows:{update:async()=>{}},scripting:{executeScript:async opts=>{
  if (!opts.args) return [];
  assert.equal(opts.args[2],'verify'); checks++;
  if (opts.args[2]==='click') clicks++;
  return [{result:{status:refreshes?'published':'result_unconfirmed',code:'WORK_ID_CONFIRMED',evidence:{noteId:'a'.repeat(24)}}}];
 }}},
 fetch:async(_url,options)=>{receipts.push(JSON.parse(options.body).receipt);return {ok:true}},
});
(async()=>{
 await exportsForTest.testExecute({taskId:'existing',platform:'DYNAMIC_REDNOTE',action:'publish',operation:'reconcile',sourceTaskId:'prepared',sourceTabId:1,data:{}});
 assert.equal(refreshes,1); assert.equal(clicks,0); assert.equal(checks,1);
 assert.equal(receipts.at(-1).status,'published');
 console.log('Rednote reconcile refreshes stale manager and never clicks publish.');
})().catch(e=>{console.error(e);process.exitCode=1});

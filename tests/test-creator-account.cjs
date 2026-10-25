const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');const assert=require('node:assert/strict');
const output=ts.transpileModule(fs.readFileSync('src/sync/account/rednote.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
(async()=>{
 const exports={};let requests=0;const account={code:0,success:true,data:{userId:'a'.repeat(24),userName:'测试账号',phone:'DO-NOT-RETURN',permissions:['DO-NOT-RETURN']}};
 vm.runInNewContext(output,{exports,chrome:{tabs:{query:async()=>[{id:7}]},scripting:{executeScript:async()=>{requests++;return [{result:account}];}}},fetch:async()=>{throw Error('consumer login unavailable');}});
 const info=await exports.getRednoteAccountInfo();assert.equal(info.accountId,'a'.repeat(24));assert.equal(info.username,'测试账号');assert.equal(requests,1);assert.equal(JSON.stringify(info).includes('DO-NOT-RETURN'),false);
 console.log('Creator-session identity works independently of consumer login and excludes unrelated private fields.');
})().catch(e=>{console.error(e);process.exitCode=1;});

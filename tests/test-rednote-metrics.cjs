const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');const assert=require('node:assert/strict');
const script=ts.transpileModule(fs.readFileSync('src/sync/dynamic/rednote-metrics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const id='a'.repeat(24);const prefixes=['M7.99902 3.83398','M3.18233 10.985','M3.25611 3.91336','M10.8848 14.2322','M8.28672 5.15797'];
function collector(apiOk,wrongIcon=false){
 const exports={};const values=['12','0','1','0','0'];
 const stats=values.map((value,index)=>({querySelector:(sel)=>sel==='span'?{textContent:value}:{getAttribute:()=>wrongIcon?'unknown':prefixes[index]+'...'}}));
 const card={innerText:'',getAttribute:()=>JSON.stringify({noteTarget:{value:{noteId:id}}}),querySelectorAll:()=>stats};
 vm.runInNewContext(script,{exports,location:{origin:'https://creator.xiaohongshu.com',pathname:'/new/note-manager',href:'https://creator.xiaohongshu.com/new/note-manager'},document:{querySelectorAll:()=>[card]},fetch:async()=>({ok:apiOk,json:async()=>({code:0,success:true,data:{notes:[{id,view_count:12,likes:1,collected_count:0,comments_count:0,shared_count:0}],page:-1}})})});
 return exports.collectRednoteMetrics;
}
(async()=>{
 const api=await collector(true)(id);assert.equal(api.evidence.source,'creator_api');assert.equal(api.evidence.metrics['观看'],12);assert.equal(api.evidence.metrics['阅读'],null);
 const dom=await collector(false)(id);assert.equal(dom.evidence.source,'creator_dom_verified_icons');assert.equal(dom.evidence.metrics['观看'],12);assert.equal(dom.evidence.metrics['点赞'],1);assert.equal(dom.evidence.metrics['评论'],0);
 const changed=await collector(false,true)(id);assert.equal(changed.evidence.metrics['点赞'],null);
 console.log('Exact work metrics: API, verified icon fallback, null reading, actual zero and changed-icon refusal passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

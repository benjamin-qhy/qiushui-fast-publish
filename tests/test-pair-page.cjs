const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('skills/qiushui-fast-publish/scripts/pair.html','utf8');
const button = {disabled:false}; const result = {textContent:''};
let listener;let timer;let cleared = false;
const window = {addEventListener:(_type,fn)=>{listener=fn;},removeEventListener:()=>{listener=null;},postMessage:()=>{}};
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
 document:{querySelector:(q)=>q==='#pair'?button:result},window,
 location:{origin:'http://localhost:2663',hash:'#test'},crypto:{randomUUID:()=> 'trace'},
 setTimeout:(fn)=>{timer=fn;return 1;},clearTimeout:()=>{cleared=true;}
});
button.onclick();
const event = {source:window,origin:'http://localhost:2663',data:{type:'response',action:'MULTIPOST_EXTENSION_LOCAL_PAIR',traceId:'trace',code:403,message:'Untrusted origin',data:null}};
listener(event);assert.equal(typeof listener,'function');assert.equal(cleared,false);
listener({...event,data:{...event.data,code:0,data:{paired:true,extensionId:'test'}}});
assert.equal(cleared,true);assert.equal(listener,null);assert.match(result.textContent,/配对成功/);
button.onclick();listener(event);timer();assert.equal(button.disabled,false);assert.match(result.textContent,/Untrusted origin/);
console.log('Pair page ignores legacy rejection and confirms FastPublish success; timeout remains retryable.');

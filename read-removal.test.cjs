const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname+'/read-removal.js','utf8');
const A='7418563660705975320', B='7602504106078391321', C='7665193065501445145';
function context(extra={}) {
  const c={navigator:{},CFG:{user:'test',repo:'newtomato'},b64DecodeUTF8:s=>s,
    isStatusShaConflict:e=>e.message==='409',statusSyncDelay:async()=>{},...extra};
  vm.createContext(c);vm.runInContext(source,c);return c;
}
test('paste accepts separators and deduplicates string IDs without losing precision',()=>{
  const c=context();const r=c.parseHomeUnreadIds(`${A}|${B}\n${A}, ${C}\tbad`);
  assert.deepEqual(Array.from(r.ids),[A,B,C]);assert.deepEqual(Array.from(r.invalid),['bad']);
});
test('only selected IDs are deleted; SHA conflict reloads and retains concurrent additions',async()=>{
  let reads=0,writes=0;const c=context({
    ghGetFile:async()=>({sha:String(++reads),content:JSON.stringify(reads===1?[A,B]:[A,B,C])}),
    ghPutFile:async(path,body,message,sha)=>{
      assert.equal(path,'data/read.json');writes++;
      if(writes===1)throw Error('409');
      assert.equal(sha,'2');assert.deepEqual(JSON.parse(body),[B,C]);
    }});
  const r=await c.removeReadIds([A,'1234567890123456']);
  assert.equal(r.removed,1);assert.equal(r.absent,1);assert.equal(writes,2);
});
test('IDs already absent cause no write',async()=>{
  const c=context({ghGetFile:async()=>({content:JSON.stringify([B])}),ghPutFile:async()=>assert.fail('unexpected write')});
  assert.equal((await c.removeReadIds([A])).removed,0);
});
test('failed writes propagate so the form can retain pasted IDs for retry',async()=>{
  const c=context({ghGetFile:async()=>({sha:'x',content:JSON.stringify([A])}),ghPutFile:async()=>{throw Error('403');}});
  await assert.rejects(c.removeReadIds([A]),/403/);
});

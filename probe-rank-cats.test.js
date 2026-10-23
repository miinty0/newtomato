const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateIds, classifyRankResponse, probeRankCats } = require('./probe-rank-cats');
const empty = { rankMold2: [], rankMold1: [] };
const ok = total => ({ status:200, data:JSON.stringify({code:0,data:{total_num:total,book_list:[]}}) });
test('missing-only excludes all valid IDs across both molds, includes new IDs above 2000 and ignores the old cursor',()=>{
  const existing={rankMold2:[{cat_id:1}],rankMold1:[{cat_id:2,gender:1}],last_probed_cat_id:1000};
  assert.deepEqual(candidateIds([{id:1},{id:2},{id:3},{id:3001},{id:3}],existing),[3,3001]);
  assert.deepEqual(candidateIds([{id:1},{id:2},{id:3}],existing,{missingOnly:false}),[1,2,3]);
});
test('existing rankcats make no API calls; both genders are checked for other categories',async()=>{
  const calls=[];
  const existing={rankMold2:[{cat_id:1}],rankMold1:[{cat_id:2,gender:1}]};
  const result=await probeRankCats([{id:1},{id:2},{id:3}],existing,{
    request:async url=>{calls.push(new URL(url).searchParams);return ok(0)},sleep:async()=>{},log(){},
  });
  assert.equal(calls.length,4);
  assert.ok(calls.every(p=>p.get('category_id')==='3'));
  assert.deepEqual(calls.map(p=>[p.get('rankMold'),p.get('gender')]),[['2','0'],['2','1'],['1','0'],['1','1']]);
  assert.deepEqual(result.report.no_rank_ids,[3]);
  assert.equal(result.report.excluded_known,2);
  assert.deepEqual(result.config.rankMold1,existing.rankMold1);
});
test('discoveries record the correct mold and gender without deleting or changing existing entries',async()=>{
  const existing={rankMold2:[{cat_id:8,gender:1}],rankMold1:[{cat_id:24}]};
  const checkpoints=[];
  const result=await probeRankCats([{id:953}],existing,{
    request:async url=>{
      const p=new URL(url).searchParams;
      return ok(p.get('rankMold')==='2'&&p.get('gender')==='0'?0:10);
    },sleep:async()=>{},log(){},checkpoint:(config,report)=>checkpoints.push(JSON.parse(JSON.stringify({config,report}))),
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:8,gender:1},{cat_id:953,gender:1}]);
  assert.deepEqual(result.config.rankMold1,[{cat_id:24},{cat_id:953}]);
  assert.deepEqual(result.report.newly_valid_ids,[953]);
  assert.ok(checkpoints.some(c=>c.config.rankMold2.some(e=>e.cat_id===953)));
});
test('three consecutive empty bodies stop immediately and checkpoint the first affected category',async()=>{
  let calls=0;
  const result=await probeRankCats([{id:564},{id:565}],empty,{
    request:async()=>{calls++;return {status:200,data:''}},sleep:async()=>{},log(){},
  });
  assert.equal(calls,3);
  assert.equal(result.report.stop_reason,'empty_body_streak');
  assert.equal(result.report.resume_start,564);
  assert.equal(result.report.no_rank_ids.length,0);
  assert.equal(result.report.unresolved.length,3);
});
test('valid responses reset the empty-body counter; errors are not treated as confirmed zero',async()=>{
  let calls=0;
  const result=await probeRankCats([{id:1},{id:2}],empty,{
    request:async()=>{calls++;return calls===3?ok(0):{status:200,data:''}},sleep:async()=>{},log(){},
  });
  assert.equal(calls,6);
  assert.equal(result.report.resume_start,1);
  assert.equal(result.report.no_rank_ids.length,0);
});
test('positive discoveries are retained when later requests hit the empty-body stop',async()=>{
  let calls=0;
  const result=await probeRankCats([{id:1},{id:2}],empty,{
    request:async()=>++calls===1?ok(4):{status:200,data:''},sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:1}]);
  assert.equal(result.report.stop_reason,'empty_body_streak');
  assert.deepEqual(candidateIds([{id:1},{id:2}],result.config),[2]);
});
test('positive book IDs survive malformed JSON, whereas empty or structurally invalid responses remain errors',()=>{
  assert.equal(classifyRankResponse({status:200,data:'{"code":0,"data":{"book_list":[{"book_id":"6886382789659200519",'}).hasBooks,true);
  for(const response of [{status:200,data:''},{status:200,data:'{"code":0,"data":{}}'},{status:200,data:'{"code":1,"data":{"total_num":0}}'},{status:403,data:''}]) {
    assert.throws(()=>classifyRankResponse(response));
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateIds, classifyRankResponse, probeRankCats } = require('./probe-rank-cats');
const empty = { rankMold2: [], rankMold1: [] };
const ok = total => ({ status:200, data:JSON.stringify({code:0,data:{total_num:total,book_list:[]}}) });
test('missing-only excludes all valid IDs across both molds, includes new IDs above 2000 and ignores the old cursor',()=>{
  const existing={rankMold2:[{cat_id:1}],rankMold1:[{cat_id:2,gender:1}],last_probed_cat_id:1000};
  assert.deepEqual(candidateIds([{id:1},{id:2},{id:3},{id:3001},{id:3}],existing,{missingOnly:true}),[3,3001]);
  assert.deepEqual(candidateIds([{id:1},{id:2},{id:3}],existing,{missingOnly:false}),[1,2,3]);
});
test('existing rankcats make no API calls; both genders are checked for other categories',async()=>{
  const calls=[];
  const existing={rankMold2:[{cat_id:1}],rankMold1:[{cat_id:2,gender:1}]};
  const result=await probeRankCats([{id:1},{id:2},{id:3}],existing,{
    missingOnly:true,
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
    missingOnly:true,
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
  const result=await probeRankCats([{id:1},{id:2},{id:3}],empty,{
    request:async()=>{calls++;return calls===3?ok(0):{status:200,data:''}},sleep:async()=>{},log(){},
  });
  assert.equal(calls,6);
  assert.equal(result.report.resume_start,2);
  assert.equal(result.report.no_rank_ids.length,0);
});
test('positive discoveries are retained when later requests hit the empty-body stop',async()=>{
  let calls=0;
  const result=await probeRankCats([{id:1},{id:2}],empty,{
    request:async()=>++calls===1?ok(4):{status:200,data:''},sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:1}]);
  assert.equal(result.report.stop_reason,'empty_body_streak');
  assert.deepEqual(candidateIds([{id:1},{id:2}],result.config,{missingOnly:true}),[2]);
});
test('positive book IDs survive malformed JSON, whereas empty or structurally invalid responses remain errors',()=>{
  assert.equal(classifyRankResponse({status:200,data:'{"code":0,"data":{"book_list":[{"book_id":"6886382789659200519",'}).hasBooks,true);
  for(const response of [{status:200,data:''},{status:200,data:'{"code":0,"data":{}}'},{status:200,data:'{"code":1,"data":{"total_num":0}}'},{status:403,data:''}]) {
    assert.throws(()=>classifyRankResponse(response));
  }
});

test('full revalidation corrects category 261 Mold 2 from gender 0 to 1 using the supplied total_num responses',async()=>{
  const existing={rankMold2:[{cat_id:261}],rankMold1:[{cat_id:261,gender:1}]};
  const calls=[];
  const result=await probeRankCats([{id:261}],existing,{
    request:async url=>{
      const p=new URL(url).searchParams;
      calls.push([p.get('rankMold'),p.get('gender')]);
      return {status:200,data:JSON.stringify({code:0,data:p.get('gender')==='0'
        ? {book_list:[],total_num:0}
        : {book_list:[{bookId:'7630067790849788953'}],total_num:100}})};
    },sleep:async()=>{},log(){},
  });
  assert.deepEqual(calls,[['2','0'],['2','1'],['1','0'],['1','1']]);
  assert.deepEqual(result.config.rankMold2,[{cat_id:261,gender:1}]);
  assert.deepEqual(result.config.rankMold1,[{cat_id:261,gender:1}]);
  assert.ok(result.report.changes.some(e=>e.id===261&&e.rankMold===2&&e.previous_gender===0&&e.gender===1));
  assert.equal(result.report.mode,'revalidate_all');
});
test('full mode also rechecks old valid IDs missing from the category catalogue',()=>{
  assert.deepEqual(candidateIds([{id:1}],{rankMold2:[{cat_id:261}],rankMold1:[]}),[1,261]);
});
test('old Mold is removed only after both genders successfully return total_num=0',async()=>{
  const existing={rankMold2:[{cat_id:261,gender:1},{cat_id:999}],rankMold1:[{cat_id:261,gender:1}]};
  const result=await probeRankCats([{id:261}],existing,{
    start:261,end:261,request:async url=>ok(new URL(url).searchParams.get('rankMold')==='1'?1:0),sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:999}]);
  assert.deepEqual(result.config.rankMold1,[{cat_id:261}]);
});
test('one unresolved gender and one confirmed zero preserve the old Mold instead of deleting it',async()=>{
  const existing={rankMold2:[{cat_id:261,gender:1}],rankMold1:[]};
  const result=await probeRankCats([{id:261}],existing,{
    request:async url=>new URL(url).searchParams.get('gender')==='1'?{status:200,data:'bad json'}:ok(0),sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,existing.rankMold2);
  assert.ok(result.report.unresolved.length>0);
  assert.equal(result.report.no_rank_ids.length,0);
});
test('gender 0 with books replaces an old gender 1 without calling gender 1',async()=>{
  const result=await probeRankCats([{id:261}],{rankMold2:[{cat_id:261,gender:1}],rankMold1:[]},{
    request:async()=>ok(10),sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:261}]);
  assert.equal(result.report.api_requests,2);
});
test('explicit total_num controls classification; camelCase bookId is recognized when total_num is absent',()=>{
  assert.deepEqual(classifyRankResponse({status:200,data:JSON.stringify({code:0,data:{total_num:0,book_list:[{bookId:'7630067790849788953'}]}})}),{hasBooks:false,totalNum:0});
  assert.equal(classifyRankResponse({status:200,data:JSON.stringify({code:0,data:{book_list:[{bookId:'7630067790849788953'}]}})}).hasBooks,true);
  assert.equal(classifyRankResponse({status:200,data:'{"data":{"book_list":[{"bookId":"7630067790849788953",'}).hasBooks,true);
});

test('malformed JSON recovers complete total_num=0 and total_num=100 with identical classification',()=>{
  for(const [field,count] of [['0,',0],['100,',100],['"0",',0],['"100",',100]]){
    const result=classifyRankResponse({status:200,data:'{"code":0,"data":{"total_num":'+field});
    assert.deepEqual(result,{hasBooks:count>0,totalNum:count,recoveredFromInvalidJson:true});
  }
});
test('a complete total_num=0 takes precedence over bookId even in malformed JSON',()=>{
  const result=classifyRankResponse({status:200,data:'{"code":0,"data":{"bookId":"7630067790849788953","total_num":0,'});
  assert.equal(result.hasBooks,false);
  assert.equal(result.totalNum,0);
});
test('truncated, unsafe and invalid total_num fields cannot confirm an empty or positive ranking',()=>{
  for(const raw of [
    '{"code":0,"data":{"total_num":100',
    '{"code":0,"data":{"total_num":"100',
    '{"code":0,"data":{"total_num":-1,',
    '{"code":0,"data":{"total_num":"abc",',
    '{"code":0,"data":{"total_num":9007199254740993,',
    '{"code":1,"data":{"total_num":0,',
  ]) assert.throws(()=>classifyRankResponse({status:200,data:raw}));
});
test('recovered totals correct the gender of an existing rankcat exactly like valid JSON',async()=>{
  const result=await probeRankCats([{id:261}],{rankMold2:[{cat_id:261}],rankMold1:[]},{
    request:async url=>{
      const p=new URL(url).searchParams;
      const count=p.get('gender')==='1'?100:0;
      return {status:200,data:'{"code":0,"data":{"total_num":'+count+','};
    },sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[{cat_id:261,gender:1}]);
  assert.deepEqual(result.config.rankMold1,[{cat_id:261,gender:1}]);
  assert.equal(result.report.unresolved.length,0);
  assert.ok(result.report.checks.every(check=>check.recovered_from_invalid_json));
});
test('an old Mold is removed when both genders have a complete recovered total_num=0',async()=>{
  const result=await probeRankCats([{id:261}],{rankMold2:[{cat_id:261,gender:1}],rankMold1:[]},{
    request:async()=>({status:200,data:'{"code":0,"data":{"total_num":0,'}),sleep:async()=>{},log(){},
  });
  assert.deepEqual(result.config.rankMold2,[]);
  assert.deepEqual(result.report.no_rank_ids,[261]);
});

test('gender 0 errors never cause gender 1 requests, and old configuration is preserved',async()=>{
  const calls=[];
  const existing={rankMold2:[{cat_id:261,gender:1}],rankMold1:[{cat_id:261,gender:1}]};
  const result=await probeRankCats([{id:261}],existing,{
    request:async url=>{const p=new URL(url).searchParams;calls.push([p.get('rankMold'),p.get('gender')]);return {status:200,data:''}},
    sleep:async()=>{},log(){},
  });
  assert.deepEqual(calls,[['2','0'],['1','0']]);
  assert.deepEqual(result.config.rankMold2,existing.rankMold2);
  assert.deepEqual(result.config.rankMold1,existing.rankMold1);
  assert.equal(result.report.unresolved.length,2);
});
test('a recovered positive total at gender 0 avoids all gender 1 requests',async()=>{
  const calls=[];
  const result=await probeRankCats([{id:261}],empty,{
    request:async url=>{calls.push(new URL(url).searchParams.get('gender'));return {status:200,data:'{"code":0,"data":{"total_num":100,'}},
    sleep:async()=>{},log(){},
  });
  assert.deepEqual(calls,['0','0']);
  assert.deepEqual(result.config.rankMold2,[{cat_id:261}]);
  assert.deepEqual(result.config.rankMold1,[{cat_id:261}]);
});
test('bookId with an unknown total does not trigger a gender 1 request',async()=>{
  const calls=[];
  const result=await probeRankCats([{id:261}],empty,{
    request:async url=>{calls.push(new URL(url).searchParams.get('gender'));return {status:200,data:'{"code":0,"data":{"book_list":[{"bookId":"7630067790849788953"}]}}'}},
    sleep:async()=>{},log(){},
  });
  assert.deepEqual(calls,['0','0']);
  assert.deepEqual(result.config.rankMold2,[{cat_id:261}]);
});

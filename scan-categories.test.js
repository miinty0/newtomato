const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifyCategoryResponse, fetchFirstBookId } = require('./scan-categories');
const empty250 = {code:0,data:{book_list:[],has_more:false,total_count:0},message:'success'};
const found953 = {code:0,data:{book_list:[{book_id:'6886382789659200519',book_name:'马云新传'}],has_more:true,total_count:60},message:'success'};
test('250: explicit empty result is accepted after exactly one request',async()=>{
  let calls=0;
  const result=await fetchFirstBookId(250,async url=>{
    calls++;
    assert.equal(new URL(url).searchParams.get('category_id'),'250');
    return {status:200,data:JSON.stringify(empty250)};
  });
  assert.deepEqual(result,{status:'empty'});
  assert.equal(calls,1);
});
test('953: book_id is preserved exactly and takes priority over contradictory empty counters',async()=>{
  let calls=0;
  const result=await fetchFirstBookId(953,async()=>{
    calls++;return {status:200,data:JSON.stringify(found953)};
  });
  assert.deepEqual(result,{status:'found',bookId:'6886382789659200519'});
  assert.equal(calls,1);
  assert.equal(classifyCategoryResponse({...found953,data:{...found953.data,has_more:false,total_count:0}}).status,'found');
});
test('empty body, bad JSON, missing fields, API errors and HTTP failures are never classified as no books or retried',async()=>{
  for(const response of [
    {status:200,data:''},{status:200,data:'   '},{status:200,data:'{"code":'},
    {status:200,data:'{"code":0,"data":{"book_list":[]}}'},
    {status:200,data:'{"code":0,"data":{"book_list":[],"has_more":true,"total_count":60}}'},
    {status:200,data:'{"code":1,"data":{"has_more":false,"total_count":0}}'},
    {status:429,data:''},{status:500,data:''},
  ]){
    let calls=0;
    await assert.rejects(fetchFirstBookId(953,async()=>{calls++;return response}));
    assert.equal(calls,1);
  }
});
async function runMain(id, apiBody, metadata) {
  const files={};
  const logs=[];
  const requests=[];
  const source=fs.readFileSync(path.join(__dirname,'scan-categories.js'),'utf8');
  const fakeFs={readdirSync:()=>[],writeFileSync:(name,value)=>files[name]=value};
  const ctx=vm.createContext({
    require:name=>name==='fs'?fakeFs:require(name),module:{exports:{}},
    process:{argv:['node','scan',String(id),String(id),'--missing-only'],env:{},stdout:{write:value=>logs.push(value)}},
    console:{log:value=>logs.push(value)},Buffer,URL,URLSearchParams,setTimeout,
  });
  ctx.requests=requests;ctx.apiBody=apiBody;ctx.metadata=metadata;
  vm.runInContext(source,ctx);
  vm.runInContext("sleep=async()=>{}; httpGet=async url=>{ requests.push(url); return url.includes('book_list') ? {status:200,data:apiBody} : {status:200,data:metadata}; };",ctx);
  await vm.runInContext('main()',ctx);
  return {files,logs,requests,report:JSON.parse(files['scan-categories-report.json'])};
}
test('main: empty response is logged as no books; empty HTTP body instead records unresolved ID',async()=>{
  let r=await runMain(250,JSON.stringify(empty250),'');
  assert.equal(r.requests.length,1);
  assert.ok(r.logs.some(line=>line.includes('no books — skip')));
  assert.equal(r.report.confirmed_empty,1);
  assert.equal(r.report.unresolved.length,0);
  r=await runMain(953,'','');
  assert.equal(r.requests.length,1);
  assert.ok(!r.logs.some(line=>line.includes('no books — skip')));
  assert.ok(r.logs.some(line=>line.includes('cat 953/953: UNRESOLVED')));
  assert.equal(r.report.unresolved[0].id,953);
});
test('main: 953 with book_id fetches the detail page and saves its category metadata',async()=>{
  const state={page:{categoryV2:JSON.stringify([{ObjectId:953,Name:'分类953',ExternalDesc:'description'}])}};
  const detail='window.__INITIAL_STATE__='+JSON.stringify(state)+';\n';
  const r=await runMain(953,JSON.stringify(found953),detail);
  assert.equal(r.requests.length,2);
  assert.ok(r.requests[1].endsWith('/page/6886382789659200519'));
  const saved=JSON.parse(r.files['categories_1-2000.json']);
  assert.deepEqual(saved,[{id:953,name:'分类953',desc:'description'}]);
  assert.equal(r.report.have_books,1);
  assert.equal(r.report.unresolved.length,0);
  assert.ok(!r.logs.some(line=>line.includes('no books — skip')));
});
test('main: book_id with unreadable detail metadata remains unresolved, never empty',async()=>{
  const r=await runMain(953,JSON.stringify(found953),'<html>blocked</html>');
  assert.equal(r.requests.length,2);
  assert.equal(r.report.confirmed_empty,0);
  assert.equal(r.report.have_books,1);
  assert.equal(r.report.unresolved[0].id,953);
  assert.ok(!r.logs.some(line=>line.includes('no books — skip')));
});

test('invalid JSON with a complete quoted or numeric book_id still reads the detail page and saves verified metadata',async()=>{
  const detail='window.__INITIAL_STATE__='+JSON.stringify({page:{categoryV2:JSON.stringify([{ObjectId:953,Name:'分类953',ExternalDesc:''}])}})+';\n';
  for(const body of [
    '{"code":0,"data":{"book_list":[{"book_id":"6886382789659200519","abstract":',
    '{"code":0,"data":{"book_list":[{"book_id":6886382789659200519,"abstract":',
  ]){
    let calls=0;
    const result=await fetchFirstBookId(953,async()=>{calls++;return {status:200,data:body}});
    assert.equal(result.bookId,'6886382789659200519');
    assert.equal(result.recoveredFromInvalidJson,true);
    assert.equal(calls,1);
    const run=await runMain(953,body,detail);
    assert.equal(run.requests.length,2);
    assert.ok(run.requests[1].endsWith('/page/6886382789659200519'));
    assert.equal(JSON.parse(run.files['categories_1-2000.json'])[0].id,953);
    assert.equal(run.report.unresolved.length,0);
  }
});
test('invalid JSON with missing or truncated book_id stays unresolved',async()=>{
  for(const body of [
    '{"data":{"book_list":[{"book_id":"688638278965920',
    '{"data":{"book_list":[{"book_id":688638278965920',
    '{"data":{"book_list":[{"book_id":null,',
    '{"data":{"book_list":[{"book_id":"",',
    '{"data":{"book_list":[{"book_id":"0",',
    '{"data":{"book_list":[{"book_id":"688abc",',
  ]){
    await assert.rejects(fetchFirstBookId(953,async()=>({status:200,data:body})),/no complete book_id/);
  }
});

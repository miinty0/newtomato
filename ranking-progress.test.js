const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'ranking-tab.js'),'utf8');
const utils=require('./ranking-utils');
function environment(storage=new Map()) {
  let now=Date.parse('2026-10-23T08:00:00Z');
  const RealDate=Date;
  class ClockDate extends RealDate {constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
  class Option {constructor(text,value){this.textContent=text;this.value=value;this.dataset={};this.disabled=false}}
  function select(rows,value) {return {value,options:rows.map(([v,t])=>new Option(t,v)),style:{},replaceChildren(...options){this.options=options;if(!options.some(o=>o.value===this.value))this.value=options[0]?.value||''}}}
  const nodes={
    'fq-ranking-type':select([['app-101','101 – Đề cử'],['app-135','135 – Theo thể loại'],['app-200','200 – Đỉnh cao'],['peak','Đỉnh cao web'],['reading','Đang đọc web'],['new','Truyện mới web'],['landing','Tìm kiếm']],'app-101'),
    'fq-ranking-gender':select([['2','Toàn bộ'],['1','Nam tần'],['0','Nữ tần']],'2'),
    'fq-ranking-period':select([['daily','Hằng ngày'],['weekly','Hằng tuần'],['monthly','Hằng tháng']],'daily'),
    'fq-ranking-subtab':select([['auto','Theo giới tính'],['1','Bảng tháng'],['5','Nam tần'],['4','Nữ tần']],'auto'),
    'fq-ranking-category':select([['24','24 – Mau xuyên']],'24'),
    'fq-ranking-info':{},'fq-ranking-run-checks':{},
    'fq-ranking-sections':{replaceChildren(){}},'fq-ranking-words':{replaceChildren(){}},
  };
  const calls=[],logs=[],events={};
  const ctx=vm.createContext({
    CFG:{user:'u',repo:'newtomato'},Date:ClockDate,Option,CATEGORY_NAMES:{24:'Mau xuyên'},booksPage:{rankings:1},
    document:{getElementById:id=>nodes[id]},window:{addEventListener:(name,fn)=>events[name]=fn},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    FqRankings:utils,pendingRead:{rankings:new Set()},automaticReadHidden:new Set(),
    filterByStatus:books=>books,console:{warn(){},log:message=>logs.push(message)},
    ghRaw:async file=>file.includes('ranking-categories')?{male:[{id:'24',name:'快穿'}],female:[{id:'24',name:'快穿'}]}:file.includes('ranking-snapshot')?{peak:{books:[]},fetched_at:'old'}:[],
  });
  vm.runInContext(source,ctx);
  vm.runInContext("renderRankings=()=>{}; fqRankRequest=async(action,payload)=>{ calls.push({action,payload}); return {books:[{book_id:'123',abstract:'safe'}],has_more:false,next_offset:1};};",Object.assign(ctx,{calls}));
  function mark(type='app-101',period='daily',gender='2') {
    nodes['fq-ranking-type'].value=type;nodes['fq-ranking-period'].value=period;nodes['fq-ranking-gender'].value=gender;nodes['fq-ranking-subtab'].value='auto';
    vm.runInContext('fqMarkRankingRun(fqRankingRunScope(),fqRankingProgressDay())',ctx);
  }
  return {ctx,nodes,calls,logs,events,storage,mark,setNow:value=>now=Date.parse(value)};
}
test('three genders complete a period; all three periods complete the board',()=>{
  const {ctx,nodes,mark}=environment();
  mark('app-101','monthly','2');
  assert.equal(vm.runInContext("fqRankingPeriodDone('app-101','monthly')",ctx),false);
  assert.ok(nodes['fq-ranking-gender'].options[0].textContent.startsWith('✓'));
  mark('app-101','monthly','1');mark('app-101','monthly','0');
  assert.equal(vm.runInContext("fqRankingPeriodDone('app-101','monthly')",ctx),true);
  assert.ok(nodes['fq-ranking-period'].options.find(o=>o.value==='monthly').textContent.startsWith('✓'));
  assert.equal(vm.runInContext("fqRankingBoardDone('app-101')",ctx),false);
  for(const period of ['daily','weekly'])for(const gender of ['2','1','0'])mark('app-101',period,gender);
  assert.equal(vm.runInContext("fqRankingBoardDone('app-101')",ctx),true);
  assert.ok(nodes['fq-ranking-type'].options[0].textContent.startsWith('✓'));
  assert.ok(!nodes['fq-ranking-type'].options[1].textContent.startsWith('✓'));
  vm.runInContext('fqRenderRankingChecks();fqRenderRankingChecks()',ctx);
  assert.ok(!nodes['fq-ranking-type'].options[0].textContent.includes('✓ ✓'));
});
test('checks survive reload, reset at the Vietnam day boundary and are isolated by repository',()=>{
  const e=environment();e.mark();
  const reloaded=environment(e.storage);
  assert.equal(vm.runInContext('fqRankingScopeDone(fqRankingRunScope())',reloaded.ctx),true);
  reloaded.setNow('2026-10-23T17:00:01Z');
  vm.runInContext('fqRenderRankingChecks()',reloaded.ctx);
  assert.equal(vm.runInContext('fqRankingScopeDone(fqRankingRunScope())',reloaded.ctx),false);
  vm.runInContext("CFG.repo='other'",e.ctx);
  assert.equal(vm.runInContext('fqRankingScopeDone(fqRankingRunScope())',e.ctx),false);
});
test('snapshots and changing dropdowns alone never mark a run',async()=>{
  const {ctx,storage}=environment();
  await vm.runInContext('initRankings()',ctx);
  vm.runInContext('fqRankingChanged()',ctx);
  assert.equal(storage.size,0);
  assert.equal(vm.runInContext('Object.keys(fqLoadRankingProgress().runs).length',ctx),0);
});
test('successful live fetch marks the exact selected gender and period; request errors do not',async()=>{
  const e=environment();
  e.nodes['fq-ranking-period'].value='weekly';e.nodes['fq-ranking-gender'].value='1';
  await vm.runInContext('fqFetchRankings(false)',e.ctx);
  assert.equal(vm.runInContext("fqRankingScopeDone(fqRankingRunScope('app-101',{period:'weekly',gender:'1'}))",e.ctx),true);
  const failed=environment();vm.runInContext("fqRankRequest=async()=>{throw Error('timeout')}",failed.ctx);
  await vm.runInContext('fqFetchRankings(false)',failed.ctx);
  assert.equal(vm.runInContext('Object.keys(fqLoadRankingProgress().runs).length',failed.ctx),0);
});
test('a changed selection during an in-flight fetch cannot mark the new selection',async()=>{
  const e=environment();
  let release,started;
  const entered=new Promise(resolve=>started=resolve);
  const gate=new Promise(resolve=>release=resolve);
  e.ctx.mockRequest=async()=>{started();await gate;return {books:[],has_more:false,next_offset:0}};
  vm.runInContext('fqRankRequest=mockRequest',e.ctx);
  const running=vm.runInContext('fqFetchRankings(false)',e.ctx);
  await entered;
  e.nodes['fq-ranking-gender'].value='0';
  vm.runInContext('fqRankingChanged(true)',e.ctx);
  release();await running;
  assert.equal(vm.runInContext('Object.keys(fqLoadRankingProgress().runs).length',e.ctx),0);
});
test('an overnight in-flight request does not create a fresh check for the next day',()=>{
  const e=environment();const oldDay=vm.runInContext('fqRankingProgressDay()',e.ctx);
  e.ctx.oldDay=oldDay;e.setNow('2026-10-23T17:00:01Z');
  vm.runInContext('fqMarkRankingRun(fqRankingRunScope(),oldDay)',e.ctx);
  assert.equal(vm.runInContext('Object.keys(fqLoadRankingProgress().runs).length',e.ctx),0);
});
test('app 200 follows its three supported sub-tabs rather than nonexistent daily/weekly/monthly controls',()=>{
  const e=environment();
  for(const gender of ['2','1','0'])e.mark('app-200','daily',gender);
  assert.equal(vm.runInContext("fqRankingBoardDone('app-200')",e.ctx),true);
  assert.ok(e.nodes['fq-ranking-type'].options.find(o=>o.value==='app-200').textContent.startsWith('✓'));
  for(const option of e.nodes['fq-ranking-subtab'].options)assert.ok(option.textContent.startsWith('✓'));
});
test('category selector is hidden for APP rankings and enabled only for the two web category boards',()=>{
  const e=environment();
  e.nodes['fq-ranking-type'].value='app-135';
  vm.runInContext('fqRankingChanged()',e.ctx);
  assert.equal(e.nodes['fq-ranking-category'].hidden,true);
  assert.equal(e.nodes['fq-ranking-category'].disabled,true);
  e.nodes['fq-ranking-type'].value='reading';
  vm.runInContext('fqRankingChanged()',e.ctx);
  assert.equal(e.nodes['fq-ranking-category'].hidden,false);
  assert.equal(e.nodes['fq-ranking-category'].disabled,false);
  assert.equal(e.nodes['fq-ranking-gender'].options[0].disabled,true);
});
test('category diagnostic compares APP 135 category 0 and 24 without marking them as reviewed',async()=>{
  const e=environment();
  vm.runInContext("fqRankRequest=async(action,payload)=>{calls.push({action,payload});return {ok:true,params:{algo_type:'135',category_id:String(payload.categoryId)},raw:{data:{cell_view:{algo:135,book_data:[{book_id:'123',category:'24'}]},next_offset:12,has_more:true}},cells:[]};};",e.ctx);
  const report=await vm.runInContext('fqDiagnoseRankingCategory(24)',e.ctx);
  assert.deepEqual(e.calls.map(call=>[call.action,call.payload.algoType,call.payload.categoryId]),[['app-rank-probe',135,0],['app-rank-probe',135,24]]);
  assert.equal(report.results[1].params.category_id,'24');
  assert.equal(report.comparison.sameFirstPageIds,true);
  assert.equal(vm.runInContext('Object.keys(fqLoadRankingProgress().runs).length',e.ctx),0);
  assert.ok(e.logs[0].startsWith('FQ_CATEGORY_DIAGNOSTIC'));
});

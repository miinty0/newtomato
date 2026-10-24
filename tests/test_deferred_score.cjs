const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
test('qualified index scan continues past missing scores and invokes bridge only after the direct pass',async()=>{
  const events=[];const cache=new Map();
  const state={tab:'daily',rankMax:100,candidates:Array.from({length:20},(_,i)=>({id:String(i+1),minimum:8})),cursor:0,matches:[],running:false,errors:0};
  const start=html.indexOf('function advanceQualifiedCursor');
  const end=html.indexOf('function retryQualifiedScoreScan',start);
  const ctx={state, scoreCache:cache,scoreSharePhaseDepth:0,booksPage:{daily:1},BOOKS_PER_PAGE:30,
    qualifiedScanIsCurrent:()=>true,
    refreshQualifiedMatches:s=>{s.matches=s.candidates.slice(0,s.cursor).filter(r=>cache.has(r.id));},
    drawQualifiedScorePage(){},scheduleQualifiedDraw(){},clearTimeout(){},requestStatusFlush(){},
    requestScoreDirect:async id=>{events.push('share:'+id);if(id!=='1'&&id!=='9')cache.set(id,'9');},
    runDeferredScoreBridge:async ids=>{for(const id of ids){events.push('bridge:'+id);cache.set(id,'9');}}};
  vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
  await ctx.scanQualifiedScorePage(state);
  assert.deepEqual(events.slice(0,20),Array.from({length:20},(_,i)=>'share:'+(i+1)));
  assert.deepEqual(events.slice(20),['bridge:1','bridge:9']);
  assert.equal(state.matches.length,20);assert.equal(state.errors,0);assert.equal(ctx.scoreSharePhaseDepth,0);
});
test('index never caches a deferred response as N/A and still applies its metadata',async()=>{
  const start=html.indexOf('function requestScore(bookId');const end=html.indexOf('function loadingScoreIdsInActivePanel',start);
  const scoreCache=new Map(),scoreRequests=new Map(),scoreErrors=new Map(),deferredScoreIds=new Set();let handled=false;
  const ctx={scoreCache,scoreRequests,scoreErrors,deferredScoreIds,
    window:{fqShareApiFetchBookMeta:async()=>({score:null,status:'Ongoing',bridge_deferred:true})},
    handleFetchedBookStatus:()=>handled=true,queueMicrotask:fn=>fn(),
    scoreSharePhaseDepth:1,scoreRetryState:{running:false},scoreBridgeTailActive:false,scoreBridgeTailTimer:null,
    statusFlushAfterInflight:false,maybeFlushStatusesAfterCurrentPage(){}};
  vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
  assert.equal(await ctx.requestScore('1',{deferBridge:true}),null);
  assert.equal(scoreCache.has('1'),false);assert.equal(scoreErrors.size,0);assert.equal(handled,true);
  assert.equal(deferredScoreIds.has('1'),true);
});


function scanHarness({count=40,missing=new Set(),cached=false}={}) {
  const events=[],draws=[],logs=[],cache=new Map(),scans=new Map();
  let candidates=Array.from({length:count},(_,i)=>({id:String(i+1),catId:'24',minimum:9}));
  if(cached)for(const row of candidates)cache.set(row.id,'9');
  const root={dataset:{}};
  const ctx={scoreCache:cache,qualifiedScoreScans:scans,scoreSharePhaseDepth:0,
    categoryViewMode:{rankcat:'all'},statusFilter:'all',booksPage:{rankcat:1},BOOKS_PER_PAGE:30,
    sharedScoreMinimum:()=>9,scoreListLimit:()=>100,rcSelectValue:'24',
    document:{getElementById:()=>({value:''})},qualifiedScanRoot:()=>root,
    qualifiedScanIsCurrent:s=>scans.get(s.tab)===s,
    scoreCandidatesForTab:()=>candidates.map(r=>({...r})),
    refreshQualifiedMatches:s=>s.matches=s.candidates.slice(0,s.cursor).filter(r=>cache.has(r.id)),
    drawQualifiedScorePage:s=>draws.push(s.cursor),scheduleQualifiedDraw(){},clearTimeout(){},requestStatusFlush(){},toast:()=>assert.fail('unexpected error'),
    console:{info:s=>logs.push(s)},
    requestScoreDirect:async id=>{events.push('share:'+id);if(!missing.has(id))cache.set(id,'9');},
    runDeferredScoreBridge:async ids=>{for(const id of ids)events.push('bridge:'+id);}};
  vm.createContext(ctx);
  const a=html.indexOf('function advanceQualifiedCursor');const b=html.indexOf('async function copyQualifiedBookIds',a);
  vm.runInContext(html.slice(a,b),ctx);
  return {ctx,cache,events,draws,logs,scans,setCandidates:rows=>candidates=rows,rows:()=>candidates,
    settled:async()=>{for(let i=0;i<200;i++)await Promise.resolve();}};
}
test('failed bridge tail keeps completed cursor; retry touches only missing IDs',async()=>{
  const h=scanHarness({missing:new Set(['1','9'])});
  h.ctx.renderQualifiedScorePage('rankcat');await h.settled();
  const state=h.scans.get('rankcat');
  assert.equal(state.cursor,40);assert.equal(state.errors,2);
  assert.equal(h.events.filter(x=>x.startsWith('share:')).length,40);
  h.events.length=0;
  h.ctx.renderQualifiedScorePage('rankcat');await h.settled();
  assert.equal(state.cursor,40);assert.deepEqual(h.events,[]);
  h.ctx.retryQualifiedScoreScan('rankcat');await h.settled();
  assert.deepEqual(h.events,['share:1','share:9','bridge:1','bridge:9']);
  assert.equal(state.cursor,40);
});
test('read/status redraws and changing representative category preserve examined IDs',async()=>{
  const h=scanHarness();h.ctx.renderQualifiedScorePage('rankcat');await h.settled();
  const state=h.scans.get('rankcat');assert.equal(state.cursor,40);h.events.length=0;h.draws.length=0;
  h.setCandidates(h.rows().filter(r=>r.id!=='3').reverse().map(r=>({...r,catId:'79'})));
  for(let i=0;i<6;i++)h.ctx.renderQualifiedScorePage('rankcat');
  await h.settled();
  assert.equal(h.scans.get('rankcat'),state);assert.equal(state.cursor,39);
  assert.deepEqual(h.events,[]);assert.ok(h.draws.every(n=>n===39));
});
test('10083 cached scores are consumed at once, not in 1261 asynchronous batches per redraw',async()=>{
  const h=scanHarness({count:10083,cached:true});
  for(let i=0;i<6;i++)h.ctx.renderQualifiedScorePage('rankcat');
  await h.settled();
  assert.equal(h.scans.get('rankcat').cursor,10083);
  assert.deepEqual(h.events,[]);assert.ok(h.draws.every(n=>n===10083));
  assert.equal(h.logs.length,0);
});
test('a new candidate after completion scans only that ID',async()=>{
  const h=scanHarness();h.ctx.renderQualifiedScorePage('rankcat');await h.settled();h.events.length=0;
  h.setCandidates([{id:'new',catId:'8',minimum:9},...h.rows()]);
  h.ctx.renderQualifiedScorePage('rankcat');await h.settled();
  assert.deepEqual(h.events,['share:new']);assert.equal(h.scans.get('rankcat').cursor,41);
});

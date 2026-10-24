const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
test('qualified index scan continues past missing scores and invokes bridge only after the direct pass',async()=>{
  const events=[];const cache=new Map();
  const state={tab:'daily',rankMax:100,candidates:Array.from({length:20},(_,i)=>({id:String(i+1),minimum:8})),cursor:0,matches:[],running:false,errors:0};
  const start=html.indexOf('async function scanQualifiedScorePage');
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


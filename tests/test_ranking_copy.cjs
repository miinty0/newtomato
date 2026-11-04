const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function extract(name){
  const start=html.indexOf('function '+name+'(');
  return (html.slice(start-6,start)==='async '?'async ':'')+html.slice(start,html.indexOf('\n}',start)+2);
}
function environment(fail=false){
  const books=Array.from({length:300},(_,i)=>({book_id:String(1000+i)}));
  const scores=new Map(books.slice(0,298).map((b,i)=>[b.book_id,i<290?'9.0':'8.0']));
  let copied=null,offered=null;
  const ctx=vm.createContext({
    fqFilteredRankingBooks:()=>books,normalizedBookId:b=>b.book_id,sharedScoreMinimum:()=>8.4,
    fqRankingReadSet:new Set(),automaticReadHidden:new Set(),scoreCache:scores,
    scoreListLimit(){throw Error('Rankings must not inherit another tab copy limit');},
    scorePassesMinimum:(score,min)=>Number(score)>=min,
    navigator:{clipboard:{writeText:async text=>{if(fail)throw Error('denied');copied=text;}}},
    offerCopiedIdsAsRead:ids=>offered=ids.slice(),toast(){},
  });
  vm.runInContext(['scoreCandidatesForTab','qualifiedBookIdsForTab','copyQualifiedBookIds'].map(extract).join('\n'),ctx);
  return {ctx,get copied(){return copied},get offered(){return offered}};
}
test('copies all 290 qualifying IDs across pages and offers exactly that payload for the read queue',async()=>{
  const e=environment();await vm.runInContext("copyQualifiedBookIds('rankings')",e.ctx);
  assert.equal(e.copied.split('\n').length,290);
  assert.equal(e.copied.split('\n')[289],'1289');
  assert.equal(e.offered.join('\n'),e.copied);
});
test('clipboard failure does not offer or queue any IDs',async()=>{
  const e=environment(true);await vm.runInContext("copyQualifiedBookIds('rankings')",e.ctx);
  assert.equal(e.copied,null);assert.equal(e.offered,null);
});

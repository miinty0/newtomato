const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const rankingSource = fs.readFileSync(path.join(__dirname,'ranking-tab.js'),'utf8');
const utils = require('./ranking-utils');
function extract(name) {
  const marker='function '+name+'(';
  const start=html.indexOf(marker);
  assert.ok(start>=0,name);
  return (html.slice(Math.max(0,start-6),start)==='async '?'async ':'')+html.slice(start,html.indexOf('\n}',start)+2);
}
function bulkEnvironment({ tab='category', fail=false, gate=null }={}) {
  const calls=[],nodes={},storage=new Map();
  const prefix=tab==='category'?'cat':'rc';
  for(const id of [prefix+'-show-all',prefix+'-all-info',prefix+'-select-label',prefix+'-scrape-btn',prefix+'-reload-btn']) nodes[id]={textContent:'',disabled:false};
  nodes[prefix+'-rank-max']={value:'100'};
  nodes[prefix+'-copy-max']={value:''};
  nodes['cat-search']={value:''};nodes['rc-search']={value:''};nodes['daily-search']={value:''};
  const payloads={
    1:{books:[{book_id:'123',hot_rank:50,currentPos:50,status:'Ongoing'},{book_id:'456',hot_rank:150,currentPos:150,status:'Ongoing'}]},
    2:{books:[{book_id:'123',hot_rank:2,currentPos:2,status:'Ongoing'},{book_id:'789',hot_rank:80,currentPos:80,status:'Ongoing'}]},
  };
  const ctx=vm.createContext({
    CFG:{user:'u',repo:'r'},catData:{},rcData:{},dailyReadSet:new Set(),rcReadSet:new Set(),
    _catSelectValue:'1',rcSelectValue:'1',booksPage:{category:1,rankcat:1},
    document:{getElementById:id=>nodes[id],querySelectorAll:()=>[]},console:{warn(){}},
    synchronizeCategoryFileLists:async()=>{},ensureStatusOverrides:async()=>{},
    ghRaw:async name=>{calls.push(name);return []},
    ghRawLarge:async name=>{calls.push(name);if(gate)await gate;if(fail&&name.includes('_2.json'))throw Error('HTTP 503');return payloads[name.match(/_(\d+)\.json$/)[1]]},
    loadFetchHistory:()=>({'1':{},'2':{}}),loadRcHistory:()=>({'1':{},'2':{}}),
    registerBooks(){},renderCatPanels(){},renderRcPanels(){},flushStatusesAtViewBoundary(){},
    sharedScoreMinimum:()=>8.4,filterByStatus:books=>books,bookMatchesQuery:(b,q)=>!q||b.book_id.includes(q),
    normalizedBookId:book=>String(book.book_id),
    compareBooksByRank:(a,b,field)=>Number(a[field])-Number(b[field]),
    scoreCache:new Map([['123','8.5'],['789','8.1']]),automaticReadHidden:new Set(),
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  });
  const helper=html.slice(html.indexOf('// Aggregate views are opt-in'),html.indexOf('function scoreListScope'));
  vm.runInContext(helper+['scoreListScope','scoreListLimitKey','scoreListLimit','scoreCandidatesForTab','scorePassesMinimum','qualifiedBookIdsForTab','filterCatBooks','filterRcBooks'].map(extract).join('\n'),ctx);
  return {ctx,calls,nodes,storage,payloads};
}
test('manual aggregate load fetches each saved category once, carries rank limit and deduplicates using the best eligible rank',async()=>{
  const {ctx,calls,nodes}=bulkEnvironment();
  assert.equal(calls.length,0);
  await vm.runInContext("showAllSavedCategories('category')",ctx);
  assert.equal(calls.filter(x=>x.includes('category_')).length,2);
  assert.equal(vm.runInContext("scoreListScope('category')",ctx),'__all');
  const rows=JSON.parse(vm.runInContext("JSON.stringify(scoreCandidatesForTab('category').map(r=>({id:r.id,catId:r.catId,rank:r.book.hot_rank})))",ctx));
  assert.deepEqual(rows,[{id:'123',catId:'2',rank:2},{id:'789',catId:'2',rank:80}]);
  assert.equal(vm.runInContext("qualifiedBookIdsForTab('category').ids.join(',')",ctx),'123');
  assert.equal(nodes['cat-scrape-btn'].disabled,true);
  assert.equal(nodes['cat-select-label'].textContent,'Tất cả danh mục đã có dữ liệu');
});
test('Rankcat aggregate uses its saved file list and currentPos with Score and rank controls',async()=>{
  const {ctx,calls}=bulkEnvironment({tab:'rankcat'});
  await vm.runInContext("showAllSavedCategories('rankcat')",ctx);
  assert.ok(calls.includes('data/rank_cat_1.json')&&calls.includes('data/rank_cat_2.json'));
  assert.equal(vm.runInContext("qualifiedBookIdsForTab('rankcat').ids.join(',')",ctx),'123');
  assert.equal(vm.runInContext("scoreListLimit('rankcat','rank')",ctx),100);
});
test('search in a single category does not load all files or include another cached category',async()=>{
  const {ctx,calls,nodes,payloads}=bulkEnvironment();
  ctx.catData={'1':{data:payloads[1],readSet:new Set()},'2':{data:payloads[2],readSet:new Set()}};
  nodes['cat-search'].value='123';
  await vm.runInContext('filterCatBooks()',ctx);
  assert.equal(calls.length,0);
  assert.equal(vm.runInContext("scoreCandidatesForTab('category').map(row=>row.catId).join(',')",ctx),'1');
});
test('failed bulk files are reported and controls are re-enabled',async()=>{
  const {ctx,nodes}=bulkEnvironment({fail:true});
  await vm.runInContext("showAllSavedCategories('category')",ctx);
  assert.ok(nodes['cat-all-info'].textContent.includes('1/2'));
  assert.ok(nodes['cat-all-info'].textContent.includes('lỗi ID: 2'));
  assert.equal(nodes['cat-show-all'].disabled,false);
});
test('selecting a single category while an aggregate load is in flight prevents a late switch to all',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const {ctx}=bulkEnvironment({gate});
  const loading=vm.runInContext("showAllSavedCategories('category')",ctx);
  vm.runInContext("leaveAllSavedCategories('category')",ctx);
  release();await loading;
  assert.equal(vm.runInContext("categoryViewMode.category",ctx),'single');
});
function rankingEnvironment() {
  const nodes={};
  for(const id of ['fq-ranking-type','fq-ranking-gender','fq-ranking-category','fq-ranking-period','fq-ranking-subtab'])nodes[id]={value:''};
  nodes['fq-ranking-type'].value='app-200';
  const ctx=vm.createContext({
    document:{getElementById:id=>nodes[id]},window:{addEventListener(){}},console,
    FqRankings:utils,pendingRead:{rankings:new Set(),category:new Set()},automaticReadHidden:new Set(),
    filterByStatus:books=>books,
  });
  vm.runInContext(rankingSource,ctx);
  vm.runInContext("fqRankingState.books = FqRankings.unique([{book_id:'123',abstract:'safe',last_chapter_time:1767225600},{book_id:'456',abstract:'safe',last_chapter_time:1767225600}]);",ctx);
  return {ctx,nodes};
}
test('pending read stays undoable on its original board, hides on another board, and is restored when unmarked',()=>{
  const {ctx,nodes}=rankingEnvironment();
  vm.runInContext("pendingRead.rankings.add('123'); fqSetPendingReadOrigin('123','rankings',true);",ctx);
  assert.equal(vm.runInContext('fqFilteredRankingBooks().length',ctx),2);
  nodes['fq-ranking-type'].value='app-101';
  assert.equal(vm.runInContext("fqFilteredRankingBooks().map(b=>b.book_id).join(',')",ctx),'456');
  vm.runInContext("pendingRead.rankings.delete('123'); fqSetPendingReadOrigin('123','rankings',false)",ctx);
  assert.equal(vm.runInContext('fqFilteredRankingBooks().length',ctx),2);
});
test('read marks from another application tab are hidden in Fanqie rankings before saving',()=>{
  const {ctx}=rankingEnvironment();
  vm.runInContext("pendingRead.category.add('123')",ctx);
  assert.equal(vm.runInContext("fqFilteredRankingBooks().map(b=>b.book_id).join(',')",ctx),'456');
});
test('keyword and last-update-year cleanup apply across every ranking list',()=>{
  const {ctx}=rankingEnvironment();
  vm.runInContext("fqRankingKeywords=['双男']; fqRankingState.books=FqRankings.unique([{book_id:'1',abstract:'含双男关键词',last_chapter_time:1767225600},{book_id:'2',abstract:'safe',last_chapter_time:1704067200},{book_id:'3',abstract:'safe',last_chapter_time:1767225600},{book_id:'4',abstract:'safe'}]);",ctx);
  assert.equal(vm.runInContext("fqFilteredRankingBooks().map(b=>b.book_id).join(',')",ctx),'3,4');
});
test('year cleanup uses the last update in China time, supports seconds and milliseconds, and does not guess missing dates',()=>{
  const old=Date.parse('2024-12-31T15:59:59Z'),fresh=Date.parse('2024-12-31T16:00:00Z');
  assert.equal(utils.cleanupReason({last_chapter_time:old/1000}), 'old_last_update');
  assert.equal(utils.cleanupReason({last_chapter_time:fresh}), '');
  assert.equal(utils.cleanupReason({first_chapter_time:old/1000,last_chapter_time:fresh}), '');
  assert.equal(utils.cleanupReason({}), '');
  assert.equal(utils.normalize({book_id:'1',lastChapterTime:old/1000}).last_chapter_time,old/1000);
});
test('manual buttons, pending-read hook, and all inline scripts are valid',()=>{
  assert.equal((html.match(/id="(?:cat|rc)-show-all"/g)||[]).length,2);
  assert.ok(html.includes("fqSetPendingReadOrigin(bookId, tab, pendingRead[tab].has(bookId))"));
  assert.ok(!extract('filterCatBooks').includes('ghRaw'));
  assert.ok(!extract('filterRcBooks').includes('ghRaw'));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!/\bsrc=/.test(match[1]))new vm.Script(match[2]);
});

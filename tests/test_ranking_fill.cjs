const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const FqRankings = require('../ranking-utils');
function harness() {
  const nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, options: [], textContent: '', innerHTML: '', replaceChildren(...children) { this.options = children; } }); return nodes.get(id); };
  element('fq-ranking-type').value = 'app-101'; element('fq-ranking-gender').value = '2';
  let read = ['1','2','3','4'];
  const context = vm.createContext({
    document: { getElementById: element, createElement: () => ({}) }, window: { addEventListener() {} },
    FqRankings, crypto, Option: function(text,value){return {text,value};}, CATEGORY_NAMES: {},
    booksPage: { rankings: 1 }, automaticReadHidden: new Set(),
    ghRaw: async path => path.includes('read.json') ? read : ['blocked'],
    filterByStatus: books => books, registerBooks(){}, unobserveScoresIn(){}, loadScoresForCards(){}, updateReadBar(){},
    renderPagination: (_,count) => { const page = context.booksPage.rankings; return { start:(page-1)*30, end:Math.min(page*30,count) }; },
    bookCardHTML: book => '<b>' + book.book_id + '</b>', setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync('ranking-tab.js','utf8'),context);
  return { context, element, state: () => vm.runInContext('fqRankingState',context), setRead: rows => read = rows };
}
(async () => {
  const html=fs.readFileSync('index.html','utf8');
  const paging=vm.createContext({BOOKS_PER_PAGE:500,booksPage:{rankings:2,daily:2}});
  vm.runInContext(html.slice(html.indexOf('function paginationWindow('),html.indexOf('function paginationHTML(')),paging);
  assert.equal(paging.paginationWindow('rankings',70).start,30); assert.equal(paging.paginationWindow('rankings',70).end,60);
  assert.equal(paging.paginationWindow('daily',900).start,500);
  const h = harness(), calls = [];
  h.context.fqRankRequest = async (_,payload) => {
    calls.push(payload);
    return { books: Array.from({length:12},(_,i) => {
      const id = payload.offset+i+1;
      return { book_id:String(id), book_name:'book', abstract: id>=5 && id<=8 || id>=28 && id<=32 ? 'a blocked phrase' : id===9 ? undefined : 'block ed',
        abstract_unverified: id===9 };
    }), next_offset:payload.offset+12, has_more:payload.offset<100, session_id:'session', title:'Bảng đề cử' };
  };
  await h.context.fqFetchRankings(false);
  assert.deepEqual(calls.map(x=>x.offset),[0,12,24,36]);
  assert(calls.every(x=>x.requireAbstract===true)); assert.equal(calls[1].sessionId,'session');
  assert.equal(h.context.fqFilteredRankingBooks().length,34);
  assert.equal((h.element('rankings-books').innerHTML.match(/<b>/g)||[]).length,30);
  assert(!h.context.fqFilteredRankingBooks().some(book=>Number(book.book_id)<=9));
  await h.context.fqFetchRankings(true);
  assert.equal(h.context.booksPage.rankings,2);
  assert.equal((h.element('rankings-books').innerHTML.match(/<b>/g)||[]).length,30);
  assert.deepEqual(calls.slice(4).map(x=>x.offset),[48,60,72]);
  h.setRead(['1','2','3','4','10','11','12','13','14']);
  await h.context.fqLoadRankingFilters();
  assert(!h.context.fqFilteredRankingBooks().some(book=>book.book_id==='10'));

  const auto = harness(); let autoCalls = 0;
  auto.context.fqRankRequest = async (_,p) => { autoCalls++; return { books:Array.from({length:30},(_,i)=>({book_id:String(100+p.offset+i),abstract:'okay'})),has_more:true,next_offset:p.offset+30 }; };
  await auto.context.fqFetchRankings(false);
  auto.context.automaticReadHidden.add('100'); auto.context.renderRankings();
  for (let i=0;i<30;i++) await Promise.resolve();
  assert.equal(autoCalls,2); assert.equal((auto.element('rankings-books').innerHTML.match(/<b>/g)||[]).length,30);
  assert(!auto.context.fqFilteredRankingBooks().some(book=>book.book_id==='100'));
  const exhausted = harness(); let count=0;
  exhausted.context.fqRankRequest = async () => { count++; return { books:[{book_id:'1',abstract:'okay'}],has_more:false,next_offset:0 }; };
  await exhausted.context.fqFetchRankings(false);
  assert.equal(count,1); assert.equal(exhausted.context.fqFilteredRankingBooks().length,0);
  assert.match(exhausted.element('fq-ranking-info').textContent,/nguồn đã hết/);

  const failed = harness(); let attempts=0;
  failed.context.fqRankRequest = async (_,payload) => {
    attempts++;
    if (attempts===2) throw new Error('network failure');
    return {books:Array.from({length:12},(_,i)=>({book_id:String(100+payload.offset+i),abstract:'okay'})),has_more:true,next_offset:payload.offset+12,session_id:'s'};
  };
  await failed.context.fqFetchRankings(false);
  assert.equal(failed.state().books.length,12); assert.equal(failed.state().next,12); assert.equal(failed.state().paused,true);
  assert.match(failed.element('fq-ranking-info').textContent,/network failure/);
  assert(!failed.element('fq-ranking-info').textContent.includes('nguồn đã hết'));
  await failed.context.fqFetchRankings(true,30);
  assert(failed.context.fqFilteredRankingBooks().length>=30);

  const repeat = harness(); let repeated=0;
  repeat.context.fqRankRequest = async (_,p) => { repeated++; return {books:[{book_id:'100',abstract:'okay'}],has_more:true,next_offset:p.offset+12}; };
  await repeat.context.fqFetchRankings(false); assert.equal(repeated,2); assert.equal(repeat.state().more,false);
  assert.match(repeat.element('fq-ranking-info').textContent,/lặp lại trang/);

  const guarded = harness(); let requests=0;
  guarded.context.fqRankRequest = async (_,p) => { requests++; return {books:[{book_id:String(p.offset+100),abstract:'blocked'}],has_more:true,next_offset:p.offset+12}; };
  await guarded.context.fqFetchRankings(false);
  assert.equal(requests,40); assert.equal(guarded.state().paused,true); assert.equal(guarded.state().more,true);

  console.log('PASS: exact cleanup keywords/read, 30-card pages, server offsets/sessions, partial failures, exhaustion, repeated pages, request guard and metadata filtering');
})().catch(error=>{console.error(error);process.exitCode=1});

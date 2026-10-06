const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const FqRankings = require('../ranking-utils');
const nodes = new Map();
function node() { return { value: '', options: [], style: {}, textContent: '', innerHTML: '', replaceChildren(...children) { this.children = children; this.options = children; if (children.length && children[0].value) this.value = children[0].value; } }; }
const element = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
element('fq-ranking-type').value = 'peak'; element('fq-ranking-gender').value = '1';
let listener;
const context = vm.createContext({
  document: { getElementById: element, createElement: node },
  window: { addEventListener: (_, fn) => listener = fn },
  FqRankings, Map, Set, String, Number, Promise, Boolean, Date, crypto,
  Option: function(text, value) { return { text, value }; }, CATEGORY_NAMES: {},
  booksPage: { rankings: 1 }, automaticReadHidden: new Set(),
  filterByStatus: books => books, registerBooks() {}, unobserveScoresIn() {}, loadScoresForCards() {}, updateReadBar() {},
  renderPagination: () => ({ start: 0, end: 500 }), bookCardHTML: book => book.book_id,
  setTimeout: () => 1, clearTimeout() {},
});
vm.runInContext(fs.readFileSync('ranking-tab.js', 'utf8'), context);
const state = () => vm.runInContext('fqRankingState', context);
(async () => {
  const worker = { closed: false, postMessage(data, origin) { this.last = { data, origin }; } };
  state().worker = worker;
  const request = context.fqRankRequest('ping');
  const response = { __wdFqBridge: 'wd-fq-bridge-v2', kind: 'response', id: worker.last.data.id, ok: true, result: { ok: true } };
  listener({ origin: 'https://evil.example', source: worker, data: response }); assert.equal(state().pending.size, 1);
  listener({ origin: 'https://fanqienovel.com', source: {}, data: response }); assert.equal(state().pending.size, 1);
  listener({ origin: 'https://fanqienovel.com', source: worker, data: response }); await request; assert.equal(state().pending.size, 0);
  context.fqRankRequest = async () => ({ books: [{ book_id: '123', book_name: 'book' }], has_more: true, next_offset: 30 });
  await context.fqFetchRankings(false); assert.equal(state().books.length, 1); assert.equal(state().more, true);
  await context.fqFetchRankings(true); assert.equal(state().books.length, 1); assert.equal(state().more, false);
  context.fqRankRequest = async () => { throw new Error('blocked'); };
  await context.fqFetchRankings(false); assert.equal(state().books.length, 1); assert.equal(element('fq-ranking-info').textContent, 'blocked');
  let appPayload;
  element('fq-ranking-type').value = 'app-104'; element('fq-ranking-gender').value = '0'; element('fq-ranking-period').value = 'monthly';
  context.fqRankRequest = async (action, payload) => { assert.equal(action, 'app-rank-list'); appPayload = payload; return { books: [{ book_id: '125' }], title: 'Bảng danh tiếng', has_more: false }; };
  await context.fqFetchRankings(false); assert.equal(appPayload.gender, 0); assert.equal(appPayload.period, 'monthly');
  element('fq-ranking-type').value = 'app-200'; element('fq-ranking-gender').value = '1'; element('fq-ranking-subtab').value = 'auto';
  await context.fqFetchRankings(false); assert.equal(appPayload.subTab, 5); assert.equal(appPayload.gender, 1);
  context.fqRankRequest = async () => ({ books: [], entries: [{ id: 'author:1', kind: 'author', title: '<img onerror=evil()>', query: 'name', detail: 'author' }], title: 'Bảng tác giả' });
  await context.fqFetchRankings(false); assert.match(element('rankings-books').innerHTML, /&lt;img/); assert(!element('rankings-books').innerHTML.includes('<img onerror'));
  assert.equal(element('rankings-read-bar').style.display, 'none');
  state().more = true; state().next = 12;
  context.fqRankRequest = async () => ({ books: [], entries: [], has_more: false, next_offset: 12, title: 'Bảng tác giả' });
  await context.fqFetchRankings(true); assert.equal(state().entries.length, 1); assert.equal(state().more, false);
  let release;
  context.fqRankRequest = () => new Promise(resolve => release = resolve);
  const inflight = context.fqFetchRankings(false);
  element('fq-ranking-type').value = 'reading'; context.fqRankingChanged();
  release({ books: [{ book_id: '999' }], has_more: false }); await inflight;
  assert.equal(state().books.length, 0); assert.equal(state().busy, false);
  state().books = FqRankings.unique([{ book_id: '123' }, { book_id: '124' }]);
  vm.runInContext('fqRankingReadSet.add("123")', context); context.renderRankings(); assert.equal(element('rankings-books').innerHTML, '124');
  context.automaticReadHidden.add('124'); context.renderRankings(); assert.match(element('rankings-books').innerHTML, /Chưa có/);
  console.log('PASS: origin/source validation, duplicate pages, failed refresh retention, stale responses, read and auto-read hiding');
})().catch(error => { console.error(error); process.exitCode = 1; });

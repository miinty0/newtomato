const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const storage = new Map(), nodes = new Map(), hidden = new Set(), scores = new Map();
let renders = 0;
const ctx = vm.createContext({ console, Map, Set, Number, String, CFG: { user: 'test', repo: 'test' },
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, {value: '', dataset: {}}); return nodes.get(id); } },
  _catSelectValue: '1', rcSelectValue: '1', catData: {}, rcData: {}, dailyRawBooks: [], booksPage: {daily: 2},
  automaticReadHidden: hidden, scoreCache: scores,
  filterByStatus: books => books.filter(b => b.status !== 'skip'),
  normalizedBookId: b => String(b.book_id), bookMatchesQuery: (b, q) => b.book_name.includes(q),
  toast() {}, renderDaily: () => renders++, renderCatPanels() {}, renderRcPanels() {},
});
vm.runInContext(html.slice(html.indexOf('function categoryScoreMinimum('), html.indexOf('function scoreFilteredBookCardHTML(')), ctx);
vm.runInContext(html.slice(html.indexOf('function scoreCandidatesForTab('), html.indexOf('const qualifiedScoreScans =')), ctx);
vm.runInContext(html.slice(html.indexOf('function compareBooksByRank('), html.indexOf('const difference = rank(a) - rank(b);')) + `const difference = rank(a) - rank(b); return Number.isNaN(difference) ? 0 : difference; }`, ctx);
assert.equal(ctx.scorePassesMinimum('8.4', 8.4), true);
assert.equal(ctx.scorePassesMinimum('8.3', 8.4), false);
const books = Array.from({ length: 120 }, (_, i) => ({book_id: String(i + 1), hot_rank: i + 1, currentPos: 121 - i, book_name: 'novel'}));
books.push({book_id:'missing'}, {book_id:'zero', hot_rank:0, currentPos:0});
ctx.dailyRawBooks = books;
ctx.catData = {'1': {data: {books: [...books].reverse()}, readSet: new Set()}};
ctx.rcData = {'1': {data: {books}, readSet: new Set(['120'])}};
for (const b of books) scores.set(b.book_id, Number(b.book_id) % 2 === 0 ? '8.5' : '8.4');
for (const tab of ['daily', 'category', 'rankcat']) {
  storage.set('fq_score_min:test/test:' + (tab === 'daily' ? '__daily' : '1'), '8.4');
  ctx.setScoreListLimit(tab, 'rank', {value:'100'});
  ctx.setScoreListLimit(tab, 'copy', {value:'30'});
  const rows = ctx.scoreCandidatesForTab(tab);
  const field = tab === 'rankcat' ? 'currentPos' : 'hot_rank';
  assert(rows.length > 0);
  assert(rows.every(r => r.book[field] >= 1 && r.book[field] <= 100));
  const qualified = rows.filter(r => Number(scores.get(r.id)) >= 8.4);
  assert.equal(ctx.qualifiedBookIdsForTab(tab).ids.join('|'), qualified.slice(0,30).map(r => r.id).join('|'));
  assert.equal(ctx.qualifiedBookIdsForTab(tab).ids.length, 30);
  ctx.setScoreListLimit(tab, 'copy', {value:''});
  assert.equal(ctx.qualifiedBookIdsForTab(tab).ids.length, qualified.length);
  ctx.setScoreListLimit(tab, 'copy', {value:'0'});
  assert.equal(ctx.scoreListLimit(tab, 'copy'), null);
  ctx.setScoreListLimit(tab, 'rank', {value:'1.5'});
  assert.equal(ctx.scoreListLimit(tab, 'rank'), 100);
  ctx.setScoreListLimit(tab, 'rank', {value:''});
  assert(ctx.scoreCandidatesForTab(tab).length > rows.length);
}
ctx.setScoreListLimit('daily', 'rank', {value:'100'});
ctx.setScoreListLimit('daily', 'copy', {value:'30'});
hidden.add('2'); scores.delete('4');
const result = ctx.qualifiedBookIdsForTab('daily');
assert(!result.ids.includes('2')); assert(!result.ids.includes('4'));
assert.equal(result.ids.length, 30); assert.equal(result.waiting, 1);
ctx.syncCategoryScoreControl('daily');
assert.equal(nodes.get('daily-rank-max').value, 100);
assert.equal(nodes.get('daily-copy-max').value, 30);
assert.equal(ctx.booksPage.daily, 1); assert(renders > 0);
console.log('PASS: rank fields/boundaries, inclusive score, first 30 IDs, Read exclusion, missing scores, persistence, validation, clearing');

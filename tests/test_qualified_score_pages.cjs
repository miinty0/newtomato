const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const src = html.slice(html.indexOf('const qualifiedScoreScans ='), html.indexOf('async function copyQualifiedBookIds('));
function harness(total, passes, options = {}) {
  let calls = [], active = true, fail = options.fail;
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i), book: { book_id: String(i) }, catId: '__daily', minimum: 8.4 }));
  const nodes = new Map();
  const root = { dataset: {}, className: '', innerHTML: '' };
  const scores = new Map();
  const booksPage = { daily: 1, category: 1, rankcat: 1 };
  const ctx = vm.createContext({ console, JSON, Map, Set, Math, Promise, clearTimeout, setTimeout,
    BOOKS_PER_PAGE: 500, booksPage, scoreCache: scores, dailyReadSet: new Set(), automaticReadHidden: new Set(),
    document: { getElementById(id) {
      if (id.startsWith('tab-')) return { classList: { contains: () => active } };
      if (['daily-books','cat-panels','rankcat-books'].includes(id)) return root;
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    } },
    scoreCandidatesForTab: () => rows,
    scorePassesMinimum: (score, min) => Number(score) > min,
    paginationPrefix: tab => tab === 'category' ? 'cat' : tab,
    unobserveScoresIn() {}, loadScoresForCards() {}, toast() {}, requestStatusFlush() {},
    scoreFilteredBookCardHTML: book => '<card id="' + book.book_id + '">',
    requestScore: async id => {
      calls.push(id);
      if (fail === id) { fail = null; throw Error('temporary failure'); }
      scores.set(id, Number(id) < passes ? '8.5' : '8.4');
      if (options.pause && calls.length === 8) active = false;
      return scores.get(id);
    },
  });
  vm.runInContext(src, ctx);
  return { ctx, rows, calls, root, scores, booksPage, activate: () => { active = true; }, state: tab => vm.runInContext('qualifiedScoreScans.get("'+tab+'")', ctx) };
}
async function run(h, tab = 'daily') {
  h.ctx.renderQualifiedScorePage(tab);
  const s = h.state(tab);
  while (s.running) await new Promise(resolve => setImmediate(resolve));
  return s;
}
(async () => {
  for (const tab of ['daily', 'category', 'rankcat']) {
    const h = harness(1754, 400);
    const s = await run(h, tab);
    assert.equal(s.matches.length, 400); assert.equal(s.cursor, 1754); assert.equal(h.calls.length, 1754);
    assert.equal((h.root.innerHTML.match(/<card/g) || []).length, 400);
    h.ctx.renderQualifiedScorePage(tab); assert.equal(h.calls.length, 1754);
  }
  const h = harness(1754, 502);
  let s = await run(h);
  assert.equal(s.matches.length, 500); assert.equal(s.cursor, 500); assert.equal(h.calls.length, 500);
  assert.equal((h.root.innerHTML.match(/<card/g)||[]).length,500);
  h.booksPage.daily = 2; s = await run(h);
  assert.equal(s.matches.length,502); assert.equal(s.cursor,1754);assert.equal((h.root.innerHTML.match(/<card/g)||[]).length,2);
  const before = h.calls.length; h.booksPage.daily = 1; await run(h); assert.equal(h.calls.length,before);
  const err = harness(20, 20, { fail: '3' });
  s = await run(err); assert.equal(s.cursor,3); assert.equal(s.errors,1);
  err.ctx.retryQualifiedScoreScan('daily'); while(s.running) await new Promise(r=>setImmediate(r));
  assert.equal(s.matches.length,20); assert.equal(s.errors,0);assert.equal(err.calls.filter(id=>id==='4').length,1);
  const pause = harness(1754, 900, { pause: true });
  s = await run(pause); assert.equal(pause.calls.length,8);
  pause.activate(); await run(pause); assert.equal(s.matches.length,500);
  const hidden = harness(600, 600);
  s = await run(hidden);
  hidden.ctx.automaticReadHidden.add('2');
  await run(hidden);
  assert.equal(s.matches.length, 500);
  assert.equal(s.matches.some(row => row.id === '2'), false);
  assert.equal(hidden.calls.length, 501);
  console.log('PASS: 400/1754 exhaustive fill, 502/1754 lazy next page, all tabs, cached return, failed-score retry, pause/resume');
})().catch(error=>{console.error(error);process.exitCode=1;});

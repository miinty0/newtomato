const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const source = fs.readFileSync(__dirname + '/../id-score-tab.js', 'utf8');
const helpers = html.slice(html.indexOf('function escapeHTML'), html.indexOf('function fmtTime'));

test('search requires every keyword across title, tags and abstract', () => {
  const ctx = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function bookMatchesQuery'), html.indexOf('// ── Render: no query')), ctx);
  const book = {book_name: '快穿故事', tags: ['无CP'], abstract: '友情向'};
  for (const query of ['快穿 无CP', '  快穿, 无cp；友情向  ', '快穿|无CP', '']) {
    assert.equal(ctx.bookMatchesQuery(book, query), true, query);
  }
  assert.equal(ctx.bookMatchesQuery(book, '快穿 无CP 修仙'), false);
  assert.equal(ctx.bookMatchesQuery({book_name: '快穿'}, '快穿 无CP'), false);
  assert.equal(ctx.bookMatchesQuery({}, '无CP'), false);
});

function harness(fetchScore) {
  const ids = ['7569431547728645182', '7676513996333124632', '7676513996333124633'];
  const elements = new Map();
  const ctx = vm.createContext({URL, ensureCleanupKeywords: async () => {}, considerCleanupRead: () => false, cleanupKeywordReadIds: new Set(), window: {fqShareApiFetchShareInfo: fetchScore},
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, {value: ids.join('\n')});
      return elements.get(id);
    }}, setTimeout: () => 1, clearTimeout() {}, toast() {assert.fail('unexpected toast');}});
  vm.runInContext(helpers + source, ctx);
  return {ctx, ids, rows: () => vm.runInContext('fqIdScoreState.rows', ctx)};
}

test('ID scores defer errors and N/A to the same Bridge helper as Daily after the direct pass', async () => {
  const calls = [];
  const h = harness(async id => {
    calls.push('share:' + id);
    await Promise.resolve();
    if (id === h.ids[0]) throw new Error('timeout');
    return {score: id === h.ids[1] ? 'N/A' : '9.2', book_info: {author: '作者', book_name: '测试'}};
  });
  h.ctx.window.fqShareApiFetchBookMeta = async (id, options) => {
    assert.equal(options.deferBridge, false);
    calls.push('bridge:' + id);
    return {score: id === h.ids[0] ? '9.5' : 'N/A'};
  };
  await h.ctx.fqIdScoreStart();
  assert.deepEqual(calls.slice(0, 3), h.ids.map(id => 'share:' + id));
  assert.deepEqual(calls.slice(3), [h.ids[0], h.ids[1]].map(id => 'bridge:' + id));
  assert.deepEqual(Array.from(h.rows(), r => r.status), ['done', 'done', 'done']);
  assert.equal(h.rows()[0].score, 9.5);
  assert.equal(h.rows()[1].score, null);
  assert.equal(h.rows()[1].book.author, '作者');
  assert.equal(h.rows()[2].score, 9.2);
});

test('Bridge errors stay retryable and do not erase Share API display metadata', async () => {
  const h = harness(async () => ({score: 'N/A', book_info: {author: '作者'}}));
  h.ctx.window.fqShareApiFetchBookMeta = async () => {throw new Error('bridge timeout');};
  await h.ctx.fqIdScoreStart();
  assert.equal(h.rows().every(row => row.status === 'error' && row.book.author === '作者'), true);
  h.ctx.window.fqShareApiFetchBookMeta = async () => ({score: '8.8'});
  await h.ctx.fqIdScoreStart(true);
  assert.equal(h.rows().every(row => row.status === 'done' && row.score === 8.8 && row.book.author === '作者'), true);
});

test('stop skips automatic final retry and manual retry can recover', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    h.ctx.fqIdScoreStop();
    throw new Error('timeout');
  });
  await h.ctx.fqIdScoreStart();
  assert.equal(calls, 1);
  h.ctx.window.fqShareApiFetchShareInfo = async () => ({score: '8.8'});
  await h.ctx.fqIdScoreStart(true);
  assert.equal(h.rows().every(r => r.status === 'done'), true);
});

test('author links encode path segments and ID cards omit raw API details', () => {
  const h = harness(async () => ({}));
  const name = '作者 / "<测试>';
  const link = h.ctx.authorLinkHTML(name);
  assert.ok(link.includes('https://wikicv.org/tac-gia/' + encodeURIComponent(name)));
  assert.ok(link.includes('target="_blank"'));
  assert.ok(link.includes('rel="noopener noreferrer"'));
  assert.ok(link.includes('&lt;测试&gt;'));
  const card = h.ctx.fqIdScoreBookHTML({id: h.ids[0], status: 'done', book: {author: name, secret_field: 'raw-value'}, shareInfo: {other: 'raw-share'}});
  assert.ok(card.includes(link));
  assert.ok(!card.includes('<details>'));
  assert.ok(!card.includes('secret_field'));
  assert.ok(!card.includes('raw-share'));
});


test('ID copy hides cleanup matches and includes failed scores in both formats', async () => {
  const h = harness(async () => ({}));
  const copied = [];
  h.ctx.toast = () => {};
  h.ctx.navigator = {clipboard: {writeText: async text => copied.push(text)}};
  h.ctx.considerCleanupRead = book => String(book?.abstract || book?.description || '').includes('双男');
  vm.runInContext(`fqIdScoreState.rows = [
    {id:'1', order:0, status:'done', score:9, display:'9', book:{abstract:'双男 story'}},
    {id:'2', order:1, status:'done', score:8.4, display:'8.4'},
    {id:'3', order:2, status:'error', score:null, error:'timeout'},
    {id:'4', order:3, status:'error', score:null, book:{abstract:'双男'}},
    {id:'5', order:4, status:'done', score:null, display:'N/A'},
    {id:'6', order:5, status:'pending', score:null}
  ]`, h.ctx);
  await h.ctx.fqIdScoreCopy(false);
  await h.ctx.fqIdScoreCopy(true);
  assert.equal(copied[0], '2\n5\n3');
  assert.equal(copied[1], 'ID\tScore\n2\t8.4\n5\tN/A\n3\tERROR');
  assert(!h.ctx.document.getElementById('idscore-results').innerHTML.includes('双男'));
});

test('manual hide removes a row from display and both copy formats, including after a redraw', async () => {
  const h = harness(async () => ({}));
  const copied = [];
  h.ctx.toast = () => {};
  h.ctx.navigator = {clipboard: {writeText: async text => copied.push(text)}};
  vm.runInContext(`fqIdScoreState.rows = [
    {id:'101', order:0, status:'done', score:9, display:'9'},
    {id:'102', order:1, status:'error', score:null, error:'timeout'},
    {id:'103', order:2, status:'done', score:8, display:'8'}
  ]`, h.ctx);
  h.ctx.fqIdScoreRender();
  assert.match(h.ctx.document.getElementById('idscore-results').innerHTML, /fqIdScoreHide/);
  h.ctx.fqIdScoreHide('101');
  h.ctx.fqIdScoreRender(); // Simulate a score update or page change.
  assert.deepEqual(Array.from(h.ctx.fqIdScoreSorted(), row => row.id), ['103', '102']);
  assert(!h.ctx.document.getElementById('idscore-results').innerHTML.includes('/page/101'));
  await h.ctx.fqIdScoreCopy(false);
  await h.ctx.fqIdScoreCopy(true);
  assert.equal(copied[0], '103\n102');
  assert.equal(copied[1], 'ID\tScore\n103\t8\n102\tERROR');
  h.ctx.fqIdScoreHide('102');
  h.ctx.fqIdScoreHide('103');
  assert.equal(h.ctx.document.getElementById('idscore-copy').disabled, true);
  assert.equal(h.ctx.document.getElementById('idscore-copy-table').disabled, true);
});

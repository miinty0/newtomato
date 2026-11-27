const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const source = fs.readFileSync(__dirname + '/../id-score-tab.js', 'utf8');
const cleanupPolicy = require('../cleanup-policy.json');
const helpers = html.slice(html.indexOf('function escapeHTML'), html.indexOf('function rankChangeHTML'));

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
  const queued = [];
  const ctx = vm.createContext({URL, fetch: async () => ({ok: true, json: async () => cleanupPolicy}), queueReadIds: ids => queued.push(...ids), _bookRegistry: {}, fqRankingFirstTimeCache: {}, ensureCleanupKeywords: async () => {}, considerCleanupRead: () => false, cleanupKeywordReadIds: new Set(), window: {fqShareApiFetchShareInfo: fetchScore},
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, {value: ids.join('\n')});
      return elements.get(id);
    }}, setTimeout: () => 1, clearTimeout() {}, toast() {assert.fail('unexpected toast');}});
  vm.runInContext(helpers + source, ctx);
  return {ctx, ids, queued, rows: () => vm.runInContext('fqIdScoreState.rows', ctx)};
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

test('ID results show chapter years from Share API and saved ranking metadata', async () => {
  const first = Date.UTC(2024, 5, 1) / 1000;
  const last = Date.UTC(2026, 5, 1) / 1000;
  const h = harness(async id => ({
    score: id === h.ids[0] ? 'N/A' : '8.8',
    book_info: {book_name: '测试', last_chapter_update_time: id === h.ids[2] ? 'invalid' : String(last * 1000)},
    first_chapter_time: id === h.ids[0] ? String(first) : null,
  }));
  h.ctx.window.fqShareApiFetchBookMeta = async () => ({score: '9'});
  h.ctx.fqRankingFirstTimeCache[h.ids[1]] = first;
  h.ctx._bookRegistry[h.ids[2]] = {last_chapter_time: last};
  await h.ctx.fqIdScoreStart();
  const cards = h.rows().map(h.ctx.fqIdScoreBookHTML);
  assert.match(cards[0], /class="book-time notranslate">2026-2024</);
  assert.match(cards[1], /class="book-time notranslate">2026-2024</);
  assert.match(cards[2], /class="book-time notranslate">2026</);
  assert.doesNotMatch(h.ctx.fqIdScoreBookHTML({id: '1'}), /book-time|NaN/);
});

test('missing chapter dates are loaded from Fanqie and retried independently of score', async () => {
  const id = '7319098631070420030';
  let scoresFetched = 0;
  const h = harness(async () => {
    scoresFetched++;
    return {score: '8.8', book_info: {book_name: '重生港岛，家大业大', serial_count: 1126}};
  });
  h.ctx.document.getElementById('idscore-input').value = id;
  h.ctx.console = {warn() {}};
  h.ctx.window.fqShareApiFetchChapterTimes = async () => {throw new Error('timeout');};
  await h.ctx.fqIdScoreStart();
  assert.match(h.ctx.document.getElementById('idscore-info').textContent, /1 ID thiếu năm/);
  assert.match(h.ctx.document.getElementById('idscore-results').innerHTML, /Y-Y: lỗi, truyện ẩn/);
  assert.equal(h.ctx.document.getElementById('idscore-retry').disabled, false);
  h.ctx.window.fqShareApiFetchChapterTimes = async bookId => {
    assert.equal(bookId, id);
    return {first_chapter_time: 1704207399, last_chapter_time: 1795112277};
  };
  await h.ctx.fqIdScoreStart(true);
  assert.equal(scoresFetched, 1);
  assert.doesNotMatch(h.ctx.document.getElementById('idscore-results').innerHTML, /Y-Y: lỗi, truyện ẩn/);
  assert.match(h.ctx.document.getElementById('idscore-results').innerHTML, /class="book-time notranslate">2026-2024</);
  assert.equal(h.ctx.document.getElementById('idscore-retry').disabled, true);
});

test('full page tags take priority over Share API tags and fall back when absent', async () => {
  const calls = [];
  const h = harness(async () => ({
    score: '8.8',
    book_info: {book_name: '测试', tags: '快穿,穿越'},
  }));
  h.ctx.window.fqShareApiFetchBookPage = async id => {
    calls.push(id);
    return {
      first_chapter_time: Date.UTC(2026, 5, 1),
      last_chapter_time: Date.UTC(2026, 6, 1),
      tags: id === h.ids[0] ? ['快穿', '系统', '幻想言情', '穿越', '穿书', '魂穿'] : [],
    };
  };
  await h.ctx.fqIdScoreStart();
  assert.deepEqual(calls, h.ids);
  assert.match(h.ctx.fqIdScoreBookHTML(h.rows()[0]), /Tag: 快穿,系统,幻想言情,穿越,穿书,魂穿<\/div>/);
  assert.match(h.ctx.fqIdScoreBookHTML(h.rows()[1]), /Tag: 快穿,穿越<\/div>/);
  assert.match(h.ctx.fqIdScoreBookHTML(h.rows()[0]), /class="book-time notranslate">2026-2026</);
  assert.equal(h.rows()[0].book.tags, '快穿,穿越');
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

test('ID cards use Fanqie thumbnails and shorten chapter counts over 1000', () => {
  const h = harness(async () => ({}));
  const card = h.ctx.fqIdScoreBookHTML({
    id: h.ids[0], status: 'done',
    book: {thumb_url: 'https://p3-reading-sign.fqnovelpic.com/novel-pic/cover123~tplv-original.image?x=1', serial_count: '1126'},
  });
  assert.match(card, /src="https:\/\/p6-novel\.byteimg\.com\/thumb\/novel-pic\/cover123"/);
  assert.ok(card.includes('+1k chương'));
  const atLimit = h.ctx.fqIdScoreBookHTML({id: h.ids[0], status: 'done', book: {serial_count: 1000}});
  assert.ok(atLimit.includes('1000 chương'));
  assert.doesNotMatch(atLimit, /Y-Y: lỗi, truyện ẩn/);
  assert.equal(h.ctx.fqIdScoreCoverUrl('https://example.org/cover.jpg'), 'https://example.org/cover.jpg');
  assert.equal(h.ctx.fqIdScoreCoverUrl('javascript:alert(1)'), '');
});

test('date lookups overlap the direct score pass and hide both year cleanup cases', async () => {
  let releaseScore, releaseYears;
  const scores = new Promise(resolve => { releaseScore = resolve; });
  const years = new Promise(resolve => { releaseYears = resolve; });
  const calls = [];
  const h = harness(async id => {
    calls.push('score:' + id);
    if (id === h.ids[2]) await scores;
    return {score: '8.8', book_info: {book_name: '测试'}};
  });
  const last2025 = Date.UTC(2025, 11, 31, 15, 59, 59) / 1000;
  const first2023 = Date.UTC(2023, 11, 31, 15, 59, 59) / 1000;
  h.ctx.window.fqShareApiFetchChapterTimes = async id => {
    calls.push('year:' + id);
    if (id === h.ids[0]) return {first_chapter_time: first2023, last_chapter_time: last2025 + 1};
    if (id === h.ids[1]) return {last_chapter_time: last2025};
    await years;
    return {first_chapter_time: first2023 + 1, last_chapter_time: last2025 + 1};
  };

  const run = h.ctx.fqIdScoreStart();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.startsWith('score:')).length, 3);
  assert.equal(calls.filter(call => call.startsWith('year:')).length, 2);
  assert.deepEqual(h.queued, h.ids.slice(0, 2));
  assert.deepEqual(Array.from(h.ctx.fqIdScoreSorted(), row => row.id), [h.ids[2]]);
  releaseScore();
  releaseYears();
  await run;
  assert.deepEqual(h.queued, h.ids.slice(0, 2));
  assert.match(h.ctx.document.getElementById('idscore-results').innerHTML, /2026-2024/);
  const copied = [];
  h.ctx.navigator = {clipboard: {writeText: async value => copied.push(value)}};
  h.ctx.toast = () => {};
  await h.ctx.fqIdScoreCopy(false);
  assert.deepEqual(copied, [h.ids[2]]);
});

test('missing Share API metadata skips page requests and manual retry', async () => {
  const calls = [];
  const h = harness(async id => {
    calls.push('score:' + id);
    return {score: '8.8', book_info: id === h.ids[0] ? {} : {book_name: '测试'}};
  });
  h.ctx.window.fqShareApiFetchBookPage = async id => {
    calls.push('page:' + id);
    return {first_chapter_time: 1780000000, last_chapter_time: 1790000000, tags: ['测试'], gender: 0};
  };
  await h.ctx.fqIdScoreStart();
  assert.deepEqual(calls.filter(call => call.startsWith('page:')), h.ids.slice(1).map(id => 'page:' + id));
  const card = h.ctx.fqIdScoreBookHTML(h.rows()[0]);
  assert.match(card, /Share API không trả thông tin truyện cho ID này/);
  assert.doesNotMatch(card, /gender=|Tag:|book-time|Chưa có bìa/);
  assert.equal(h.ctx.document.getElementById('idscore-retry').disabled, true);
  const before = calls.length;
  await h.ctx.fqIdScoreStart(true);
  assert.equal(calls.length, before);
});

test('a new score run reads the changed cleanup year cutoffs', async () => {
  const h = harness(async () => ({
    score: '8.8',
    book_info: {first_chapter_time: Date.UTC(2024, 5, 1) / 1000, last_chapter_time: Date.UTC(2026, 5, 1) / 1000},
  }));
  h.ctx.document.getElementById('idscore-input').value = h.ids[0];
  let policy = {firstYear: 2022, lastYear: 2024};
  const requests = [];
  h.ctx.fetch = async (url, options) => {
    requests.push(url);
    assert.equal(options.cache, 'no-store');
    return {ok: true, json: async () => policy};
  };
  await h.ctx.fqIdScoreStart();
  assert.equal(h.ctx.fqIdScoreSorted().length, 1);

  policy = {firstYear: 2024, lastYear: 2024};
  await h.ctx.fqIdScoreStart();
  assert.equal(h.ctx.fqIdScoreSorted().length, 0);
  assert.deepEqual(h.queued, [h.ids[0]]);
  assert.deepEqual(requests, ['./cleanup-policy.json', './cleanup-policy.json']);
});

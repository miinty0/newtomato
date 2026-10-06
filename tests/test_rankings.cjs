const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { unique, normalize } = require('../ranking-utils');
const source = fs.readFileSync('userscripts/fanqie-wiki-bridge.user.js', 'utf8');
const helpers = source.slice(source.indexOf('  async function wdRankingJSON('), source.indexOf('  async function wdBridgeHandle('));
let requested = '';
let reply = {};
const context = vm.createContext({
  URLSearchParams, Date, Set, Number, String, Promise,
  fetch$1: async url => { requested = url; return { ok: true, json: async () => reply }; },
  requestApp: async (path, query) => {
    assert.equal(path, '/bookapi/multi-detail/v'); assert.equal(query.book_id, '123');
    return { json: () => ({ data: [{ book_name: '真实书名', author: '作者', abstract: '简介' }] }) };
  }
});
vm.runInContext(helpers, context);
(async () => {
  reply = { book_list: [{ book_id: '123', book_name: '峰' }] };
  const peak = await context.wdRankingList({ type: 'peak' });
  assert.equal(peak.books.length, 1); assert.equal(peak.has_more, false);
  reply = { code: 0, data: { book_list: [{ bookId: '123', bookName: '\uE400书', currentPos: 31 }], total_num: 80, rankVersion: 'v1' } };
  const fresh = await context.wdRankingList({ type: 'new', categoryId: '1141', gender: 1, offset: 30 });
  assert.equal(new URL(requested).searchParams.get('rankMold'), '1');
  assert.equal(fresh.books[0].bookName, '真实书名'); assert.equal(fresh.books[0].currentPos, 31);
  assert.equal(fresh.unresolved, 0); assert.equal(fresh.has_more, true); assert.equal(fresh.next_offset, 31);
  await context.wdRankingList({ type: 'reading', categoryId: '24', gender: 0 });
  assert.equal(new URL(requested).searchParams.get('rankMold'), '2');
  await assert.rejects(context.wdRankingList({ type: 'completed' }), /chưa xác minh/);
  await assert.rejects(context.wdRankingList({ type: 'reading', categoryId: '../x' }), /Chọn danh mục/);
  await assert.rejects(context.wdRankingJSON('https://evil.example'), /không hợp lệ/);
  reply = { code: 503, message: 'blocked' };
  await assert.rejects(context.wdRankingList({ type: 'peak' }), /blocked/);
  reply = { code: 0, data: {} };
  await assert.rejects(context.wdRankingList({ type: 'new', categoryId: '24' }), /thiếu danh sách/);
  const books = unique([{ book_id: '123', title: '名字', creation_status: 0 }, { bookId: '123' }, { bookId: '124', creationStatus: 1 }]);
  assert.equal(books.length, 2); assert.equal(books[0].status, 'Completed'); assert.equal(books[1].status, 'Ongoing');
  assert.equal(normalize({ book_id: '123', cover_url: 'https://p3-novel-sign.byteimg.com/novel-pic/abc~tplv?secret=1' }, 4).thumb_url, 'https://p6-novel.byteimg.com/thumb/novel-pic/abc');
  assert.equal(normalize({ book_id: '0' }), null);
  assert.equal(normalize({ book_id: '123', title: '\uE400' }).book_name, '□');
  const snapshot = JSON.parse(fs.readFileSync('data/ranking-snapshot.json'));
  assert.equal(unique(snapshot.peak.books).length, 30);
  assert(snapshot.editor.books.length > 0);
  const html = fs.readFileSync('index.html', 'utf8');
  new vm.Script(html.split('<script>')[1].split('</script>')[0]);
  console.log('PASS: official rank codes, live snapshot, metadata hydration, paging, failures, deduplication, status, covers, HTML syntax');
})().catch(error => { console.error(error); process.exitCode = 1; });

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('userscripts/fanqie-wiki-bridge.user.js', 'utf8');
const helpers = source.slice(source.indexOf('  function wdRankSchemaParams'), source.indexOf('  async function wdBridgeHandle'));
const inner = new URL('https://lf-normal-gr-sourcecdn.bytegecko.com/obj/common-rank-list/template.js');
inner.search = new URLSearchParams({ cell_id: '7098235271900037133', algo_type: '200', tab_type: '2', cell_gender: '2', genre_type: '0' });
const nested = 'dragon1967://lynxview?url=' + encodeURIComponent('sslocal://lynxview?surl=' + encodeURIComponent(inner.href));
let landingCalls = 0, sent;
let raw = { code: 0, data: { cell_view: { algo: 200, cell_data: [
  { cell_name: '月榜', rank_list_sub_tab_type: 1, cell_data: [
    { book_data: [{ book_id: '7276384138653862966', book_name: '我不是戏神', score: '9.9', creation_status: '1' }] },
    { book_data: [{ book_id: '7143038691944959011', book_name: '十日终焉', creation_status: '0' }] }
  ] },
  { cell_name: '男生榜', rank_list_sub_tab_type: 5, cell_data: [] }
] }, has_more: false, next_offset: 0, session_id: 'test-session' } };
const context = vm.createContext({
  URL, URLSearchParams, Date,
  wdLandingProbeParams: () => ({}),
  webGet: async () => { landingCalls++; return { code: 0, data: [{ cell_url: nested }] }; },
  requestApp: async (path, params) => { sent = params; assert.equal(path, '/bookapi/bookmall/cell/change/v1/'); return { json: () => raw }; },
  collectSugBooks: rows => rows || [], collectWords: () => [], pushSection: () => {}
});
vm.runInContext(helpers, context);
(async () => {
  const list = await context.wdAppRankingList({ algoType: 200, subTab: 1 });
  assert.equal(sent.cell_id, '7098235271900037133'); assert.equal(typeof sent.cell_id, 'string');
  assert.equal(sent.tab_type, '2'); assert.equal(sent.rank_list_sub_tab_type_list, '1,2');
  assert.equal(list.title, 'Bảng đỉnh cao · Bảng tháng'); assert.equal(list.books.length, 2);
  assert.equal(list.books[0].score, '9.9'); assert.equal(list.books[1].creation_status, '0');
  assert.equal(list.session_id, 'test-session'); assert.equal(list.has_more, false);
  await assert.rejects(context.wdAppRankingList({ algoType: 101 }), /bảng khác/);
  await assert.rejects(context.wdAppRankingList({ algoType: 200, subTab: 5 }), /chưa trả truyện/);
  assert.equal(landingCalls, 1);
  for (const gender of [0, 1, 2]) {
    await context.wdProbeAppRank({ algoType: 104, gender, period: 'monthly', offset: 12, sessionId: 'page-two' });
    assert.equal(sent.gender_list_type, String(gender)); assert.equal(sent.list_type, 'monthly');
    assert.equal(sent.session_id, 'page-two'); assert.equal(sent.offset, '12');
  }
  const codes = [101,100,200,104,111,115,109,110,102,205,103,146,188,197,196,135,201,116,108];
  for (const algoType of codes) { await context.wdProbeAppRank({ algoType }); assert.equal(sent.algo_type, String(algoType)); }
  raw = { code: 0, data: { cell_view: { algo: 205, cell_data: [{ book_data: [{ book_id: '123', original_author_infos: [{ AuthorName: '作者', AuthorIdStr: '1234567890123456789' }], book_name: '作品' }] }] } } };
  const author = await context.wdAppRankingList({ algoType: 205 });
  assert.equal(author.books.length, 0); assert.equal(author.entries[0].kind, 'author');
  assert.equal(author.title, 'Bảng tác giả');
  raw = { code: 0, data: { cell_view: { algo: 201, cell_data: [{ cell_name: '热播', rank_list_sub_tab_type: 1, cell_data: [{ video_data: [{ title: '视频', video_id: '456', cover: 'https://example.com/cover.jpg' }] }] }] } } };
  const video = await context.wdAppRankingList({ algoType: 201 });
  assert.equal(video.books.length, 0); assert.equal(video.entries[0].kind, 'video');
  assert(!/[\u3400-\u9fff]/.test(video.title));
  raw = { code: 400, message: 'PARAM_INVALID', data: {} };
  const error = await context.wdProbeAppRank({ algoType: 200 });
  assert.equal(error.ok, false); assert.equal(error.raw.code, 400);
  await assert.rejects(context.wdAppRankingList({ algoType: 200 }), /PARAM_INVALID/);
  console.log('PASS: live schema, exact IDs, APP group selection, metadata, sessions, mismatched boards and raw errors');
})().catch(error => { console.error(error); process.exitCode = 1; });

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.slice(html.indexOf('function qualifiesForAutomaticRead('), html.indexOf('async function ensureStatusOverrides()'));
const now = Date.UTC(2026, 9, 2);
let remote = ['existing'];
let failConflict = true;
let writes = 0;
let cleaned = [];
const cards = ['candidate', 'candidate', 'other'].map(id => ({
  dataset: { id }, classList: { add(value) { this.hidden = value; } },
}));
const context = vm.createContext({
  Date, Number, String, Set, Map, Promise, console,
  navigator: {}, window: {}, CFG: { user: 'test', repo: 'test' },
  setTimeout: () => 1, clearTimeout: () => {},
  scoreRequests: new Map(), _bookRegistry: {},
  document: { querySelectorAll: () => cards },
  dailyReadSet: new Set(), rcReadSet: new Set(), specialReadSet: new Set(),
  catData: { a: { readSet: new Set() } }, rcData: { b: { readSet: new Set() } },
  pendingRead: { daily: new Set(['candidate']) },
  dailyRawBooks: [{ book_id: 'candidate' }], specialBooks: [], dailyLoaded: false, specialLoaded: false,
  normalizedBookId: book => book.book_id,
  updateReadBar: () => {}, renderDaily: () => {}, renderCatPanels: () => {}, renderRcPanels: () => {}, renderSpecial: () => {},
  toast: () => {}, b64DecodeUTF8: value => value,
  isStatusShaConflict: error => /409/.test(error.message), statusSyncDelay: async () => {},
  ghGetFile: async () => ({ content: JSON.stringify(remote), sha: String(writes) }),
  ghPutFile: async (_, content) => {
    if (failConflict) { failConflict = false; remote.push('another-tab'); throw Error('HTTP 409'); }
    writes++; remote = JSON.parse(content);
  },
  cleanupAfterRead: async ids => { cleaned.push([...ids]); },
});
vm.runInContext(source, context);
const q = context.qualifiesForAutomaticRead;
const ago = days => (now - days * 86400000) / 1000;
assert.equal(q(ago(301), '7.4', now), true);
assert.equal(q(ago(300), '7.4', now), false);
assert.equal(q(ago(301), '7.5', now), false);
assert.equal(q(ago(301), '0.0', now), true);
for (const score of [null, '', ' ', 'N/A', 'error', '7.4x', -1, 11]) assert.equal(q(ago(301), score, now), false);
for (const date of [null, '', 0, -1, ago(-1), now, 'invalid']) assert.equal(q(date, '7.4', now), false);
for (const raw of [0, '0']) assert.equal(context.mappedFanqieStatus(raw), 'Completed');
for (const raw of [1, '1']) assert.equal(context.mappedFanqieStatus(raw), 'Ongoing');
for (const raw of [null, undefined, '', 2, 3, 4]) assert.equal(context.mappedFanqieStatus(raw), null);
(async () => {
  context.considerAutomaticRead('candidate', '7.4', {
    first_chapter_time: (Date.now() - 301 * 86400000) / 1000,
  });
  assert.equal(cards[0].classList.hidden, 'automatic-read-hidden');
  assert.equal(cards[1].classList.hidden, 'automatic-read-hidden');
  assert.equal(cards[2].classList.hidden, undefined);
  assert.equal(vm.runInContext("automaticReadHidden.has('candidate')", context), true);
  const result = await context.mergeReadIds(new Set(['candidate', 'existing']), 'test');
  assert.deepEqual(remote.sort(), ['another-tab', 'candidate', 'existing']);
  assert.equal(result.added, 1);
  await context.mergeReadIds(new Set(['candidate']), 'test');
  assert.equal(writes, 1);
  vm.runInContext("automaticReadQueue.add('candidate')", context);
  const saving = context.flushAutomaticRead();
  assert.equal(vm.runInContext("automaticReadQueue.size", context), 0);
  assert.equal(vm.runInContext("automaticReadHidden.has('candidate')", context), true);
  await saving;
  assert(context.dailyReadSet.has('candidate'));
  assert(context.rcData.b.readSet.has('candidate'));
  assert.equal(context.pendingRead.daily.size, 0);
  assert.equal(context.dailyRawBooks.length, 0);
  assert.deepEqual(cleaned, [['candidate']]);
  const goodWrite = context.ghPutFile;
  context.ghPutFile = async () => { throw Error('HTTP 403'); };
  vm.runInContext("automaticReadQueue.add('unsaved')", context);
  await assert.rejects(context.flushAutomaticRead(), /403/);
  assert.equal(vm.runInContext("automaticReadQueue.has('unsaved')", context), true);
  assert.equal(context.dailyReadSet.has('unsaved'), false);
  context.ghPutFile = goodWrite;
  await context.window.fqRetryAutomaticRead();
  assert(remote.includes('unsaved'));
  assert(context.dailyReadSet.has('unsaved'));
  console.log('PASS: boundaries, invalid data, status mapping, conflict merge, deduplication, cleanup, failed-save retry');
})().catch(error => { console.error(error); process.exitCode = 1; });

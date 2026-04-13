const https = require('https');
const http  = require('http');
const fs    = require('fs');

// ── Config ──
const BASE    = 'fanqienovel.com';
const API     = `https://${BASE}/api`;
const PAGE    = `https://${BASE}/page`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const MAX_CATEGORY_ID = 1000;
const DELAY_MS        = 500;
const MAX_4XX_ERRORS  = 3;

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}
// ── Fetch first book_id for a category ──
async function fetchFirstBookId(categoryId) {
  const params = new URLSearchParams({
    page_count: 1, page_index: 0,
    gender: -1, category_id: categoryId,
    creation_status: -1, word_count: -1,
    book_type: -1, sort: -1,
  });
  const res = await httpGet(`${API}/author/library/book_list/v0/?${params}`, { Accept: 'application/json' });
  if (res.status !== 200) return null;
  const json = JSON.parse(res.data);
  const list = json?.data?.book_list;
  if (!list || list.length === 0) return null;
  return String(list[0].book_id);
}
// ── Parse categoryV2 from detail page ──
function parseCategoryV2(html) {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*\r?\n/);
  if (!match) return [];
  try {
    const state = JSON.parse(match[1]);
    const raw = state?.page?.categoryV2;
    if (!raw) return [];
    return JSON.parse(raw)
      .map(c => ({ ObjectId: c.ObjectId, Name: c.Name || '', ExternalDesc: c.ExternalDesc || '' }))
      .filter(c => c.ObjectId !== undefined);
  } catch(e) { return []; }
}
// ── Main ──
async function main() {
  const catMap = {}; // ObjectId → { Name, ExternalDesc }
  let consecutive4xx = 0;

  console.log(`Scanning category_id 1 → ${MAX_CATEGORY_ID}...\n`);
  console.log('Logic: fetch first book of each category → parse its categoryV2 → skip if all ObjectIds already known\n');
  for (let catId = 1; catId <= MAX_CATEGORY_ID; catId++) {
    // Step A: get first book_id for this category
    let bookId = null;
    try {
      bookId = await fetchFirstBookId(catId);
    } catch(e) {
      console.log(`  cat ${catId}: API error — ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }
    if (!bookId) {
      process.stdout.write(`  cat ${catId}/${MAX_CATEGORY_ID}: no books — skip\n`);
      await sleep(200);
      continue;
    }
    // Step B: fetch detail page
    let res;
    try {
      res = await httpGet(`${PAGE}/${bookId}`);
    } catch(e) {
      console.log(`  cat ${catId}: detail fetch error — ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }
    if (res.status >= 400 && res.status < 500) {
      consecutive4xx++;
      console.log(`  cat ${catId}: HTTP ${res.status} (4xx count: ${consecutive4xx}/${MAX_4XX_ERRORS})`);
      if (consecutive4xx >= MAX_4XX_ERRORS) {
        console.log(`\nHit ${MAX_4XX_ERRORS} consecutive 4xx errors — stopping.`);
        break;
      }
      await sleep(DELAY_MS);
      continue;
    }
    consecutive4xx = 0;
    // Step C: parse & store only new ObjectIds
    const cats = parseCategoryV2(res.data);
    const allKnown = cats.length > 0 && cats.every(c => catMap[c.ObjectId]);
    if (allKnown) {
      process.stdout.write(`  cat ${catId}/${MAX_CATEGORY_ID}: all ${cats.length} ObjectIds already known — skip\n`);
    } else {
      let newCount = 0;
      for (const c of cats) {
        if (!catMap[c.ObjectId]) {
          catMap[c.ObjectId] = { Name: c.Name, ExternalDesc: c.ExternalDesc };
          newCount++;
        }
      }
      process.stdout.write(`  cat ${catId}/${MAX_CATEGORY_ID}: book ${bookId} | +${newCount} new ObjectIds | total: ${Object.keys(catMap).length}\n`);
    }
    await sleep(DELAY_MS + Math.floor(Math.random() * 200));
  }
  // ── Save results ──
  const entries = Object.entries(catMap)
    .map(([id, info]) => ({ id: Number(id), name: info.Name, desc: info.ExternalDesc }))
    .sort((a, b) => a.id - b.id);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Found ${entries.length} unique categories\n`);
  // categories.json
  fs.writeFileSync('categories.json', JSON.stringify(entries, null, 2), 'utf-8');
  console.log('Saved → categories.json');
  // categories.txt
  const idW   = Math.max(4,  ...entries.map(e => String(e.id).length));
  const nameW = Math.max(8,  ...entries.map(e => e.name.length));
  const lines = [
    `${'ID'.padStart(idW)}  ${'NAME'.padEnd(nameW)}  DESC`,
    `${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(40)}`,
    ...entries.map(e => `${String(e.id).padStart(idW)}  ${e.name.padEnd(nameW)}  ${e.desc}`),
    '',
    '// Copy-paste vào CATEGORY_NAMES trong index.html:',
    'const CATEGORY_NAMES = {',
    ...entries.map(e => `  ${e.id}: '${e.name}',  // ${e.desc}`),
    '};',
  ];
  fs.writeFileSync('categories.txt', lines.join('\n'), 'utf-8');
  console.log('Saved → categories.txt\n');
  console.log(lines.slice(0, entries.length + 2).join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });

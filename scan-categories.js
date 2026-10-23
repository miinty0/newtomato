const https = require('https');
const http  = require('http');
const fs    = require('fs');
const zlib  = require('zlib');

// ── Config ──
const BASE    = 'fanqienovel.com';
const API     = `https://${BASE}/api`;
const PAGE    = `https://${BASE}/page`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': `https://${BASE}/`,
  'Origin': `https://${BASE}`,
};
const DELAY_MS       = 500;
const MAX_4XX_ERRORS = 3;

// ── CLI args: node scan-categories.js [start] [end] [--missing-only] ──
const CAT_START = parseInt(process.argv[2], 10) || 1;
const CAT_END   = parseInt(process.argv[3], 10) || 1000;
const MISSING_ONLY = process.argv.includes('--missing-only');

if (!Number.isSafeInteger(CAT_START) || !Number.isSafeInteger(CAT_END) || CAT_START < 1 || CAT_END < CAT_START) {
  throw new Error('Category range must contain positive integers with start <= end');
}

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);

      const chunks = [];
      const encoding = res.headers['content-encoding'] || '';
      let stream = res;

      if (encoding.includes('br')) {
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (encoding.includes('gzip')) {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding.includes('deflate')) {
        stream = res.pipe(zlib.createInflate());
      }

      stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, data });
      });
      stream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Push file to GitHub repo ──
async function ghPushFile(filename, content) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!token || !repo) { console.log('No GITHUB_TOKEN/GITHUB_REPOSITORY — skipping push'); return; }

  const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
  const b64  = Buffer.from(content, 'utf-8').toString('base64');

  // Get existing SHA if file already exists (needed for update)
  let sha;
  try {
    const getRes = await httpGet(url, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' });
    if (getRes.status === 200) sha = JSON.parse(getRes.data).sha;
  } catch(e) {}

  const body = JSON.stringify({ message: `scan-categories: update ${filename}`, content: b64, ...(sha ? { sha } : {}) });

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require('https').request({ hostname: u.hostname, path: u.pathname, method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'scan-categories-script' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}: ${d}`)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── One API request per category; only an explicit empty result means no books ──
function classifyCategoryResponse(json) {
  if (json?.code !== 0) throw new Error('API code=' + String(json?.code) + ': ' + String(json?.message || 'invalid response'));
  const data = json?.data;
  const list = data?.book_list;
  // A real book always wins over contradictory empty counters.
  const book = Array.isArray(list) && list.find(entry => entry?.book_id != null && /^\d+$/.test(String(entry.book_id)) && String(entry.book_id) !== '0');
  if (book) return { status: 'found', bookId: String(book.book_id) };
  if (data?.has_more === false && data?.total_count === 0) return { status: 'empty' };
  throw new Error('Response does not confirm no books and contains no usable book_id');
}

async function fetchFirstBookId(categoryId, request = httpGet) {
  const params = new URLSearchParams({
    page_count: 1, page_index: 0,
    gender: -1, category_id: categoryId,
    creation_status: -1, word_count: -1,
    book_type: -1, sort: -1,
  });
  const res = await request(API + '/author/library/book_list/v0/?' + params, { Accept: 'application/json' });
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  if (!res.data || !res.data.trim()) throw new Error('HTTP 200 but response body is empty');
  let json;
  try { json = JSON.parse(res.data); }
  catch (error) {
    // A truncated response can still contain a complete book_id field.
    // Keep IDs as strings: Fanqie IDs exceed JavaScript's safe integer range.
    // Numeric IDs need a closing delimiter so a truncated number is not used.
    const match = res.data.match(/(?:^|[,{]\s*)"book_id"\s*:\s*(?:"([1-9]\d*)"|([1-9]\d*)(?=\s*[,}\]]))/);
    if (match) return { status: 'found', bookId: match[1] || match[2], recoveredFromInvalidJson: true };
    throw new Error('Invalid JSON: ' + error.message + ' — no complete book_id found — body preview: ' + res.data.slice(0, 200));
  }
  return classifyCategoryResponse(json);
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
  // Load all existing categories_*.json to skip already-known ObjectIds
  const catMap = {};
  const newIds = new Set(); // track only IDs discovered in this run
  const existing = fs.readdirSync('.').filter(f => /^categories_\d+-\d+\.json$/.test(f));
  for (const file of existing) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const e of data) catMap[e.id] = { Name: e.name, ExternalDesc: e.desc };
    } catch(e) {}
  }
  if (existing.length > 0)
    console.log(`Loaded ${Object.keys(catMap).length} existing ObjectIds from: ${existing.join(', ')}\n`);

  let consecutive4xx = 0;
  const unresolved = [];
  let emptyCount = 0, foundCount = 0;
  function markUnresolved(catId, reason) {
    unresolved.push({ id: catId, reason });
    console.log(`  cat ${catId}/${CAT_END}: UNRESOLVED — ${reason} (not no books)`);
  }
  const total = CAT_END - CAT_START + 1;

  const missingCount = Array.from({ length: total }, (_, i) => CAT_START + i)
    .filter(id => !catMap[id]).length;
  console.log(`Scanning category_id ${CAT_START} → ${CAT_END} (${total} categories, mode: ${MISSING_ONLY ? 'missing only' : 'all'})...\n`);
  if (MISSING_ONLY) console.log(`${missingCount} missing IDs; ${total - missingCount} known IDs will be skipped without API requests.\n`);

  for (let catId = CAT_START; catId <= CAT_END; catId++) {
    // Also skip IDs discovered from another book earlier in this run.
    if (MISSING_ONLY && catMap[catId]) continue;

    // Step A: distinguish confirmed empty categories from unavailable responses.
    let result;
    try {
      result = await fetchFirstBookId(catId);
    } catch(e) {
      markUnresolved(catId, 'API: ' + e.message);
      await sleep(DELAY_MS);
      continue;
    }

    if (result.status === 'empty') {
      emptyCount++;
      process.stdout.write('  cat ' + catId + '/' + CAT_END + ': no books — skip (has_more=false, total_count=0)\n');
      await sleep(200);
      continue;
    }
    const bookId = result.bookId;
    if (result.recoveredFromInvalidJson) {
      console.log('  cat ' + catId + '/' + CAT_END + ': invalid JSON, recovered complete book_id=' + bookId + '; verifying via detail page');
    }
    foundCount++;
    console.log('  cat ' + catId + '/' + CAT_END + ': has books — book_id=' + bookId + '; reading category metadata');

    // Step B: fetch detail page
    let res;
    try {
      res = await httpGet(`${PAGE}/${bookId}`);
    } catch(e) {
      markUnresolved(catId, 'detail fetch: ' + e.message);
      await sleep(DELAY_MS);
      continue;
    }

    if (res.status >= 400 && res.status < 500) {
      consecutive4xx++;
      markUnresolved(catId, `detail HTTP ${res.status} (4xx count: ${consecutive4xx}/${MAX_4XX_ERRORS})`);
      if (consecutive4xx >= MAX_4XX_ERRORS) {
        console.log(`\nHit ${MAX_4XX_ERRORS} consecutive 4xx errors — stopping.`);
        break;
      }
      await sleep(DELAY_MS);
      continue;
    }
    consecutive4xx = 0;
    if (res.status !== 200) {
      markUnresolved(catId, 'detail HTTP ' + res.status);
      await sleep(DELAY_MS);
      continue;
    }

    // Step C: parse & store only new ObjectIds
    const cats = parseCategoryV2(res.data);
    if (!cats.length) {
      markUnresolved(catId, 'book_id=' + bookId + ' exists, but categoryV2 metadata could not be read');
      await sleep(DELAY_MS);
      continue;
    }
    if (!cats.some(c => Number(c.ObjectId) === catId)) {
      markUnresolved(catId, 'book_id=' + bookId + ' exists, but its categoryV2 does not identify category ' + catId);
    }
    const allKnown = cats.length > 0 && cats.every(c => catMap[c.ObjectId]);

    if (allKnown) {
      process.stdout.write(`  cat ${catId}/${CAT_END}: all ${cats.length} ObjectIds already known — metadata checked\n`);
    } else {
      let newCount = 0;
      for (const c of cats) {
        if (!catMap[c.ObjectId]) {
          catMap[c.ObjectId] = { Name: c.Name, ExternalDesc: c.ExternalDesc };
          newIds.add(Number(c.ObjectId));
          newCount++;
        }
      }
      process.stdout.write(`  cat ${catId}/${CAT_END}: book ${bookId} | +${newCount} new | total: ${Object.keys(catMap).length}\n`);
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 200));
  }

  console.log(`\nAPI results: ${emptyCount} confirmed empty; ${foundCount} have book_id; ${unresolved.length} unresolved.`);
  fs.writeFileSync('scan-categories-report.json', JSON.stringify({ start: CAT_START, end: CAT_END, missing_only: MISSING_ONLY, confirmed_empty: emptyCount, have_books: foundCount, unresolved }, null, 2), 'utf-8');
  if (unresolved.length) {
    console.log('Unresolved category IDs (not confirmed empty): ' + unresolved.map(e => e.id).join(', '));
    console.log('::warning::Some categories could not be checked. See scan-categories-report.json; do not treat these IDs as empty.');
  }

  // ── Save results ──
  // JSON = full merged superset (all runs); TXT = only this run's new entries
  const entries = Object.entries(catMap)
    .map(([id, info]) => ({ id: Number(id), name: info.Name, desc: info.ExternalDesc }))
    .sort((a, b) => a.id - b.id);

  const newEntries = entries.filter(e => newIds.has(e.id));

  const suffix = `_${CAT_START}-${CAT_END}`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Found ${newEntries.length} new categories this run (${entries.length} total across all runs)\n`);

  const jsonContent = JSON.stringify(entries, null, 2);
  // Missing-only scans update the file consumed by the category tools,
  // even when the requested range is smaller than 1–2000.
  const jsonPath = MISSING_ONLY ? 'categories_1-2000.json' : `categories${suffix}.json`;
  fs.writeFileSync(jsonPath, jsonContent, 'utf-8');
  console.log(`Saved → ${jsonPath} (all ${entries.length} entries)`);
  try {
    await ghPushFile(jsonPath, jsonContent);
    console.log(`Pushed → ${jsonPath} to repo`);
  } catch(e) { console.log(`Push failed: ${e.message}`); }

  const idW   = Math.max(4,  ...newEntries.map(e => String(e.id).length));
  const nameW = Math.max(8,  ...newEntries.map(e => e.name.length));
  const lines = [
    `${'ID'.padStart(idW)}  ${'NAME'.padEnd(nameW)}  DESC`,
    `${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(40)}`,
    ...newEntries.map(e => `${String(e.id).padStart(idW)}  ${e.name.padEnd(nameW)}  ${e.desc}`),
    '',
    '// Copy-paste vào CATEGORY_NAMES trong index.html:',
    'const CATEGORY_NAMES = {',
    ...newEntries.map(e => `  ${e.id}: '${e.name}',  // ${e.desc}`),
    '};',
  ];
  fs.writeFileSync(`categories${suffix}.txt`, lines.join('\n'), 'utf-8');
  console.log(`Saved → categories${suffix}.txt (this run only)\n`);

  console.log(lines.slice(0, newEntries.length + 2).join('\n'));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { classifyCategoryResponse, fetchFirstBookId, parseCategoryV2 };

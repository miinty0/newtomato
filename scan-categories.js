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

// ── CLI args: node scan-categories.js [start] [end] ──
const CAT_START = parseInt(process.argv[2], 10) || 1;
const CAT_END   = parseInt(process.argv[3], 10) || 1000;

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

// ── Fetch first book_id for a category ──
async function fetchFirstBookId(categoryId) {
  const params = new URLSearchParams({
    page_count: 1, page_index: 0,
    gender: -1, category_id: categoryId,
    creation_status: -1, word_count: -1,
    book_type: -1, sort: -1,
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpGet(`${API}/author/library/book_list/v0/?${params}`, { Accept: 'application/json' });
      if (res.status === 429) { await sleep(60000); continue; }
      if (res.status >= 500)  { await sleep(5000 * attempt); continue; }
      if (res.status !== 200) return null;
      let json;
      try {
        json = JSON.parse(res.data);
      } catch(e) {
        console.log(`  JSON parse error (${e.message}) — status: ${res.status} — body preview: ${res.data.slice(0, 300)}`);
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        return null;
      }
      const list = json?.data?.book_list;
      if (!list || list.length === 0) return null;
      return String(list[0].book_id);
    } catch(e) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      throw e;
    }
  }
  return null;
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
  const total = CAT_END - CAT_START + 1;

  console.log(`Scanning category_id ${CAT_START} → ${CAT_END} (${total} categories)...\n`);

  for (let catId = CAT_START; catId <= CAT_END; catId++) {

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
      process.stdout.write(`  cat ${catId}/${CAT_END}: no books — skip\n`);
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
      process.stdout.write(`  cat ${catId}/${CAT_END}: all ${cats.length} ObjectIds already known — skip\n`);
    } else {
      let newCount = 0;
      for (const c of cats) {
        if (!catMap[c.ObjectId]) {
          catMap[c.ObjectId] = { Name: c.Name, ExternalDesc: c.ExternalDesc };
          newIds.add(c.ObjectId);
          newCount++;
        }
      }
      process.stdout.write(`  cat ${catId}/${CAT_END}: book ${bookId} | +${newCount} new | total: ${Object.keys(catMap).length}\n`);
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 200));
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
  fs.writeFileSync(`categories${suffix}.json`, jsonContent, 'utf-8');
  console.log(`Saved → categories${suffix}.json (all ${entries.length} entries)`);
  try {
    await ghPushFile(`categories${suffix}.json`, jsonContent);
    console.log(`Pushed → categories${suffix}.json to repo`);
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

main().catch(e => { console.error(e); process.exit(1); });

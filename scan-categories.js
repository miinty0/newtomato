const https = require('https');
const http  = require('http');

// ── Config ──
const BASE    = 'fanqienovel.com';
const API     = `https://${BASE}/api`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const PAGE_SIZE = 18;
const DELAY_MS  = 400;
const MAX_PAGES = 555; // chạy hết, không dừng sớm

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...HEADERS, Accept: 'application/json' }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ── Main ──
async function scanCategories() {
  const catMap = {}; // { id: { names: Set, count: number } }
  let page       = 0;
  let totalBooks = 0;

  console.log('Scanning ALL 555 pages from fanqienovel API...\n');

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender: 0, category_id: -1,
      creation_status: -1, word_count: -1,
      book_type: -1, sort: 0,
    });

    let books = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpGet(`${API}/author/library/book_list/v0/?${params}`);
        if (res.status === 429) { console.log('  rate limited — waiting 60s'); await sleep(60000); continue; }
        if (res.status >= 500)  { await sleep(10000 * attempt); continue; }
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.book_list) { books = json.data.book_list; break; }
      } catch(e) {
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    if (!books) {
      console.log(`  page ${page+1}: fetch failed — skipping`);
      page++;
    } else if (books.length === 0) {
      console.log(`  page ${page+1}: empty — end of list`);
      break;
    } else {
      totalBooks += books.length;
      let newCatsThisPage = 0;

      for (const b of books) {
        const id = b.category_id;
        if (id === undefined || id === null || id === -1) continue;
        const name = (b.category_name || b.category || '').trim();
        if (!catMap[id]) { catMap[id] = { names: new Set(), count: 0 }; newCatsThisPage++; }
        if (name) catMap[id].names.add(name);
        catMap[id].count++;
      }

      process.stdout.write(`  page ${page+1}/${MAX_PAGES}: ${books.length} books | +${newCatsThisPage} new cats | total cats: ${Object.keys(catMap).length}\n`);
      page++;
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 200));
  }

  // ── Print results ──
  const entries = Object.entries(catMap)
    .map(([id, info]) => ({ id: Number(id), name: [...info.names].join(' / ') || '(no name)', count: info.count }))
    .sort((a, b) => a.id - b.id);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Found ${entries.length} categories from ${totalBooks} books scanned\n`);

  const idW   = Math.max(4, ...entries.map(e => String(e.id).length));
  const nameW = Math.max(8, ...entries.map(e => e.name.length));
  console.log(`${'ID'.padStart(idW)}  ${'NAME'.padEnd(nameW)}  COUNT`);
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  -----`);
  for (const e of entries) {
    console.log(`${String(e.id).padStart(idW)}  ${e.name.padEnd(nameW)}  ${e.count}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('// Copy-paste vào CATEGORY_NAMES trong index.html:\nconst CATEGORY_NAMES = {');
  for (const e of entries) {
    const name = [...catMap[e.id].names][0] || '';
    console.log(`${e.id}: '${name}',`);
  }
  console.log('};');
}

scanCategories().catch(e => { console.error(e); process.exit(1); });

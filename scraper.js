const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Config 
const DATA_DIR    = path.join(__dirname, 'data');
const HEADERS     = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const POOL_SIZE       = 3000;
const RECOMMEND_COUNT = 20;
const PAGE_SIZE       = 18;
const GENDER          = 0;
const REQUEST_DELAY   = 600;
const JITTER          = 300;

const BASE = 'fanqienovel.com';
const API  = `https://${BASE}/api`;
const PAGE = `https://${BASE}/page`;

// CLI args 
// Usage:
//   node scraper.js                  → daily run, all categories (category_id=-1)
//   node scraper.js --category 24    → category run, saves to data/category_24.json
//   node scraper.js -c 24            → same as above
function parseArgs() {
  const args = process.argv.slice(2);
  let categoryId = -1;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--category' || args[i] === '-c') && args[i + 1] !== undefined) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) categoryId = parsed;
      i++;
    }
  }
  return { categoryId, isCategoryRun: categoryId !== -1 };
}

// Utilities 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitteredDelay() { return sleep(REQUEST_DELAY + Math.floor(Math.random() * JITTER)); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// Step 1: Load read list 
function loadReadSet() {
  const p = path.join(DATA_DIR, 'read.json');
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch(e) { return new Set(); }
}

// Step 2: Ranking list 
async function fetchHotRankList(categoryId = -1) {
  const allBooks = [];
  const MAX_PAGES = 350;
  const MAX_RETRY = 3;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (allBooks.length >= POOL_SIZE) break;
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender: GENDER, category_id: categoryId,
      creation_status: -1, word_count: -1,
      book_type: -1, sort: 0,
    });
    let ok = false;
    for (let t = 1; t <= MAX_RETRY; t++) {
      try {
        const res = await httpGet(`${API}/author/library/book_list/v0/?${params}`, { Accept: 'application/json' });
        if (res.status === 429 || res.status >= 500) {
          const wait = res.status === 429 ? 60000 : 10000 * t;
          console.log(`  page ${page+1} HTTP ${res.status} — waiting ${wait/1000}s`);
          await sleep(wait);
          continue;
        }
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.book_list) {
          const batch = json.data.book_list;
          allBooks.push(...batch);
          console.log(`  page ${page+1}: +${batch.length} (total ${allBooks.length})`);
          if (batch.length === 0) return allBooks.slice(0, POOL_SIZE);
          ok = true; break;
        }
      } catch(e) { console.log(`  page ${page+1} attempt ${t}: ${e.message}`); }
      if (t < MAX_RETRY) await sleep(1000 * t);
    }
    if (!ok) console.log(`  page ${page+1} failed — skipping`);
    if (page < MAX_PAGES - 1) await jitteredDelay();
  }
  return allBooks.slice(0, POOL_SIZE);
}

// Step 3: Top book list 
async function fetchTopBookList() {
  try {
    const res  = await httpGet(`${API}/author/misc/top_book_list/v1/`, { Accept: 'application/json' });
    const json = JSON.parse(res.data);
    if (json.book_list) {
      const map = {};
      for (const b of json.book_list) {
        map[String(b.book_id)] = {
          book_name: b.book_name, author: b.author,
          category: b.category, creation_status: b.creation_status,
          thumb_url: b.thumb_url,
        };
      }
      return map;
    }
  } catch(e) {}
  return {};
}

// Step 4: Parse detail page 
function parseDetailPage(html) {
  const info = {};
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*\r?\n/);
  if (stateMatch) {
    try {
      const page = JSON.parse(stateMatch[1])?.page;
      if (page) {
        if (page.bookName)   info.book_name   = page.bookName;
        if (page.authorName) info.author      = page.authorName;
        if (page.abstract)   info.description = page.abstract;
        if (page.thumbUrl)   info.hdImage     = page.thumbUrl;
        if (page.categoryV2) {
          try {
            info.tags = JSON.parse(page.categoryV2).map(c => c.Name).filter(Boolean);
          } catch(e) {}
        }
      }
    } catch(e) {}
  }
  return info;
}

// Step 4b: Cache for completed books 
function loadCache() {
  const p = path.join(DATA_DIR, 'cache.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch(e) { return {}; }
}

function saveCache(cache) {
  const p = path.join(DATA_DIR, 'cache.json');
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
}

// scrapeOnce 
async function scrapeOnce(prevData, readSet, seenBookIds, categoryId = -1) {
  const [hotRankList, topBookMap] = await Promise.all([
    fetchHotRankList(categoryId),
    fetchTopBookList(),
  ]);

  // Build prev rank map for rank_change
  const prevMap = {};
  if (prevData?.books) {
    for (const b of prevData.books) prevMap[b.book_id] = b.hot_rank;
  }

  // Filter out already-read books, keep ranking order
  const candidates = hotRankList.filter(b => !readSet.has(String(b.book_id)));
  console.log(`  pool: ${hotRankList.length} | unread candidates: ${candidates.length}`);

  const top = candidates.slice(0, RECOMMEND_COUNT);
  const cache = loadCache();
  const books = [];
  let cacheUpdated = false;

  for (let i = 0; i < top.length; i++) {
    const rawBook = top[i];
    const bookId  = String(rawBook.book_id);
    const hotRank = hotRankList.findIndex(b => String(b.book_id) === bookId) + 1;
    const topInfo = topBookMap[bookId] || {};

    const creationStatus = topInfo.creation_status ?? rawBook.creation_status;
    const statusLabel    = creationStatus === 0 ? 'Completed' : (creationStatus === 1 ? 'Ongoing' : 'Unknown');
    const isCompleted    = statusLabel === 'Completed';

    const rankChange = !seenBookIds.has(bookId) ? 'new'
      : (bookId in prevMap) ? prevMap[bookId] - hotRank
      : 0;

    const prevBook = prevData?.books?.find(b => b.book_id === bookId);
    if (prevBook) {
      books.push({
        ...prevBook,
        hot_rank: hotRank,
        last_chapter_time: rawBook.last_chapter_time ?? prevBook.last_chapter_time,
        rank_change: rankChange,
      });
      console.log(`  [${i+1}/${top.length}] prev hit: ${bookId}`);
      continue;
    }

    let detailInfo = {};

    if (isCompleted && cache[bookId]) {
      detailInfo = cache[bookId];
      console.log(`  [${i+1}/${top.length}] cache hit: ${bookId}`);
    } else {
      try {
        const res = await httpGet(`${PAGE}/${bookId}`);
        detailInfo = parseDetailPage(res.data);
        if (isCompleted && Object.keys(detailInfo).length > 0) {
          cache[bookId] = detailInfo;
          cacheUpdated = true;
        }
      } catch(e) {}
      if (i < top.length - 1) await sleep(REQUEST_DELAY);
    }

    const bookName        = topInfo.book_name || detailInfo.book_name || `ID:${bookId}`;
    const author          = topInfo.author || detailInfo.author || 'Unknown';
    const category        = topInfo.category || '';
    const abstract        = detailInfo.description || '';
    const thumbUrl        = detailInfo.hdImage || topInfo.thumb_url || rawBook.thumb_url || '';
    const tags            = detailInfo.tags?.length > 0 ? detailInfo.tags : (category ? [category] : []);
    const lastChapterTime = rawBook.last_chapter_time ?? null;

    books.push({
      hot_rank: hotRank,
      book_id: bookId,
      book_name: bookName,
      author,
      tags,
      abstract,
      status: statusLabel,
      thumb_url: thumbUrl,
      last_chapter_time: lastChapterTime,
      rank_change: rankChange,
    });
  }

  if (cacheUpdated) {
    saveCache(cache);
    console.log(`  cache updated (${Object.keys(cache).length} completed books cached)`);
  }

  const newCount = books.filter(b => b.rank_change === 'new').length;
  console.log(`  → new entries this run: ${newCount}`);
  return { books, newCount };
}

// Main 
async function main() {
  const { categoryId, isCategoryRun } = parseArgs();
  const now = getNowBJT();

  console.log('='.repeat(50));
  console.log(`run: ${fmtDateTime(now)}`);
  console.log(isCategoryRun
    ? `mode: CATEGORY run (category_id=${categoryId})`
    : `mode: DAILY run (all categories)`);
  console.log('='.repeat(50));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  // Category runs → data/category_<id>.json
  // Daily runs    → data/latest.json  (unchanged behaviour)
  const outputPath = isCategoryRun
    ? path.join(DATA_DIR, `category_${categoryId}.json`)
    : path.join(DATA_DIR, 'latest.json');

  let prevData = null;
  if (fs.existsSync(outputPath)) {
    try { prevData = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); } catch(e) {}
  }

  // Seen-book tracking:
  //   Daily run    → scan all history snapshots (original behaviour)
  //   Category run → just the previous category file (fresh "new" detection per category)
  const seenBookIds = new Set();
  if (isCategoryRun) {
    for (const b of prevData?.books || []) seenBookIds.add(b.book_id);
  } else {
    const histDir = path.join(DATA_DIR, 'history');
    if (fs.existsSync(histDir)) {
      for (const file of fs.readdirSync(histDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const h = JSON.parse(fs.readFileSync(path.join(histDir, file), 'utf-8'));
          for (const b of h.books || []) seenBookIds.add(b.book_id);
        } catch(e) {}
      }
    }
  }

  const readSet = loadReadSet();
  console.log(`  read list: ${readSet.size} books`);

  // Clean cache of already-read books
  if (readSet.size > 0) {
    const cache = loadCache();
    let cacheChanged = false;
    for (const id of readSet) {
      if (cache[id]) { delete cache[id]; cacheChanged = true; }
    }
    if (cacheChanged) {
      saveCache(cache);
      console.log(`  cache cleaned for read books`);
    }
  }

  console.log('\nRunning...');
  const result = await scrapeOnce(prevData, readSet, seenBookIds, categoryId);
  console.log(`✓ ${result.newCount} new entries — saving`);

  const { books, newCount } = result;
  const saveNow = getNowBJT();

  const data = {
    update_time:  fmtDateTime(saveNow),
    update_date:  fmtDate(saveNow),
    category_id:  categoryId,   // -1 = all categories; otherwise specific category
    total_count:  books.length,
    books,
  };

  // Always write primary output
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');

  // Daily run only: write history snapshot + update index
  if (!isCategoryRun) {
    const histPath = path.join(DATA_DIR, 'history', `${fmtDate(saveNow)}.json`);
    fs.writeFileSync(histPath, JSON.stringify(data, null, 2), 'utf-8');

    const idxPath = path.join(DATA_DIR, 'history_index.json');
    let idx = [];
    if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e) {} }
    const today = fmtDate(saveNow);
    if (!idx.includes(today)) idx.unshift(today);
    idx = idx.slice(0, 90);
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');
  }

  console.log(`\nDone — ${books.length} recommendations, ${newCount} new entries.`);
  if (isCategoryRun) console.log(`Output → ${outputPath}`);
}

main().catch(() => {
  // Exit 0 if we at least have a prior output file to serve, 1 if there's nothing at all
  const { categoryId, isCategoryRun } = parseArgs();
  const fallback = isCategoryRun
    ? path.join(__dirname, 'data', `category_${categoryId}.json`)
    : path.join(__dirname, 'data', 'latest.json');
  process.exit(fs.existsSync(fallback) ? 0 : 1);
});

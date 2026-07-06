const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== Config ==========
const DATA_DIR    = path.join(__dirname, 'data');
const HEADERS     = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const POOL_SIZE       = 3000;
const RECOMMEND_COUNT = 30;
const PAGE_SIZE       = 18;
const GENDER          = 0;
const REQUEST_DELAY   = 600;
const JITTER          = 300;

const BASE = 'fanqienovel.com';
const API  = `https://${BASE}/api`;
const PAGE = `https://${BASE}/page`;

// ========== CLI args ==========
// Usage:
//   node scraper.js                    → daily run, all categories (category_id=-1)
//   node scraper.js --category 24      → category run, saves to data/category_24.json
//   node scraper.js -c 24              → same as above
//   node scraper.js --rank-cat 24      → rank-cat run, saves to data/rank_cat_24.json
function parseArgs() {
  const args = process.argv.slice(2);
  let categoryId  = -1;
  let rankCatId   = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--category' || args[i] === '-c') && args[i + 1] !== undefined) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) categoryId = parsed;
      i++;
    } else if (args[i] === '--rank-cat' && args[i + 1] !== undefined) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) rankCatId = parsed;
      i++;
    }
  }
  return {
    categoryId,
    isCategoryRun: categoryId !== -1,
    rankCatId,
    isRankCatRun:  rankCatId !== null,
  };
}



// ========== Utilities ==========
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

// ========== Thumb URL normalization ==========
// fanqienovel thumb_url comes back with an expiring signature, e.g.:
//   https://p3-novel-sign.byteimg.com/novel-pic/{id}~tplv-resize:225:300.image?lk3s=...&x-expires=...&x-signature=...
// After ~7 days that signed URL 403s. Rewriting it to the permanent CDN path avoids that:
//   https://p6-novel.byteimg.com/thumb/novel-pic/{id}
function normalizeThumbUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const match = url.match(/novel-pic\/([^~?]+)/);
  if (!match) return url;
  return `https://p6-novel.byteimg.com/thumb/novel-pic/${match[1]}`;
}

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

// ========== Step 1: Load read list ==========
function loadReadSet() {
  const p = path.join(DATA_DIR, 'read.json');
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch(e) { return new Set(); }
}

// ========== Step 2: Ranking list ==========
async function fetchHotRankList(categoryId = -1) {
  const allBooks = [];
  const MAX_PAGES = 150;
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

// ========== Step 3: Top book list ==========
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

// ========== Step 4: Parse detail page ==========
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

  // Extract creation time
  const firstChapterMatch = html.match(/"realChapterOrder":"1","firstPassTime":"(\d+)"/);
  if (firstChapterMatch) {
    info.first_chapter_time = parseInt(firstChapterMatch[1], 10);
  }

  return info;
}

// ========== Step 4b: Cache for completed books ==========
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

// ========== scrapeOnce ==========
async function scrapeOnce(prevData, readSet, seenBookIds, categoryId = -1) {
  const isCategoryRun = categoryId !== -1;

  const [hotRankList, topBookMap] = await Promise.all([
    fetchHotRankList(categoryId),
    fetchTopBookList(),
  ]);

  // Build prev rank map for rank_change (daily run only)
  const prevMap = {};
  if (!isCategoryRun && prevData?.books) {
    for (const b of prevData.books) prevMap[b.book_id] = b.hot_rank;
  }

  // Filter out already-read AND already-seen books (for category), keep ranking order
  const candidates = hotRankList.filter(b => {
    const id = String(b.book_id);
    return !readSet.has(id) && !seenBookIds.has(id);
  });
  console.log(`  pool: ${hotRankList.length} | unread+unseen candidates: ${candidates.length}`);

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

    // For category runs all new books are "new"; daily uses rank history
    const rankChange = isCategoryRun ? 'new'
      : !seenBookIds.has(bookId) ? 'new'
      : (bookId in prevMap) ? prevMap[bookId] - hotRank
      : 0;

    // Daily run only: reuse prev data to avoid re-fetching
    if (!isCategoryRun) {
      const prevBook = prevData?.books?.find(b => b.book_id === bookId);
      if (prevBook) {
        books.push({
          ...prevBook,
          thumb_url: normalizeThumbUrl(prevBook.thumb_url),
          hot_rank: hotRank,
          last_chapter_time: rawBook.last_chapter_time ?? prevBook.last_chapter_time,
          rank_change: rankChange,
        });
        console.log(`  [${i+1}/${top.length}] prev hit: ${bookId}`);
        continue;
      }
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
    const thumbUrl        = normalizeThumbUrl(detailInfo.hdImage || topInfo.thumb_url || rawBook.thumb_url || '');
    const tags            = detailInfo.tags?.length > 0 ? detailInfo.tags : (category ? [category] : []);
    const lastChapterTime  = rawBook.last_chapter_time ?? null;
    const firstChapterTime = detailInfo.first_chapter_time ?? null;

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
      first_chapter_time: firstChapterTime,
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

// ========== Seen list helpers (category runs) ==========
function loadSeenSet(categoryId) {
  const p = path.join(DATA_DIR, `category_${categoryId}_seen.json`);
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch(e) { return new Set(); }
}

function saveSeenSet(categoryId, seenSet) {
  const p = path.join(DATA_DIR, `category_${categoryId}_seen.json`);
  fs.writeFileSync(p, JSON.stringify([...seenSet], null, 2), 'utf-8');
}



// ========== Rank-cat seen set helpers ==========
function loadRankCatSeenSet(catId) {
  const p = path.join(DATA_DIR, `rank_cat_${catId}_seen.json`);
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch(e) { return new Set(); }
}
function saveRankCatSeenSet(catId, seenSet) {
  const p = path.join(DATA_DIR, `rank_cat_${catId}_seen.json`);
  fs.writeFileSync(p, JSON.stringify([...seenSet], null, 2), 'utf-8');
}

// ========== Rank-cat: fetch one page ==========
async function fetchRankCatPage(catId, gender, offset, rankMold = 2) {
  const url = `https://fanqienovel.com/api/rank/category/list?app_id=2503&rank_list_type=3&offset=${offset}&limit=300&category_id=${catId}&rank_version=&gender=${gender}&rankMold=${rankMold}`;
  const MAX_RETRY = 3;
  for (let t = 1; t <= MAX_RETRY; t++) {
    try {
      const res = await httpGet(url, { Accept: 'application/json' });
      if (res.status === 429 || res.status >= 500) {
        const wait = res.status === 429 ? 60000 : 10000 * t;
        console.log(`  [rank_cat/${catId}] HTTP ${res.status} gender=${gender} mold=${rankMold} offset=${offset} — wait ${wait/1000}s`);
        await sleep(wait);
        continue;
      }
      const json = JSON.parse(res.data);
      const totalNum = json?.data?.total_num ?? 0;
      const list     = json?.data?.book_list  || [];
      return { totalNum, list };
    } catch(e) {
      console.log(`  [rank_cat/${catId}] attempt ${t} gender=${gender} mold=${rankMold} offset=${offset}: ${e.message}`);
    }
    if (t < MAX_RETRY) await sleep(1000 * t);
  }
  return { totalNum: 0, list: [] };
}

// ========== Rank-cat: main scrape ==========
async function scrapeRankCat(catId) {
  // ── Load config from valid_rank_cats.json ──
  const configPath = path.join(DATA_DIR, 'valid_rank_cats.json');
  let validConfig = { rankMold2: [], rankMold1: [] };
  if (fs.existsSync(configPath)) {
    try { validConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch(e) {}
  }
  const mold2Entry = validConfig.rankMold2.find(e => e.cat_id === catId);
  const mold1Entry = validConfig.rankMold1.find(e => e.cat_id === catId);
  if (!mold2Entry && !mold1Entry) {
    console.log(`  [rank_cat/${catId}] not found in valid_rank_cats.json — skipping`);
    return;
  }
  const gender2 = mold2Entry?.gender ?? 0;
  const gender1 = mold1Entry?.gender ?? 0;
  console.log(`  [rank_cat/${catId}] mold2=${mold2Entry ? `gender=${gender2}` : 'N/A'} | mold1=${mold1Entry ? `gender=${gender1}` : 'N/A'}`);

  const readSet    = loadReadSet();
  const seenSet    = loadRankCatSeenSet(catId);
  const excludeSet = new Set([...readSet, ...seenSet]);

  const outputPath  = path.join(DATA_DIR, `rank_cat_${catId}.json`);
  let prevData = null;
  if (fs.existsSync(outputPath)) {
    try { prevData = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); } catch(e) {}
  }
  const existingBooks = (prevData?.books || []).filter(b => !readSet.has(b.book_id));
  const existingIds   = new Set(existingBooks.map(b => b.book_id));
  console.log(`  [rank_cat/${catId}] existing unread: ${existingBooks.length} | excluded: ${excludeSet.size}`);

  const cache = loadCache();
  let cacheUpdated = false;
  const newDetailedBooks = []; // all newly fetched books across both molds

  // ── Helper: fetch pages for one mold until we have `quota` new candidates ──
  async function fetchMoldCandidates(rankMold, gender, quota) {
    const allRaw = [];
    const LIMIT  = 300;
    let offset   = 0;
    // First page
    const firstPage = await fetchRankCatPage(catId, gender, 0, rankMold);
    console.log(`  [mold=${rankMold}] page1: ${firstPage.list.length} raw (total_num=${firstPage.totalNum})`);
    allRaw.push(...firstPage.list);
    if (firstPage.totalNum > LIMIT) {
      await jitteredDelay();
      const page2 = await fetchRankCatPage(catId, gender, LIMIT, rankMold);
      console.log(`  [mold=${rankMold}] page2: ${page2.list.length} raw`);
      allRaw.push(...page2.list);
    }
    // Normalise
    return allRaw.map(b => ({
      book_id:           String(b.bookId || ''),
      currentPos:        b.currentPos   ?? null,
      rankPosDiff:       b.rankPosDiff  ?? null,
      read_count:        b.read_count   ?? null,
      creation_status:   parseInt(b.creationStatus ?? -1, 10),
      last_chapter_time: b.lastChapterUpdateTime ? parseInt(b.lastChapterUpdateTime, 10) : null,
      thumb_url:         b.thumbUri || '',
    })).filter(b => b.book_id);
  }

  // ── Helper: fetch detail pages for up to `quota` new candidates ──
  async function fetchDetails(rawList, rankMold, quota) {
    const alreadyNewIds = new Set(newDetailedBooks.map(b => b.book_id));
    const candidates = rawList.filter(b =>
      !excludeSet.has(b.book_id) && !existingIds.has(b.book_id) && !alreadyNewIds.has(b.book_id)
    );
    console.log(`  [mold=${rankMold}] new candidates: ${candidates.length} (quota=${quota})`);
    const books = [];
    for (let i = 0; i < candidates.length; i++) {
      if (books.length >= quota) break;
      const raw          = candidates[i];
      const bookId       = raw.book_id;
      const statusLabel  = raw.creation_status === 0 ? 'Completed' : raw.creation_status === 1 ? 'Ongoing' : 'Unknown';
      const isCompleted  = statusLabel === 'Completed';

      let detailInfo = {};
      if (isCompleted && cache[bookId]) {
        detailInfo = cache[bookId];
        console.log(`  [mold=${rankMold} ${books.length+1}/${quota}] cache: ${bookId}`);
      } else {
        try {
          const res = await httpGet(`${PAGE}/${bookId}`);
          detailInfo = parseDetailPage(res.data);
          if (isCompleted && Object.keys(detailInfo).length > 0) {
            cache[bookId] = detailInfo;
            cacheUpdated  = true;
          }
        } catch(e) {
          console.log(`  detail failed: ${bookId} — ${e.message}`);
        }
        if (books.length < quota - 1) await sleep(REQUEST_DELAY);
      }

      books.push({
        book_id:            bookId,
        book_name:          detailInfo.book_name  || `ID:${bookId}`,
        author:             detailInfo.author     || 'Unknown',
        tags:               detailInfo.tags?.length > 0 ? detailInfo.tags : [],
        abstract:           detailInfo.description || '',
        status:             statusLabel,
        thumb_url:          normalizeThumbUrl(detailInfo.hdImage || raw.thumb_url || ''),
        last_chapter_time:  raw.last_chapter_time,
        first_chapter_time: detailInfo.first_chapter_time ?? null,
        currentPos:         raw.currentPos,
        rankPosDiff:        raw.rankPosDiff,
        read_count:         raw.read_count,
        rankMold,           // ← field để UI biết section nào
      });
    }
    return books;
  }

  // ── mold=2: 30 cuốn ──
  if (mold2Entry) {
    const raw2 = await fetchMoldCandidates(2, gender2, 30);
    const books2 = await fetchDetails(raw2, 2, 30);
    newDetailedBooks.push(...books2);
    console.log(`  mold=2 new: ${books2.length}`);
    await jitteredDelay();
  }

  // ── mold=1: 10 cuốn ──
  if (mold1Entry) {
    const raw1 = await fetchMoldCandidates(1, gender1, 10);
    const books1 = await fetchDetails(raw1, 1, 10);
    newDetailedBooks.push(...books1);
    console.log(`  mold=1 new: ${books1.length}`);
  }

  if (cacheUpdated) { saveCache(cache); console.log(`  cache updated`); }

  // Merge existing (preserving their rankMold) + new
  const finalBooks = [...existingBooks, ...newDetailedBooks];

  // Update seen set (shared across both molds)
  const newSeenSet = new Set([...seenSet, ...readSet, ...existingIds, ...newDetailedBooks.map(b => b.book_id)]);
  saveRankCatSeenSet(catId, newSeenSet);
  console.log(`  seen updated (${newSeenSet.size} total)`);

  const now  = getNowBJT();
  const data = {
    update_time:  fmtDateTime(now),
    update_date:  fmtDate(now),
    category_id:  catId,
    total_count:  finalBooks.length,
    new_count:    newDetailedBooks.length,
    books:        finalBooks,
  };
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  saved → ${outputPath} (${finalBooks.length} total, ${newDetailedBooks.length} new)`);
  return data;
}

// ========== Main ==========
async function main() {
  const { categoryId, isCategoryRun, rankCatId, isRankCatRun } = parseArgs();
  const now = getNowBJT();

  console.log('='.repeat(50));
  console.log(`run: ${fmtDateTime(now)}`);
  console.log(isRankCatRun
    ? `mode: RANK-CAT run (category_id=${rankCatId})`
    : isCategoryRun
      ? `mode: CATEGORY run (category_id=${categoryId})`
      : `mode: DAILY run (all categories)`);
  console.log('='.repeat(50));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  // Rank-cat run → early return
  if (isRankCatRun) {
    await scrapeRankCat(rankCatId);
    return;
  }

  // Category runs → data/category_<id>.json
  // Daily runs    → data/latest.json  (unchanged behaviour)
  const outputPath = isCategoryRun
    ? path.join(DATA_DIR, `category_${categoryId}.json`)
    : path.join(DATA_DIR, 'latest.json');

  let prevData = null;
  if (fs.existsSync(outputPath)) {
    try { prevData = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); } catch(e) {}
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

  // ── Seen-book tracking ──
  // Daily run    → scan all history snapshots
  // Category run → load cumulative seen file (category_<id>_seen.json)
  const seenBookIds = new Set();
  if (isCategoryRun) {
    const seen = loadSeenSet(categoryId);
    // Also add anything already in read list — no point showing those
    for (const id of seen)    seenBookIds.add(id);
    for (const id of readSet) seenBookIds.add(id);
    console.log(`  seen list for category ${categoryId}: ${seenBookIds.size} books`);
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

  console.log('\nRunning...');
  const result = await scrapeOnce(prevData, readSet, seenBookIds, categoryId);
  console.log(`✓ ${result.newCount} new entries — saving`);

  const { books: newBooks, newCount } = result;
  const saveNow = getNowBJT();

  let finalBooks;
  if (isCategoryRun) {
    // Accumulate: keep existing unread books + append new ones
    const existingBooks = (prevData?.books || []).filter(b => !readSet.has(b.book_id));
    // Deduplicate just in case
    const existingIds = new Set(existingBooks.map(b => b.book_id));
    const trulyNew = newBooks.filter(b => !existingIds.has(b.book_id));
    finalBooks = [...existingBooks, ...trulyNew];

    // Update cumulative seen file
    const seenToSave = loadSeenSet(categoryId);
    for (const id of readSet)       seenToSave.add(id);
    for (const b  of trulyNew)      seenToSave.add(b.book_id);
    for (const b  of existingBooks) seenToSave.add(b.book_id);
    saveSeenSet(categoryId, seenToSave);
    console.log(`  seen file updated (${seenToSave.size} total)`);
  } else {
    finalBooks = newBooks;
  }

  const data = {
    update_time:  fmtDateTime(saveNow),
    update_date:  fmtDate(saveNow),
    category_id:  categoryId,
    total_count:  finalBooks.length,
    books:        finalBooks,
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

  console.log(`\nDone — ${finalBooks.length} total books (${newCount} new this run).`);
  if (isCategoryRun) console.log(`Output → ${outputPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  const { categoryId, isCategoryRun, rankCatId, isRankCatRun } = parseArgs();
  let fallback;
  if (isRankCatRun) {
    fallback = path.join(__dirname, 'data', `rank_cat_${rankCatId}.json`);
  } else if (isCategoryRun) {
    fallback = path.join(__dirname, 'data', `category_${categoryId}.json`);
  } else {
    fallback = path.join(__dirname, 'data', 'latest.json');
  }
  process.exit(fs.existsSync(fallback) ? 0 : 1);
});

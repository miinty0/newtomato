const metadata = require('./book-metadata');
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
      // setEncoding giữ nguyên ký tự UTF-8 nhiều byte bị cắt giữa 2 chunk (tránh sinh ra U+FFFD)
      res.setEncoding('utf8');
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
const { normalizeThumbUrl } = metadata;

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
async function fetchHotRankList(categoryId = -1, { gender = GENDER, creationStatus = -1 } = {}) {
  const allBooks = [];
  const MAX_PAGES = 150;
  const MAX_RETRY = 3;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (allBooks.length >= POOL_SIZE) break;
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender, category_id: categoryId,
      creation_status: creationStatus, word_count: -1,
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
          allBooks.push(...batch.map((book, index) => ({ ...book, _sortRank: page * PAGE_SIZE + index + 1 })));
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

// Read any usable fields, even when another field in the page is malformed.
async function loadDetail(bookId, isCompleted, cache) {
  const detail = metadata.legacyDetail(isCompleted ? (cache[bookId] || {}) : {});
  detail.book_id = bookId;
  if (metadata.missingFields(detail, false).length) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpGet(`${PAGE}/${bookId}`);
        const parsed = metadata.parseDetailPage(res.data);
        if (parsed.kind === 'ok' && (!parsed.info.book_id || parsed.info.book_id === bookId)) {
          metadata.fillMissing(detail, parsed.info);
          break;
        }
        console.log(`  detail ${bookId}: ${parsed.reason || parsed.kind} (${attempt}/3)`);
        if (res.status !== 429 && res.status < 500) break;
      } catch (error) {
        console.log(`  detail ${bookId}: ${error.message} (${attempt}/3)`);
      }
      if (attempt < 3) await sleep(REQUEST_DELAY * attempt);
    }
    await sleep(REQUEST_DELAY);
  }
  if (isCompleted) cache[bookId] = detail;
  return detail;
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

// Update only ranks in saved daily records; keep metadata and cache untouched.
function improveDailyRanks(data, ranks, readSet) {
  let changed = false;
  for (const book of data?.books || []) {
    const id = String(book.book_id);
    const rank = ranks.get(id);
    const previous = Number(book.hot_rank);
    if (readSet.has(id) || !rank) continue;
    if (!Number.isFinite(previous) || previous <= 0 || rank < previous) {
      book.hot_rank = rank;
      changed = true;
    }
  }
  return changed;
}

function updateDailyHistoryRanks(prevData, ranks, readSet) {
  improveDailyRanks(prevData, ranks, readSet);
  const histDir = path.join(DATA_DIR, 'history');
  if (!fs.existsSync(histDir)) return;
  for (const file of fs.readdirSync(histDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(histDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch (e) { console.log(`  cannot read history ${file}: ${e.message}`); continue; }
    if (improveDailyRanks(data, ranks, readSet)) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }
}

// ========== scrapeOnce ==========
async function scrapeOnce(prevData, readSet, seenBookIds, categoryId = -1) {
  const isCategoryRun = categoryId !== -1;

  const quotas = isCategoryRun
    ? [[0, 1, 20], [0, 0, 10]]
    : [[0, 1, 15], [0, 0, 7], [1, 1, 5], [1, 0, 3]];
  const rankGroups = [];
  for (const [gender, creationStatus, limit] of quotas) {
    const list = await fetchHotRankList(categoryId, { gender, creationStatus });
    rankGroups.push({ list, limit, gender, creationStatus });
  }
  const bestRanks = new Map();
  for (const { list } of rankGroups) {
    list.forEach((book, index) => {
      const id = String(book.book_id);
      const rank = book._sortRank ?? index + 1;
      if (!bestRanks.has(id) || rank < bestRanks.get(id)) bestRanks.set(id, rank);
    });
  }
  if (isCategoryRun) {
    improveDailyRanks(prevData, bestRanks, readSet);
  } else {
    updateDailyHistoryRanks(prevData, bestRanks, readSet);
  }
  const existingBookIds = new Set((prevData?.books || []).map(book => String(book.book_id)));

  // Build prev rank map for rank_change (daily run only)
  const prevMap = {};
  if (!isCategoryRun && prevData?.books) {
    for (const b of prevData.books) prevMap[b.book_id] = b.hot_rank;
  }

  // Apply each group's quota after excluding read, seen, and duplicate IDs.
  const selectedIds = new Set();
  const top = [];
  for (const { list, limit, gender, creationStatus } of rankGroups) {
    let added = 0;
    for (const book of list) {
      if (added >= limit) break;
      const id = String(book.book_id);
      if (readSet.has(id) || seenBookIds.has(id) || existingBookIds.has(id) || selectedIds.has(id)) continue;
      selectedIds.add(id);
      top.push(book);
      added++;
    }
    console.log(`  ${isCategoryRun ? 'category ' : ''}gender=${gender} creation_status=${creationStatus} | pool: ${list.length} | selected: ${added}/${limit}`);
  }
  const cache = loadCache();
  const books = [];
  let cacheUpdated = false;

  for (let i = 0; i < top.length; i++) {
    const rawBook = top[i];
    const bookId  = String(rawBook.book_id);
    const hotRank = bestRanks.get(bookId);

    const creationStatus = Number(rawBook.creation_status ?? -1);
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

    const detailInfo = await loadDetail(bookId, isCompleted, cache);
    if (isCompleted) cacheUpdated = true;
    const bookName = detailInfo.book_name || `ID:${bookId}`;
    const author = detailInfo.author || 'Unknown';
    const abstract = detailInfo.abstract || '';
    const thumbUrl = normalizeThumbUrl(metadata.valid('thumb_url', rawBook.thumb_uri) ? rawBook.thumb_uri : detailInfo.thumb_url || '');
    const tags = detailInfo.tags || [];
    const lastChapterTime = metadata.timestamp(rawBook.last_chapter_time) || detailInfo.last_chapter_time || null;
    const firstChapterTime = detailInfo.first_chapter_time || null;

    books.push({
      hot_rank: hotRank,
      book_id: bookId,
      book_name: bookName,
      author,
      tags,
      abstract,
      status: metadata.status(rawBook.creation_status) || detailInfo.status || statusLabel,
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
      creation_status:   parseInt(b.creationStatus ?? -1, 10),
      last_chapter_time: b.lastChapterUpdateTime ? parseInt(b.lastChapterUpdateTime, 10) : null,
      thumb_url:         b.thumbUri || '',
    })).filter(b => b.book_id);
  }

  // ── Helper: fetch detail pages for up to `quota` new candidates ──
  async function fetchDetails(rawList, rankMold, quota) {
    // Compare positions within the same mold; keep all other saved fields.
    const bestById = new Map();
    for (const raw of rawList) {
      const previous = bestById.get(raw.book_id);
      const rank = Number(raw.currentPos);
      const previousRank = Number(previous?.currentPos);
      if (!previous || (Number.isFinite(rank) && rank > 0 &&
          (!Number.isFinite(previousRank) || previousRank <= 0 || rank < previousRank))) {
        bestById.set(raw.book_id, raw);
      }
    }
    for (const book of [...existingBooks, ...newDetailedBooks]) {
      if (Number(book.rankMold) !== rankMold) continue;
      const rank = Number(bestById.get(String(book.book_id))?.currentPos);
      const previous = Number(book.currentPos);
      if (Number.isFinite(rank) && rank > 0 &&
          (!Number.isFinite(previous) || previous <= 0 || rank < previous)) {
        book.currentPos = rank;
      }
    }
    const alreadyNewIds = new Set(newDetailedBooks.map(b => String(b.book_id)));
    const candidates = [...bestById.values()].filter(b =>
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

      const detailInfo = await loadDetail(bookId, isCompleted, cache);
      if (isCompleted) cacheUpdated = true;

      books.push({
        book_id:            bookId,
        book_name:          detailInfo.book_name  || `ID:${bookId}`,
        author:             detailInfo.author     || 'Unknown',
        tags:               detailInfo.tags?.length > 0 ? detailInfo.tags : [],
        abstract:           detailInfo.abstract || '',
        status:             metadata.status(raw.creation_status) || detailInfo.status || statusLabel,
        thumb_url:          normalizeThumbUrl(metadata.valid('thumb_url', raw.thumb_url) ? raw.thumb_url : detailInfo.thumb_url || ''),
        last_chapter_time:  metadata.timestamp(raw.last_chapter_time) || detailInfo.last_chapter_time || null,
        first_chapter_time: detailInfo.first_chapter_time ?? null,
        currentPos:         raw.currentPos,
        rankPosDiff:        raw.rankPosDiff,
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
  if (!isCategoryRun) {
    for (const book of prevData?.books || []) seenBookIds.add(String(book.book_id));
  }
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
    // A second run today must retain earlier discoveries and their improved ranks.
    const today = fmtDate(saveNow);
    const todayPath = path.join(DATA_DIR, 'history', `${today}.json`);
    let todayBooks = [];
    if (fs.existsSync(todayPath)) {
      todayBooks = JSON.parse(fs.readFileSync(todayPath, 'utf-8')).books || [];
    }
    if (prevData?.update_date === today) todayBooks = [...todayBooks, ...(prevData.books || [])];
    const merged = new Map();
    for (const book of [...todayBooks, ...newBooks]) {
      const id = String(book.book_id);
      if (readSet.has(id)) continue;
      const existing = merged.get(id);
      if (existing) {
        improveDailyRanks({ books: [existing] }, new Map([[id, Number(book.hot_rank)]]), readSet);
      } else {
        merged.set(id, book);
      }
    }
    finalBooks = [...merged.values()];
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
    const idx = fs.readdirSync(path.join(DATA_DIR, 'history'))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, -5))
      .sort().reverse();
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

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Config
const DATA_DIR = path.join(__dirname, 'data');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const TARGET_COUNT = 200;
const PAGE_SIZE = 18;
const GENDER = 0;
const GENDER_LABEL = 'Female';
const REQUEST_DELAY = 600;

const BASE = 'fanqienovel.com';
const API  = `https://${BASE}/api`;
const PAGE = `https://${BASE}/page`;

// ========== Utilities ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// Category list
async function buildCategoryMap() {
  const map = {};
  try {
    const res = await httpGet(`${API}/author/book/category_list/v0/?gender=${GENDER}`, { Accept: 'application/json' });
    const json = JSON.parse(res.data);
    if (json.code === 0 && json.data) {
      for (const cat of json.data) map[cat.name] = { id: cat.category_id };
    }
  } catch (e) {}
  return map;
}

// Ranking list 
async function fetchHotRankList() {
  const allBooks = [];
  const pagesNeeded = Math.ceil(TARGET_COUNT / PAGE_SIZE);
  for (let page = 0; page < pagesNeeded; page++) {
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender: GENDER, category_id: -1,
      creation_status: -1, word_count: -1,
      book_type: -1, sort: 0,
    });
    try {
      const res = await httpGet(`${API}/author/library/book_list/v0/?${params}`, { Accept: 'application/json' });
      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data?.book_list) {
        allBooks.push(...json.data.book_list);
      }
    } catch (e) {}
    if (page < pagesNeeded - 1) await sleep(REQUEST_DELAY);
  }
  return allBooks.slice(0, TARGET_COUNT);
}

// Top book list
async function fetchTopBookList() {
  try {
    const res = await httpGet(`${API}/author/misc/top_book_list/v1/`, { Accept: 'application/json' });
    const json = JSON.parse(res.data);
    if (json.book_list) {
      const map = {};
      for (const b of json.book_list) {
        map[String(b.book_id)] = {
          book_name: b.book_name,
          author: b.author,
          category: b.category,
          creation_status: b.creation_status,
          thumb_url: b.thumb_url,
        };
      }
      return map;
    }
  } catch (e) {}
  return {};
}

// Parse detail page 
function parseDetailPage(html) {
  const info = {};
  const tm = html.match(/<title>(.*?)<\/title>/);
  if (tm) {
    const nm = tm[1].match(/^(.+?)(?:完整版|全文|_)/);
    if (nm) info.book_name = nm[1].trim();
  }
  const dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  if (dm) {
    info.description = dm[1].replace(/^番茄小说提供.*?番茄小说网[。.]?\s*/, '').trim();
  }
  const km = html.match(/<meta\s+name="keywords"\s+content="([^"]*)"/);
  if (km) {
    const am = km[1].match(/,([^,]+?)小说/);
    if (am && !/免费|阅读|章节|下载/.test(am[1])) info.author = am[1].trim();
  }
  const ldm = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ldm) {
    try {
      const ld = JSON.parse(ldm[1]);
      if (!info.author && ld.author?.[0]?.name) info.author = ld.author[0].name;
      if (ld.dateModified) info.dateModified = ld.dateModified;
      if (ld.image?.[0]) info.hdImage = ld.image[0];
    } catch(e) {}
  }
  return info;
}

// Main 
async function main() {
  const now = getNowBJT();

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  const [hotRankList, topBookMap] = await Promise.all([
    fetchHotRankList(),
    fetchTopBookList(),
    buildCategoryMap(),
  ]);

  const books = [];

  for (let i = 0; i < hotRankList.length; i++) {
    const rawBook = hotRankList[i];
    const bookId = String(rawBook.book_id);
    const rank = i + 1;
    const topInfo = topBookMap[bookId] || {};

    let detailInfo = {};
    try {
      const res = await httpGet(`${PAGE}/${bookId}`);
      detailInfo = parseDetailPage(res.data);
    } catch(e) {}

    const bookName       = topInfo.book_name || detailInfo.book_name || `ID:${bookId}`;
    const author         = topInfo.author || detailInfo.author || 'Unknown';
    const category       = topInfo.category || '';
    const creationStatus = topInfo.creation_status ?? rawBook.creation_status;
    const statusLabel    = creationStatus === 0 ? 'Completed' : (creationStatus === 1 ? 'Ongoing' : 'Unknown');
    const abstract       = detailInfo.description || '';
    const thumbUrl       = detailInfo.hdImage || topInfo.thumb_url || rawBook.thumb_url || '';

    books.push({
      rank,
      book_id: bookId,
      book_name: bookName,
      author,
      gender: GENDER_LABEL,
      tags: category ? [category] : [],
      abstract,
      status: statusLabel,
      thumb_url: thumbUrl,
      rank_change: null,
    });

    if (i < hotRankList.length - 1) await sleep(REQUEST_DELAY);
  }

  // Rank change diff
  const latestPath = path.join(DATA_DIR, 'latest.json');
  let prevData = null;
  if (fs.existsSync(latestPath)) {
    try { prevData = JSON.parse(fs.readFileSync(latestPath, 'utf-8')); } catch(e) {}
  }
  if (prevData?.books) {
    const prevMap = {};
    for (const b of prevData.books) prevMap[b.book_id] = b.rank;
    for (const b of books) {
      b.rank_change = b.book_id in prevMap ? prevMap[b.book_id] - b.rank : 'new';
    }
  } else {
    for (const b of books) b.rank_change = 'new';
  }

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    books,
  };

  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');
  const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
  fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

  const idxPath = path.join(DATA_DIR, 'history_index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
  const today = fmtDate(now);
  if (!idx.includes(today)) idx.unshift(today);
  idx = idx.slice(0, 90);
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');
}

main().catch(() => {
  const latestPath = path.join(__dirname, 'data', 'latest.json');
  process.exit(fs.existsSync(latestPath) ? 0 : 1);
});

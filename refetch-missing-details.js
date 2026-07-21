const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ========== Config (giữ đồng bộ với scraper.js) ==========
const DATA_DIR = path.join(__dirname, 'data');
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const REQUEST_DELAY = 600;
const JITTER        = 300;
const MAX_RETRY      = 3; // số lần thử lại cho lỗi mạng / 429 / 5xx trước khi coi là "blocked"

const BASE = 'fanqienovel.com';
const PAGE = `https://${BASE}/page`;

// Các file coi là "book database" (chứa mảng books[])
function isBookDbFile(filename) {
  if (!filename.endsWith('.json')) return false;
  if (filename.endsWith('_seen.json')) return false;
  if (['cache.json', 'read.json', 'valid_rank_cats.json', 'history_index.json'].includes(filename)) return false;
  return filename === 'latest.json' || filename.startsWith('category_') || filename.startsWith('rank_cat_');
}

// Liệt kê toàn bộ file cần quét, trả về ĐƯỜNG DẪN TƯƠNG ĐỐI so với DATA_DIR
function listCandidateFiles() {
  const files = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (isBookDbFile(f)) files.push(f);
  }
  const histDir = path.join(DATA_DIR, 'history');
  if (fs.existsSync(histDir)) {
    for (const f of fs.readdirSync(histDir)) {
      if (f.endsWith('.json')) files.push(path.join('history', f));
    }
  }
  return files;
}

// ========== CLI args ==========
// Usage:
//   node refetch-missing-details.js                       → quét toàn bộ data/*.json
//   node refetch-missing-details.js --file category_24.json  → chỉ quét 1 file
//   node refetch-missing-details.js --limit 50             → giới hạn số sách xử lý trong lần chạy
function parseArgs() {
  const args = process.argv.slice(2);
  let fileFilter = null;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1] !== undefined) { fileFilter = args[i + 1]; i++; }
    else if (args[i] === '--limit' && args[i + 1] !== undefined) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n)) limit = n;
      i++;
    }
  }
  return { fileFilter, limit };
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

// Giống hệt scraper.js — quy đổi thumb_url về CDN vĩnh viễn
function normalizeThumbUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const match = url.match(/novel-pic\/([^~?]+)/);
  if (!match) return url;
  return `https://p6-novel.byteimg.com/thumb/novel-pic/${match[1]}`;
}

// ========== Detect "missing detail" candidates ==========
function isMissingDetail(book) {
  const noAuthor   = !book.author || book.author === 'Unknown';
  const noTags     = !book.tags || book.tags.length === 0;
  const noAbstract = !book.abstract || book.abstract === '';
  return noAuthor && noTags && noAbstract;
}

// ========== Parse detail page — phân biệt 3 kết quả ==========
// { kind: 'blocked' } → không lấy được gì, có thể do bot bị chặn (trang trắng) → DỪNG cả run
// { kind: 'hidden'  } → sách bị ẩn/gỡ do vi phạm (page rỗng + status === null) → đánh dấu, không retry nữa
// { kind: 'ok', info } → lấy được dữ liệu thật
function parseDetailPage(html) {
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*\r?\n/);
  if (!stateMatch) return { kind: 'blocked', reason: 'no __INITIAL_STATE__ (trang trắng)' };

  let state;
  try { state = JSON.parse(stateMatch[1]); }
  catch (e) { return { kind: 'blocked', reason: 'INITIAL_STATE không parse được' }; }

  const page = state?.page;
  if (!page) return { kind: 'blocked', reason: 'không có page trong INITIAL_STATE' };

  const info = {};
  if (page.bookName)   info.book_name   = page.bookName;
  if (page.authorName) info.author      = page.authorName;
  if (page.abstract)   info.description = page.abstract;
  const thumb = page.thumbUri || page.thumbUrl; 
  if (thumb) info.hdImage = thumb;
  if (page.categoryV2) {
    try { info.tags = JSON.parse(page.categoryV2).map(c => c.Name).filter(Boolean); }
    catch (e) {}
  }

  const gotRealData = Boolean(
    info.book_name || info.author || info.description || (info.tags && info.tags.length > 0)
  );

  if (!gotRealData) {
    // page load được nhưng rỗng hoàn toàn:
    // status === null (explicit)  → sách bị ẩn/gỡ do vi phạm, xác nhận vĩnh viễn
    // status khác null (0/1/undefined) nhưng vẫn rỗng → bất thường, coi như blocked để retry sau
    if (page.status === null) return { kind: 'hidden' };
    return { kind: 'blocked', reason: `page rỗng nhưng status=${page.status}` };
  }

  const firstChapterMatch = html.match(/"realChapterOrder":"1","firstPassTime":"(\d+)"/);
  if (firstChapterMatch) info.first_chapter_time = parseInt(firstChapterMatch[1], 10);

  return { kind: 'ok', info };
}

// Fetch + retry cho lỗi mạng/429/5xx. Sau MAX_RETRY lần vẫn fail → coi là blocked (dừng run).
async function fetchDetailWithRetry(bookId) {
  for (let t = 1; t <= MAX_RETRY; t++) {
    try {
      const res = await httpGet(`${PAGE}/${bookId}`);
      if (res.status === 429 || res.status >= 500) {
        const wait = res.status === 429 ? 60000 : 8000 * t;
        console.log(`  [${bookId}] HTTP ${res.status} — chờ ${wait / 1000}s (lần ${t}/${MAX_RETRY})`);
        await sleep(wait);
        continue;
      }
      if (res.status !== 200) {
        console.log(`  [${bookId}] HTTP ${res.status} — coi như bị chặn`);
        return { kind: 'blocked', reason: `HTTP ${res.status}` };
      }
      return parseDetailPage(res.data);
    } catch (e) {
      console.log(`  [${bookId}] lỗi mạng (lần ${t}/${MAX_RETRY}): ${e.message}`);
      if (t < MAX_RETRY) await sleep(3000 * t);
    }
  }
  return { kind: 'blocked', reason: 'lỗi mạng lặp lại sau nhiều lần thử' };
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ========== Main ==========
async function main() {
  const { fileFilter, limit } = parseArgs();
  ensureDir(DATA_DIR);

  const allFiles = listCandidateFiles();
  const targetFiles = fileFilter ? allFiles.filter(f => f === fileFilter) : allFiles;

  if (fileFilter && targetFiles.length === 0) {
    console.log(`Không tìm thấy file "${fileFilter}" trong data/ (hoặc không phải book-db file hợp lệ)".`);
    return;
  }
  console.log(`Quét ${targetFiles.length} file: ${targetFiles.join(', ')}`);

  // Load toàn bộ file, gom candidate theo book_id (1 book_id có thể xuất hiện ở nhiều file)
  const fileCache = {}; // filename -> parsed JSON (mutated trực tiếp)
  const idMap = new Map(); // book_id -> [{ file, index }, ...]

  for (const filename of targetFiles) {
    const fp = path.join(DATA_DIR, filename);
    let json;
    try { json = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
    catch (e) { console.log(`  bỏ qua ${filename}: không parse được JSON`); continue; }
    if (!Array.isArray(json.books)) continue;

    fileCache[filename] = json;
    json.books.forEach((b, idx) => {
      if (!isMissingDetail(b)) return;
      const id = b.book_id;
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push({ file: filename, index: idx });
    });
  }

  let uniqueIds = [...idMap.keys()];
  console.log(`Tổng số book_id thiếu detail (author/tags/abstract): ${uniqueIds.length}`);

  if (limit && uniqueIds.length > limit) {
    console.log(`Giới hạn theo --limit=${limit}`);
    uniqueIds = uniqueIds.slice(0, limit);
  }

  if (uniqueIds.length === 0) {
    console.log('Không có gì để làm.');
    return;
  }

  const touchedFiles = new Set();
  let updatedCount = 0;
  let hiddenCount  = 0;
  let blockedAt    = null;

  try {
    for (let i = 0; i < uniqueIds.length; i++) {
      const bookId = uniqueIds[i];
      console.log(`[${i + 1}/${uniqueIds.length}] fetching ${bookId}...`);
      const result = await fetchDetailWithRetry(bookId);

      if (result.kind === 'blocked') {
        console.log(`⛔ Dừng tại book_id=${bookId} (${result.reason}). Lưu lại những gì đã lấy được từ đầu tới giờ.`);
        blockedAt = bookId;
        break;
      }

      const occurrences = idMap.get(bookId);

      if (result.kind === 'hidden') {
        for (const { file, index } of occurrences) {
          const book = fileCache[file].books[index];
          book.author = '[Hidden]';
          book.status = 'Hidden';
          touchedFiles.add(file);
        }
        hiddenCount++;
        console.log(`  → sách bị ẩn/gỡ do vi phạm, đánh dấu Hidden (${occurrences.length} chỗ)`);
      } else if (result.kind === 'ok') {
        const info = result.info;
        for (const { file, index } of occurrences) {
          const book = fileCache[file].books[index];
          if (info.book_name)   book.book_name = info.book_name;
          if (info.author)      book.author    = info.author;
          if (info.tags && info.tags.length > 0) book.tags = info.tags;
          if (info.description) book.abstract  = info.description;
          if (info.hdImage)     book.thumb_url = normalizeThumbUrl(info.hdImage);
          if (info.first_chapter_time != null) book.first_chapter_time = info.first_chapter_time;
          touchedFiles.add(file);
        }
        updatedCount++;
        console.log(`  → cập nhật thành công (author=${info.author || 'Unknown'}) (${occurrences.length} chỗ)`);
      }

      if (i < uniqueIds.length - 1) await jitteredDelay();
    }
  } finally {
    // Luôn lưu lại những gì đã lấy được, kể cả khi bị chặn hoặc lỗi bất ngờ giữa chừng
    for (const filename of touchedFiles) {
      const fp = path.join(DATA_DIR, filename);
      fs.writeFileSync(fp, JSON.stringify(fileCache[filename], null, 2), 'utf-8');
      console.log(`  đã lưu → data/${filename}`);
    }

    console.log('='.repeat(50));
    console.log(`Kết quả: updated=${updatedCount} hidden=${hiddenCount} còn lại=${uniqueIds.length - updatedCount - hiddenCount - (blockedAt ? 1 : 0)}`);
    if (blockedAt) {
      console.log(`Bị chặn tại book_id=${blockedAt} — chạy lại workflow này sau để tiếp tục với các book_id còn lại.`);
    } else {
      console.log('Hoàn tất toàn bộ candidate, không bị chặn.');
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});

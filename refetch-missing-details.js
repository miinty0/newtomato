const metadata = require('./book-metadata');
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
const BLOCKED_STREAK_LIMIT = 5; // Tạm nghỉ sau 5 book_id liên tiếp không đọc được metadata.
const BLOCKED_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_BLOCKED_COOLDOWNS = 5; // Tổng số lượt nghỉ tối đa trong một lần chạy.

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
      // setEncoding giữ nguyên ký tự UTF-8 nhiều byte bị cắt giữa 2 chunk (tránh sinh ra U+FFFD)
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

const { normalizeThumbUrl, parseDetailPage, missingFields, fillMissing } = metadata;
function isMissingDetail(book) {
  return !!book && typeof book === 'object' && missingFields(book).length > 0;
}

// Fetch + retry cho lỗi mạng/429/5xx. Sau MAX_RETRY lần vẫn fail → tính vào chuỗi blocked để tạm nghỉ.
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
        // Không kết luận "blocked" ngay từ status code: fanqie có thể trả 404/403
        // kèm body vẫn là trang Nuxt đầy đủ (vd sách hidden có status=null trong INITIAL_STATE).
        // Để parseDetailPage tự quyết định dựa trên nội dung thật của body.
        console.log(`  [${bookId}] HTTP ${res.status} — vẫn thử parse body trước khi kết luận`);
      }
      const parsed = parseDetailPage(res.data);
      if (parsed.kind === 'ok' && parsed.info.book_id && parsed.info.book_id !== String(bookId)) {
        return { kind: 'blocked', reason: 'bookId trang chi tiết không khớp ID yêu cầu' };
      }
      if (parsed.kind === 'blocked' && res.status !== 200) {
        parsed.reason = `${parsed.reason} (HTTP ${res.status})`;
      }
      return parsed;
    } catch (e) {
      console.log(`  [${bookId}] lỗi mạng (lần ${t}/${MAX_RETRY}): ${e.message}`);
      if (t < MAX_RETRY) await sleep(3000 * t);
    }
  }
  return { kind: 'blocked', reason: 'lỗi mạng lặp lại sau nhiều lần thử' };
}

// Rankings are source-specific: a detail page cannot supply hot_rank/currentPos.
// Fetch each required source only once per run; preserve every existing position.
const rankSources = new Map();
async function fillMissingRank(book, filename, json) {
  const rankcat = filename.startsWith('rank_cat_');
  const field = rankcat ? 'currentPos' : 'hot_rank';
  if (metadata.valid(field, book[field]) && (!rankcat || metadata.valid('rankPosDiff', book.rankPosDiff))) return false;
  const categoryId = json.category_id ?? (filename.match(/^(?:category_|rank_cat_)(-?\d+)/)?.[1]) ?? -1;
  const mold = Number(book.rankMold);
  if (rankcat && ![1, 2].includes(mold)) return false;
  const creation = metadata.status(book.status) === 'Completed' ? 0 : metadata.status(book.status) === 'Ongoing' ? 1 : -1;
  const key = `${rankcat}:${categoryId}:${mold}:${creation}`;
  if (!rankSources.has(key)) {
    const ranks = new Map();
    let genders = [0];
    if (rankcat) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'valid_rank_cats.json'), 'utf8'));
        const entry = config[`rankMold${mold}`]?.find(e => String(e.cat_id) === String(categoryId));
        genders = entry ? [entry.gender ?? 0] : [0, 1];
      } catch { genders = [0, 1]; }
    } else if (Number(categoryId) === -1) genders = [0, 1];
    for (const gender of genders) {
      const maxPages = rankcat ? 2 : 150;
      for (let page = 0; page < maxPages; page++) {
        const url = rankcat
          ? `https://fanqienovel.com/api/rank/category/list?app_id=2503&rank_list_type=3&offset=${page * 300}&limit=300&category_id=${categoryId}&rank_version=&gender=${gender}&rankMold=${mold}`
          : `https://fanqienovel.com/api/author/library/book_list/v0/?page_count=18&page_index=${page}&gender=${gender}&category_id=${categoryId}&creation_status=${creation}&word_count=-1&book_type=-1&sort=0`;
        let batch = null;
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
          try {
            const response = await httpGet(url, { Accept: 'application/json' });
            const payload = JSON.parse(response.data);
            if (response.status === 200 && (payload.code == null || payload.code === 0) && Array.isArray(payload.data?.book_list)) {
              batch = payload.data.book_list; break;
            }
          } catch {}
          if (attempt < MAX_RETRY) await jitteredDelay();
        }
        // Never calculate positions across a failed page.
        if (!batch) break;
        for (let i = 0; i < batch.length; i++) {
          const raw = batch[i];
          const id = String(rankcat ? raw.bookId : raw.book_id);
          const rank = Number(rankcat ? raw.currentPos : page * 18 + i + 1);
          if (rank > 0 && (!ranks.has(id) || rank < ranks.get(id).rank)) ranks.set(id, {rank, rankPosDiff: raw.rankPosDiff});
        }
        if (batch.length < (rankcat ? 300 : 18)) break;
        await jitteredDelay();
      }
    }
    rankSources.set(key, ranks);
  }
  const found = rankSources.get(key).get(String(book.book_id));
  if (!found) return false;
  let changed = false;
  if (!metadata.valid(field, book[field]) && metadata.valid(field, found.rank)) { book[field] = found.rank; changed = true; }
  if (rankcat && !metadata.valid('rankPosDiff', book.rankPosDiff) && metadata.valid('rankPosDiff', found.rankPosDiff)) { book.rankPosDiff = found.rankPosDiff; changed = true; }
  return changed;
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ========== Main ==========
async function main() {
  const { fileFilter, limit } = parseArgs();
  ensureDir(DATA_DIR);

  const allFiles = listCandidateFiles();
  const targetFiles = fileFilter ? allFiles.filter(f => f === fileFilter) : allFiles;

  if (fileFilter && targetFiles.length === 0) {
    console.log(`Không tìm thấy file "${fileFilter}" trong data/ (hoặc không phải book-db file hợp lệ). Với file trong history, dùng dạng "history/2026-07-20.json".`);
    return;
  }
  console.log(`Quét ${targetFiles.length} file: ${targetFiles.join(', ')}`);

  // Load toàn bộ file, gom candidate theo book_id (1 book_id có thể xuất hiện ở nhiều file)
  const cachePath = path.join(DATA_DIR, 'cache.json');
  let completedCache = {};
  try { completedCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  let cacheChanged = false;
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
      const id = String(b.book_id ?? b.bookId ?? '').trim();
      if (!metadata.valid('book_id', id)) {
        console.log(`  cần kiểm tra thủ công: ${filename}[${idx}] thiếu/lỗi book_id, không đoán ID từ tên`);
        return;
      }
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push({ file: filename, index: idx });
    });
  }

  let uniqueIds = [...idMap.keys()];
  console.log(`Tổng số book_id thiếu/lỗi field bắt buộc: ${uniqueIds.length}`);

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
  let partialCount = 0;
  let hiddenCount  = 0;
  let blockedCount = 0;   // tổng số book_id bị blocked trong suốt run (kể cả những lần "trượt" giữa chừng)
  const processedIds = new Set(); // Retry không làm tăng số ID đã xử lý.
  let consecutiveBlocked = 0;
  let blockedStartIndex = null;
  let cooldownCount = 0;
  let stoppedAt = null;

  function saveProgress() {
    for (const filename of touchedFiles) {
      fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(fileCache[filename], null, 2), 'utf-8');
      console.log(`  đã lưu → data/${filename}`);
    }
    if (cacheChanged) fs.writeFileSync(cachePath, JSON.stringify(completedCache, null, 2), 'utf8');
  }

  try {
    for (let i = 0; i < uniqueIds.length; i++) {
      const bookId = uniqueIds[i];
      console.log(`[${i + 1}/${uniqueIds.length}] fetching ${bookId}...`);
      const needsPage = idMap.get(bookId).some(({file, index}) => metadata.missingFields(fileCache[file].books[index], false).length > 0);
      const result = needsPage ? await fetchDetailWithRetry(bookId) : { kind: 'ok', info: {book_id: bookId} };
      processedIds.add(bookId);

      if (result.kind === 'blocked') {
        blockedCount++;
        if (consecutiveBlocked === 0) blockedStartIndex = i;
        consecutiveBlocked++;
        console.log(`  ⚠️ blocked (${result.reason}) — chuỗi liên tiếp: ${consecutiveBlocked}/${BLOCKED_STREAK_LIMIT}`);

        if (consecutiveBlocked >= BLOCKED_STREAK_LIMIT) {
          const retryIndex = blockedStartIndex;
          if (cooldownCount >= MAX_BLOCKED_COOLDOWNS) {
            stoppedAt = uniqueIds[retryIndex];
            console.log(`⛔ Đã nghỉ đủ ${MAX_BLOCKED_COOLDOWNS} lượt, vẫn gặp ${BLOCKED_STREAK_LIMIT} truyện lỗi liên tiếp. Kết thúc refetch, lưu dữ liệu đã lấy để workflow tiếp tục đẩy lên repo. Chuỗi lỗi bắt đầu từ ${stoppedAt}.`);
            break;
          }
          cooldownCount++;
          saveProgress();
          console.log(`⏸️ ${BLOCKED_STREAK_LIMIT} truyện liên tiếp không đọc được metadata. Nghỉ 15 phút (lượt ${cooldownCount}/${MAX_BLOCKED_COOLDOWNS}), sau đó thử lại từ ${uniqueIds[retryIndex]}.`);
          await sleep(BLOCKED_COOLDOWN_MS);
          consecutiveBlocked = 0;
          blockedStartIndex = null;
          i = retryIndex - 1; // Vòng for tăng i trước khi chạy lại truyện lỗi đầu tiên.
          console.log(`▶️ Tiếp tục từ ${uniqueIds[retryIndex]}.`);
          continue;
        }

        // Chưa đủ ngưỡng → không dừng cả run, thử tiếp book_id kế tiếp
        if (i < uniqueIds.length - 1) await jitteredDelay();
        continue;
      }

      // Bất kỳ kết quả không-blocked nào (ok/hidden) đều xóa chuỗi liên tiếp
      consecutiveBlocked = 0;
      blockedStartIndex = null;

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
        if (result.warning) console.log(`  ⚠️ [${bookId}] ${result.warning}`);
        for (const { file, index } of occurrences) {
          const book = fileCache[file].books[index];
          if (fillMissing(book, info)) touchedFiles.add(file);
          if (await fillMissingRank(book, file, fileCache[file])) touchedFiles.add(file);
        }
        // Keep completed-book cache in sync, filling missing/corrupt values only.
        if (completedCache[bookId] || occurrences.some(({file, index}) => fileCache[file].books[index].status === 'Completed')) {
          const cached = metadata.legacyDetail(completedCache[bookId] || {});
          if (fillMissing(cached, { ...info, book_id: bookId })) {
            completedCache[bookId] = cached;
            cacheChanged = true;
          }
        }
        const remaining = [...new Set(occurrences.flatMap(({ file, index }) => missingFields(fileCache[file].books[index])))];
        if (remaining.length) {
          partialCount++;
          console.log(`  → metadata một phần; còn thiếu: ${remaining.join(', ')} (${occurrences.length} chỗ)`);
        } else {
          updatedCount++;
          console.log(`  → đã đủ field (${occurrences.length} chỗ)`);
        }
      }

      if (i < uniqueIds.length - 1) await jitteredDelay();
    }
  } finally {
    // Lưu cả khi có lỗi bất ngờ; cũng đã checkpoint trước mỗi lần tạm nghỉ.
    saveProgress();
    const notProcessed = uniqueIds.length - processedIds.size;

    console.log('='.repeat(50));
    console.log(`Kết quả: complete=${updatedCount} partial=${partialCount} hidden=${hiddenCount} blocked=${blockedCount} chưa xử lý=${notProcessed}`);
    console.log(`Số lượt tạm nghỉ 15 phút: ${cooldownCount}/${MAX_BLOCKED_COOLDOWNS}`);
    if (stoppedAt) console.log(`Dừng do đạt giới hạn nghỉ. Còn chuỗi lỗi từ ${stoppedAt}; các field chưa lấy được sẽ tiếp tục được chọn ở lần chạy sau.`);
    else if (notProcessed === 0) console.log('Đã duyệt toàn bộ candidate.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');

const SCRIPT_VERSION = '2026-08-18.4-pipe';

// Manual cleanup utility for the repository's data branch.
//
// Examples:
//   node cleanup-books.js --mode year --year 2024 --data-dir ./data --dry-run
//   node cleanup-books.js --mode last_chapter_time --year 2024 --data-dir ./data
//   node cleanup-books.js --mode abstract --keyword "双男|主攻|主受" --data-dir ./data
//   node cleanup-books.js --mode abstract --data-dir ./data
//   node cleanup-books.js --mode combined --last-year 2024 --first-year 2023 --data-dir ./data

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: '',
    year: '',
    lastYear: '',
    firstYear: '',
    keyword: '',
    dataDir: path.join(__dirname, 'data'),
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1] !== undefined) options.mode = argv[++i].trim();
    else if (arg === '--year' && argv[i + 1] !== undefined) options.year = argv[++i].trim();
    else if (arg === '--last-year' && argv[i + 1] !== undefined) options.lastYear = argv[++i].trim();
    else if (arg === '--first-year' && argv[i + 1] !== undefined) options.firstYear = argv[++i].trim();
    else if (arg === '--keyword' && argv[i + 1] !== undefined) options.keyword = argv[++i];
    else if (arg === '--data-dir' && argv[i + 1] !== undefined) options.dataDir = path.resolve(argv[++i]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Tham số không hợp lệ: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`
Cách dùng:
  node cleanup-books.js --mode first_chapter_time --year 2024 [--data-dir ./data] [--dry-run]
  node cleanup-books.js --mode last_chapter_time --year 2024 [--data-dir ./data] [--dry-run]
  node cleanup-books.js --mode abstract [--keyword "双男"] [--data-dir ./data] [--dry-run]
  node cleanup-books.js --mode combined --last-year 2024 --first-year 2023 [--data-dir ./data] [--dry-run]

Chế độ:
  first_chapter_time  Dọn theo năm của first_chapter_time ("year" vẫn là bí danh cũ).
  last_chapter_time   Dọn theo năm của last_chapter_time.
  abstract            Dùng mọi từ khóa đã lưu và có thể thêm từ mới bằng --keyword.
  combined            Dọn nếu khớp abstract hoặc từng mốc thời gian riêng.

Có thể nhập nhiều từ khóa mới trong --keyword, ngăn cách bằng dấu | hoặc xuống
dòng. Danh sách được lưu tại data/cleanup_abstract_keywords.json sau lần chạy
thực thi thành công.

--dry-run chỉ hiển thị kết quả, không sửa file.
`);
}

function validateOptions(options) {
  const validModes = new Set(['year', 'first_chapter_time', 'last_chapter_time', 'abstract', 'combined']);
  if (!validModes.has(options.mode)) {
    throw new Error('--mode phải là "first_chapter_time", "last_chapter_time", "abstract" hoặc "combined".');
  }

  if (options.mode === 'combined') {
    for (const [key, flag] of [['lastYear', '--last-year'], ['firstYear', '--first-year']]) {
      const year = Number(options[key]);
      if (options[key] === '' || !Number.isInteger(year) || year < 1900 || year > 2100) {
        throw new Error(`${flag} phải là một năm hợp lệ từ 1900 đến 2100.`);
      }
      options[key] = year;
    }
  } else if (options.mode !== 'abstract') {
    const year = Number(options.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new Error('--year phải là một năm hợp lệ từ 1900 đến 2100.');
    }
    options.year = year;
  }

  if (!fs.existsSync(options.dataDir) || !fs.statSync(options.dataDir).isDirectory()) {
    throw new Error(`Không tìm thấy thư mục data: ${options.dataDir}`);
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`JSON không hợp lệ: ${filePath} — ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function parseKeywordInput(value) {
  return String(value ?? '')
    // Accept an ASCII pipe, a full-width pipe, or one/more line breaks.
    .split(/[\r\n|｜]+/u)
    .map(keyword => keyword.trim())
    .filter(Boolean);
}

function normalizeBookId(book, fallbackId = '') {
  return String(
    book?.book_id ?? book?.bookId ?? book?.group_id ?? book?.groupId ??
    book?.item_id ?? book?.id ?? fallbackId ?? ''
  ).trim();
}

function firstChapterYear(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  // The scraper currently stores seconds, but accepting milliseconds makes the
  // cleanup resilient to data imported from another source.
  const milliseconds = numeric >= 1e12 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;

  // Fanqie timestamps are interpreted using China Standard Time.
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(date));
}

function lastChapterYear(timestamp) {
  // last_chapter_time uses the same Unix timestamp format and timezone rules.
  return firstChapterYear(timestamp);
}

function bookMatches(book, options) {
  if (!book || typeof book !== 'object') return false;

  if (options.mode === 'year' || options.mode === 'first_chapter_time') {
    const year = firstChapterYear(book.first_chapter_time);
    return year !== null && year <= options.year;
  }

  if (options.mode === 'last_chapter_time') {
    const year = lastChapterYear(book.last_chapter_time);
    return year !== null && year <= options.year;
  }

  if (options.mode === 'combined') {
    const lastYear = lastChapterYear(book.last_chapter_time);
    const firstYear = firstChapterYear(book.first_chapter_time);
    if ((lastYear !== null && lastYear <= options.lastYear) ||
        (firstYear !== null && firstYear <= options.firstYear)) return true;
  }

  const abstract = String(book.abstract ?? book.description ?? '');
  const keywords = Array.isArray(options.abstractKeywords)
    ? options.abstractKeywords
    : parseKeywordInput(options.keyword);
  // Exact contiguous substring matching. For example, "双男" matches only
  // when those two characters actually occur next to each other.
  return keywords.some(keyword => abstract.includes(keyword));
}

function listBookDataFiles(dataDir) {
  const files = [];
  const latestPath = path.join(dataDir, 'latest.json');
  if (fs.existsSync(latestPath)) files.push(latestPath);

  for (const name of fs.readdirSync(dataDir)) {
    if (/^category_\d+\.json$/.test(name) || /^rank_cat_\d+\.json$/.test(name)) {
      files.push(path.join(dataDir, name));
    }
  }

  const historyDir = path.join(dataDir, 'history');
  if (fs.existsSync(historyDir)) {
    for (const name of fs.readdirSync(historyDir)) {
      if (name.endsWith('.json')) files.push(path.join(historyDir, name));
    }
  }

  return [...new Set(files)].sort();
}

function listSeenFiles(dataDir) {
  return fs.readdirSync(dataDir)
    .filter(name => /^(?:category|rank_cat)_\d+_seen\.json$/.test(name))
    .map(name => path.join(dataDir, name))
    .sort();
}

function displayPath(filePath, dataDir) {
  return path.relative(path.dirname(dataDir), filePath).replaceAll(path.sep, '/');
}

function stageCleanup(options) {
  const keywordFilePath = path.join(options.dataDir, 'cleanup_abstract_keywords.json');
  let savedKeywords = [];
  let abstractKeywords = [];
  let addedKeywords = [];

  if (options.mode === 'abstract' || options.mode === 'combined') {
    savedKeywords = readJson(keywordFilePath, []);
    if (!Array.isArray(savedKeywords) || savedKeywords.some(keyword => typeof keyword !== 'string')) {
      throw new Error('data/cleanup_abstract_keywords.json phải là một mảng chuỗi.');
    }

    savedKeywords = [...new Set(savedKeywords.map(keyword => keyword.trim()).filter(Boolean))];
    const incomingKeywords = parseKeywordInput(options.keyword);
    const savedSet = new Set(savedKeywords);
    addedKeywords = [...new Set(incomingKeywords)].filter(keyword => !savedSet.has(keyword));
    abstractKeywords = [...savedKeywords, ...addedKeywords];

    if (abstractKeywords.length === 0) {
      throw new Error('Chưa có từ khóa abstract nào được lưu. Hãy nhập ít nhất một từ vào ô keyword.');
    }
  }

  const planOptions = { ...options, abstractKeywords };
  const dataFiles = listBookDataFiles(options.dataDir);
  const parsedDataFiles = dataFiles.map(filePath => {
    const data = readJson(filePath, {});
    if (!Array.isArray(data.books)) data.books = [];
    return { filePath, data };
  });

  const cachePath = path.join(options.dataDir, 'cache.json');
  const cache = readJson(cachePath, {});
  const matchedIds = new Set();
  const matchedBooks = new Map();
  const sourceCounts = new Map();

  function rememberMatch(book, fallbackId, source) {
    if (!bookMatches(book, planOptions)) return;
    const bookId = normalizeBookId(book, fallbackId);
    if (!bookId) return;
    matchedIds.add(bookId);
    if (!matchedBooks.has(bookId)) {
      matchedBooks.set(bookId, {
        book_id: bookId,
        book_name: book.book_name || book.bookName || '',
        first_chapter_time: book.first_chapter_time ?? null,
        last_chapter_time: book.last_chapter_time ?? null,
        abstract: book.abstract ?? book.description ?? '',
      });
    }
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  }

  for (const { filePath, data } of parsedDataFiles) {
    const source = displayPath(filePath, options.dataDir);
    for (const book of data.books) rememberMatch(book, '', source);
  }
  for (const [bookId, book] of Object.entries(cache)) {
    rememberMatch(book, bookId, 'data/cache.json');
  }

  const readPath = path.join(options.dataDir, 'read.json');
  const existingRead = readJson(readPath, []);
  if (!Array.isArray(existingRead)) throw new Error('data/read.json phải là một mảng ID.');
  const existingReadSet = new Set(existingRead.map(String));
  const mergedRead = [];
  const readSeen = new Set();
  for (const id of [...existingRead, ...matchedIds]) {
    const normalized = String(id);
    if (!readSeen.has(normalized)) {
      readSeen.add(normalized);
      mergedRead.push(normalized);
    }
  }

  const dataUpdates = [];
  const deletedHistoryFiles = [];
  for (const { filePath, data } of parsedDataFiles) {
    const originalBooks = data.books;
    const books = originalBooks.filter(book => !matchedIds.has(normalizeBookId(book)));
    if (books.length === originalBooks.length) continue;

    const isHistory = path.dirname(filePath) === path.join(options.dataDir, 'history');
    if (isHistory && books.length === 0) {
      deletedHistoryFiles.push(filePath);
      continue;
    }

    const updated = { ...data, books, total_count: books.length };
    if (typeof updated.new_count === 'number') {
      updated.new_count = Math.min(updated.new_count, books.length);
    }
    dataUpdates.push({ filePath, value: updated, removed: originalBooks.length - books.length });
  }

  const cacheUpdates = { ...cache };
  let cacheRemoved = 0;
  for (const id of matchedIds) {
    if (Object.prototype.hasOwnProperty.call(cacheUpdates, id)) {
      delete cacheUpdates[id];
      cacheRemoved++;
    }
  }

  const seenUpdates = [];
  for (const filePath of listSeenFiles(options.dataDir)) {
    const ids = readJson(filePath, []);
    if (!Array.isArray(ids)) throw new Error(`${filePath} phải là một mảng ID.`);
    const filtered = ids.filter(id => !matchedIds.has(String(id)));
    if (filtered.length !== ids.length) {
      seenUpdates.push({ filePath, value: filtered, removed: ids.length - filtered.length });
    }
  }

  const historyIndexPath = path.join(options.dataDir, 'history_index.json');
  const historyIndex = readJson(historyIndexPath, []);
  const deletedDates = new Set(deletedHistoryFiles.map(filePath => path.basename(filePath, '.json')));
  const updatedHistoryIndex = Array.isArray(historyIndex)
    ? historyIndex.filter(date => !deletedDates.has(String(date)))
    : [];

  return {
    options: planOptions,
    keywordFilePath,
    savedKeywords,
    abstractKeywords,
    addedKeywords,
    keywordFileChanged: (options.mode === 'abstract' || options.mode === 'combined') && addedKeywords.length > 0,
    matchedIds,
    matchedBooks,
    sourceCounts,
    readPath,
    mergedRead,
    readAdded: [...matchedIds].filter(id => !existingReadSet.has(id)).length,
    dataUpdates,
    deletedHistoryFiles,
    cachePath,
    cacheUpdates,
    cacheRemoved,
    seenUpdates,
    historyIndexPath,
    historyIndexChanged: updatedHistoryIndex.length !== historyIndex.length,
    updatedHistoryIndex,
  };
}

function printPlan(plan) {
  let criterion;
  if (plan.options.mode === 'year' || plan.options.mode === 'first_chapter_time') {
    criterion = `first_chapter_time thuộc năm ${plan.options.year} trở về trước`;
  } else if (plan.options.mode === 'last_chapter_time') {
    criterion = `last_chapter_time thuộc năm ${plan.options.year} trở về trước`;
  } else if (plan.options.mode === 'combined') {
    criterion = `abstract chứa từ khóa đã lưu, hoặc last_chapter_time thuộc năm ${plan.options.lastYear} trở về trước, hoặc first_chapter_time thuộc năm ${plan.options.firstYear} trở về trước`;
  } else {
    criterion = `abstract chứa ít nhất một trong ${plan.abstractKeywords.length} từ khóa đã lưu`;
  }

  console.log('='.repeat(68));
  console.log(`Phiên bản: ${SCRIPT_VERSION}`);
  console.log(`Điều kiện: ${criterion}`);
  console.log(`Thư mục:   ${plan.options.dataDir}`);
  console.log(`Chế độ:    ${plan.options.dryRun ? 'DRY RUN — không sửa file' : 'THỰC THI'}`);
  console.log(`Khớp:      ${plan.matchedIds.size} book ID`);
  console.log('='.repeat(68));

  if (plan.options.mode === 'abstract' || plan.options.mode === 'combined') {
    console.log('\nTừ khóa đang áp dụng:');
    for (const keyword of plan.abstractKeywords) {
      const isNew = plan.addedKeywords.includes(keyword);
      console.log(`  ${JSON.stringify(keyword)}${isNew ? '  (mới)' : ''}`);
    }
  }

  if (plan.sourceCounts.size > 0) {
    console.log('\nNguồn phát hiện:');
    for (const [source, count] of [...plan.sourceCounts.entries()].sort()) {
      console.log(`  ${source}: ${count}`);
    }
  }

  if (plan.matchedBooks.size > 0) {
    console.log('\nCác book sẽ dọn:');
    for (const book of plan.matchedBooks.values()) {
      let years = '';
      if (plan.options.mode === 'combined') {
        years = ` | last=${lastChapterYear(book.last_chapter_time) ?? '—'} first=${firstChapterYear(book.first_chapter_time) ?? '—'}`;
      } else {
        const year = plan.options.mode === 'last_chapter_time'
          ? lastChapterYear(book.last_chapter_time)
          : firstChapterYear(book.first_chapter_time);
        if (year) years = ` | ${year}`;
      }
      console.log(`  ${book.book_id} | ${book.book_name || '(không có tên)'}${years}`);
    }
  }

  console.log('\nThay đổi dự kiến:');
  if (plan.keywordFileChanged) {
    console.log(`  data/cleanup_abstract_keywords.json: +${plan.addedKeywords.length} từ khóa`);
  }
  console.log(`  read.json: +${plan.readAdded} ID`);
  for (const update of plan.dataUpdates) {
    console.log(`  ${displayPath(update.filePath, plan.options.dataDir)}: -${update.removed} book`);
  }
  for (const filePath of plan.deletedHistoryFiles) {
    console.log(`  ${displayPath(filePath, plan.options.dataDir)}: xóa file rỗng`);
  }
  if (plan.cacheRemoved > 0) console.log(`  data/cache.json: -${plan.cacheRemoved} mục`);
  for (const update of plan.seenUpdates) {
    console.log(`  ${displayPath(update.filePath, plan.options.dataDir)}: -${update.removed} ID`);
  }
  if (plan.historyIndexChanged) console.log('  data/history_index.json: cập nhật');
}

function applyPlan(plan) {
  if (plan.keywordFileChanged) writeJsonAtomic(plan.keywordFilePath, plan.abstractKeywords);
  if (plan.matchedIds.size === 0) return;

  writeJsonAtomic(plan.readPath, plan.mergedRead);
  for (const update of plan.dataUpdates) writeJsonAtomic(update.filePath, update.value);
  for (const filePath of plan.deletedHistoryFiles) fs.unlinkSync(filePath);
  if (plan.cacheRemoved > 0) writeJsonAtomic(plan.cachePath, plan.cacheUpdates);
  for (const update of plan.seenUpdates) writeJsonAtomic(update.filePath, update.value);
  if (plan.historyIndexChanged) writeJsonAtomic(plan.historyIndexPath, plan.updatedHistoryIndex);
}

function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  validateOptions(options);
  const plan = stageCleanup(options);
  printPlan(plan);

  if (options.dryRun) {
    if (plan.matchedIds.size === 0) console.log('\nKhông tìm thấy book nào khớp điều kiện.');
    console.log('\nDry run hoàn tất. Bỏ --dry-run để thực sự sửa dữ liệu.');
    return;
  }

  applyPlan(plan);
  if (plan.matchedIds.size === 0) {
    if (plan.keywordFileChanged) {
      console.log(`\n✓ Đã lưu ${plan.addedKeywords.length} từ khóa mới; hiện chưa có book nào khớp.`);
    } else {
      console.log('\nKhông tìm thấy book nào khớp điều kiện và không có thay đổi dữ liệu.');
    }
    return;
  }
  console.log(`\n✓ Hoàn tất: đã thêm ${plan.readAdded} ID mới vào read.json và dọn ${plan.matchedIds.size} book ID.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nFatal: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCRIPT_VERSION,
  parseArgs,
  parseKeywordInput,
  firstChapterYear,
  lastChapterYear,
  bookMatches,
  stageCleanup,
  applyPlan,
};

// Shared metadata rules for scraping and repairing saved books.
function text(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\uFFFD');
}
function timestamp(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const n = Number(value);
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}
function status(value) {
  if (value === 0 || value === '0' || value === 'Completed') return 'Completed';
  if (value === 1 || value === '1' || value === 'Ongoing') return 'Ongoing';
  return null;
}
function normalizeThumbUrl(value) {
  if (!text(value)) return '';
  const match = value.match(/novel-pic\/([^~?]+)/);
  return match ? `https://p6-novel.byteimg.com/thumb/novel-pic/${match[1]}` : value;
}
function valid(field, value) {
  if (field === 'book_id') return text(value) && /^\d+$/.test(value);
  if (field === 'status') return status(value) !== null;
  if (field === 'rankPosDiff') return value != null && value !== '' && Number.isFinite(Number(value));
  if (field.endsWith('_time')) return timestamp(value) !== null;
  if (field === 'hot_rank' || field === 'currentPos') return timestamp(value) !== null;
  if (field === 'tags') return Array.isArray(value) && value.length > 0 && value.every(text);
  if (!text(value)) return false;
  if (field === 'author') return value.trim() !== 'Unknown';
  if (field === 'book_name') return !value.startsWith('ID:') && value !== 'Unknown';
  if (field === 'thumb_url') return /^https?:\/\//.test(normalizeThumbUrl(value));
  return true;
}
const FIELDS = ['book_id', 'book_name', 'author', 'status', 'tags', 'abstract', 'thumb_url', 'first_chapter_time', 'last_chapter_time'];
function missingFields(book, includeRank = true) {
  if (book.status === 'Hidden' || book.author === '[Hidden]') return [];
  const rankFields = Object.hasOwn(book, 'rankMold') || Object.hasOwn(book, 'currentPos') ? ['currentPos', 'rankPosDiff'] : ['hot_rank'];
  const fields = includeRank ? [...FIELDS, ...rankFields] : FIELDS;
  return fields.filter(field => !valid(field, book[field]));
}
function fillMissing(book, source) {
  let changed = false;
  for (const field of [...FIELDS, 'hot_rank', 'currentPos', 'rankPosDiff']) {
    if (!valid(field, book[field]) && valid(field, source[field])) {
      book[field] = source[field]; changed = true;
    }
  }
  if (valid('thumb_url', book.thumb_url)) {
    const normalized = normalizeThumbUrl(book.thumb_url);
    if (normalized !== book.thumb_url) { book.thumb_url = normalized; changed = true; }
  }
  return changed;
}
// Decode individual complete JSON tokens if a different field broke the state.
// Never execute page JavaScript or accept an unterminated/truncated string.
function extract(raw, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\[\\s\\S])*"|-?\\d+(?:\\.\\d+)?|null)(?=\\s*[,}\\]])');
  const match = raw.match(re);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}
function parseDetailPage(html) {
  const marker = html.match(/window\.__INITIAL_STATE__\s*=\s*/);
  if (!marker) return { kind: 'blocked', reason: 'no __INITIAL_STATE__' };
  const raw = html.slice(marker.index + marker[0].length).split(/<\/script\s*>/i)[0].trim().replace(/;\s*$/, '');
  let page;
  try { page = JSON.parse(raw)?.page; } catch {}
  if (!page) {
    // A malformed unrelated value must not discard readable metadata.
    const body = raw.slice(Math.max(0, raw.search(/"page"\s*:/)));
    page = {};
    for (const key of ['bookId', 'bookName', 'author', 'authorName', 'abstract', 'categoryV2', 'thumbUri', 'thumbUrl', 'creationStatus', 'lastPublishTime']) {
      page[key] = extract(body, key);
    }
  }
  const info = {};
  const assign = (field, value) => { if (valid(field, value)) info[field] = value; };
  assign('book_id', String(page.bookId ?? ''));
  assign('book_name', page.bookName);
  assign('author', text(page.author) ? page.author : page.authorName);
  assign('abstract', page.abstract);
  assign('status', status(page.creationStatus));
  assign('thumb_url', normalizeThumbUrl(page.thumbUri || page.thumbUrl));
  assign('last_chapter_time', timestamp(page.lastPublishTime));
  let categories = page.categoryV2;
  if (typeof categories === 'string') { try { categories = JSON.parse(categories); } catch { categories = null; } }
  if (Array.isArray(categories)) assign('tags', [...new Set(categories.map(c => c.Name))]);
  const chapters = Array.isArray(page.chapterListWithVolume) ? page.chapterListWithVolume.flat(Infinity) : [];
  let firstOrder = Infinity;
  let firstTime = null;
  const considerChapter = chapter => {
    const order = Number(chapter?.realChapterOrder);
    const time = timestamp(chapter?.firstPassTime);
    if (Number.isInteger(order) && order > 0 && order < firstOrder && time !== null) {
      firstOrder = order;
      firstTime = time;
    }
  };
  for (const chapter of chapters) considerChapter(chapter);
  if (firstTime === null) {
    // Recover complete chapter fields even when another part of the state is
    // broken. Braces inside JSON strings must not split chapter objects.
    for (const object of raw.match(/\{(?:[^{}"]|"(?:[^"\\]|\\[\s\S])*")*\}/g) || []) {
      considerChapter({
        realChapterOrder: extract(object, 'realChapterOrder'),
        firstPassTime: extract(object, 'firstPassTime'),
      });
    }
  }
  assign('first_chapter_time', firstTime);
  if (Object.keys(info).length) return { kind: 'ok', info };
  // Only a successfully decoded, explicitly empty page can be marked Hidden.
  if (page.status === null) return { kind: 'hidden' };
  return { kind: 'blocked', reason: 'không đọc được field metadata nào' };
}
function legacyDetail(info) {
  const result = { ...info };
  if (valid('abstract', info.description) && !valid('abstract', result.abstract)) result.abstract = info.description;
  if (valid('thumb_url', info.hdImage) && !valid('thumb_url', result.thumb_url)) result.thumb_url = normalizeThumbUrl(info.hdImage);
  return result;
}
module.exports = { text, timestamp, status, normalizeThumbUrl, valid, missingFields, fillMissing, parseDetailPage, legacyDetail };


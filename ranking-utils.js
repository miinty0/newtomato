(function(root) {
  'use strict';
  function normalize(raw, position) {
    const rawId = raw.book_id ?? raw.bookId;
    if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) return null;
    const id = String(rawId ?? '').trim();
    if (!/^\d+$/.test(id) || id === '0') return null;
    const status = String(raw.creation_status ?? raw.creationStatus ?? raw.status ?? '');
    const thumb = String(raw.thumb_url ?? raw.thumbUri ?? raw.cover_url ?? '');
    const pic = thumb.match(/novel-pic\/([^~?]+)/);
    const cleanText = value => String(value ?? '').replace(/[\uE000-\uF8FF]/g, '□');
    return {
      book_id: id,
      book_name: cleanText(raw.book_name ?? raw.bookName ?? raw.title) || `Truyện #${id}`,
      author: cleanText(raw.author),
      abstract: cleanText(raw.abstract ?? raw.summary),
      abstract_verified: raw.abstract_verified ?? (!raw.abstract_unverified && typeof (raw.abstract ?? raw.summary) === 'string' && !/[\uE000-\uF8FF]/.test(raw.abstract ?? raw.summary)),
      thumb_url: pic ? `https://p6-novel.byteimg.com/thumb/novel-pic/${pic[1]}` : (/^https:\/\//.test(thumb) ? thumb : ''),
      status: status === '0' || status === 'Completed' ? 'Completed' : status === '1' || status === 'Ongoing' ? 'Ongoing' : 'Unknown',
      currentPos: raw.currentPos ?? position,
      rankPosDiff: raw.rankPosDiff ?? null,
      read_count: raw.read_count ?? raw.readCount ?? null,
      last_chapter_time: raw.last_chapter_time ?? raw.lastChapterUpdateTime ?? raw.last_publish_time ?? null,
      first_chapter_time: raw.first_chapter_time ?? null,
      tags: Array.isArray(raw.tags) ? raw.tags : (raw.category ? [raw.category] : []),
      score: raw.score ?? null
    };
  }
  function unique(raw, offset = 0) {
    const seen = new Set();
    return raw.map((book, i) => normalize(book, offset + i + 1)).filter(book => {
      if (!book || seen.has(book.book_id)) return false;
      seen.add(book.book_id); return true;
    });
  }
  const api = { normalize, unique };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FqRankings = api;
})(typeof globalThis === 'object' ? globalThis : this);

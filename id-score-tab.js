'use strict';

const fqIdScoreYearFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' });
const fqIdScoreYear = time => fmtTime(time, fqIdScoreYearFormat);
const fqIdScoreState = { rows: [], running: false, stopped: false, page: 1, timer: null, note: '', phase: '', yearsRunning: false, cleanupPolicy: null };
const fqIdScoreEl = id => document.getElementById('idscore-' + id);

function fqIdScoreParse(text) {
  const matches = String(text).match(/\d+/g) || [];
  const valid = matches.filter(id => /^\d{15,22}$/.test(id));
  const ids = [...new Set(valid)]; // Keep IDs as strings: they exceed JS safe integers.
  return { ids, duplicates: valid.length - ids.length };
}

async function fqIdScoreLoadCleanupPolicy() {
  const response = await fetch('./cleanup-policy.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('cleanup-policy.json HTTP ' + response.status);
  const policy = await response.json();
  if (![policy?.firstYear, policy?.lastYear].every(year => Number.isInteger(year) && year >= 1900 && year <= 2100)) {
    throw new Error('cleanup-policy.json cần có firstYear và lastYear từ 1900 đến 2100.');
  }
  return policy;
}

function fqIdScoreCleanupHidden(row) {
  if (row.cleanupByYear || cleanupKeywordReadIds.has(row.id)) return true;
  if (considerCleanupRead(row.book, row.id) || considerCleanupRead({ abstract: row.shareInfo?.sub_text }, row.id)) return true;
  // Use dates from this run. Cached last-update dates may predate a new chapter.
  const policy = fqIdScoreState.cleanupPolicy;
  if (row.chapterYearsLoading || !policy) return false;
  const { firstChapterYear, lastChapterYear } = row;
  const oldFirst = firstChapterYear && Number(firstChapterYear) <= policy.firstYear;
  const oldLast = lastChapterYear && Number(lastChapterYear) <= policy.lastYear;
  if (!oldFirst && !oldLast) return false;
  row.cleanupByYear = true;
  queueReadIds(new Set([row.id]));
  return true;
}

function fqIdScoreSorted() {
  const group = row => row.status === 'done' ? (row.score === null ? 1 : 0) : row.status === 'error' ? 2 : 3;
  return fqIdScoreState.rows.filter(row => !row.manuallyHidden && !fqIdScoreCleanupHidden(row)).sort((a, b) =>
    group(a) - group(b) || (group(a) === 0 ? b.score - a.score : 0) || a.order - b.order);
}

function fqIdScoreCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const cover = url.pathname.match(/(?:^|\/)novel-pic\/([^/~]+)/);
    return cover ? 'https://p6-novel.byteimg.com/thumb/novel-pic/' + cover[1] : url.href;
  } catch (_) { return ''; }
}

function fqIdScoreChapterYears(row) {
  const knownBook = _bookRegistry[row.id];
  const lastYear = row.lastChapterYear || fqIdScoreYear(knownBook?.last_chapter_time);
  const firstYear = row.firstChapterYear || fqIdScoreYear(knownBook?.first_chapter_time) ||
    fqIdScoreYear(fqRankingFirstTimeCache[row.id]);
  return [lastYear, firstYear];
}

function fqIdScoreMetadataMissing(row) {
  return row.status === 'done' && !Object.keys(row.book || {}).length;
}

function fqIdScoreNeedsYears(row) {
  return !fqIdScoreMetadataMissing(row) && (row.status === 'done' || row.status === 'error') && fqIdScoreChapterYears(row).some(year => !year);
}

async function fqIdScoreLoadYears(scoreReady = new Map()) {
  const state = fqIdScoreState;
  const fetchPage = window.fqShareApiFetchBookPage;
  const fetchDetails = fetchPage || window.fqShareApiFetchChapterTimes;
  if (typeof fetchDetails !== 'function') return;
  const needsPage = row => !fqIdScoreMetadataMissing(row) && (!row.firstChapterYear || !row.lastChapterYear || (fetchPage && !row.chapterYearsChecked));
  const rows = fqIdScoreSorted().filter(needsPage);
  if (!rows.length) return;

  state.yearsRunning = true;
  fqIdScoreScheduleRender();
  let next = 0;
  const worker = async () => {
    while (!state.stopped && next < rows.length) {
      const row = rows[next++];
      await scoreReady.get(row.id)?.promise;
      if (state.stopped || row.manuallyHidden || fqIdScoreCleanupHidden(row) || !needsPage(row)) continue;
      row.chapterYearsLoading = true;
      try {
        const details = await fetchDetails(row.id);
        if (Array.isArray(details?.tags) && details.tags.length) row.fullTags = details.tags;
        if ([0, 1, 2].includes(details?.gender)) row.categoryGender = details.gender;
        row.fanqieLastYear = fqIdScoreYear(details?.last_chapter_time) || row.fanqieLastYear;
        row.fanqieFirstYear = fqIdScoreYear(details?.first_chapter_time) || row.fanqieFirstYear;
        row.lastChapterYear = row.fanqieLastYear || row.lastChapterYear;
        row.firstChapterYear = row.fanqieFirstYear || row.firstChapterYear;
      } catch (error) {
        console.warn('[Score theo ID] Lỗi tải trang truyện Fanqie', row.id, error);
      }
      row.chapterYearsChecked = true;
      row.chapterYearsLoading = false;
      fqIdScoreCleanupHidden(row);
      fqIdScoreScheduleRender();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
  } finally {
    state.yearsRunning = false;
    fqIdScoreScheduleRender();
  }
}

function fqIdScoreBookHTML(row) {
  if (fqIdScoreMetadataMissing(row)) return `<a href="https://fanqienovel.com/page/${row.id}" target="_blank" rel="noopener noreferrer">${escapeHTML(row.id)}</a><p style="color:var(--muted);font-size:12px">Share API không trả thông tin truyện cho ID này.</p>`;
  const book = row.book || {};
  const cover = fqIdScoreCoverUrl(book.thumb_url);
  const fieldText = value => value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
  const title = book.book_name || book.book_short_name || row.shareInfo?.text || row.id;
  const abstract = book.abstract || row.shareInfo?.sub_text || '';
  const [lastYear, firstYear] = fqIdScoreChapterYears(row);
  const years = row.chapterYearsChecked && fqIdScoreNeedsYears(row)
    ? 'Y-Y: lỗi, truyện ẩn'
    : [lastYear, firstYear].filter(Boolean).join('-');
  const chapters = Number(book.serial_count) > 1000 ? '+1k' : book.serial_count;
  const status = String(book.creation_status) === '0' ? 'Hoàn thành' : String(book.creation_status) === '1' ? 'Còn tiếp' : book.creation_status;
  const stats = [
    book.author ? authorLinkHTML(book.author) : '',
    chapters != null && chapters !== '' ? `${escapeHTML(fieldText(chapters))} chương` : '',
    escapeHTML(fieldText(status)),
    row.categoryGender === 0 ? 'Nữ tần' : row.categoryGender === 1 ? 'Nam tần' : row.categoryGender === 2 ? 'gender=2' : (row.chapterYearsChecked || (!window.fqShareApiFetchBookPage && (row.status === 'done' || row.status === 'error'))) ? 'gender=lỗi' : '',
  ].filter(Boolean).join(' · ');
  const bookTags = row.fullTags || book.tags;
  const tags = Array.isArray(bookTags) ? bookTags.join(',') : fieldText(bookTags);
  return `<div style="display:flex;gap:14px;align-items:flex-start">
    <div style="width:76px;flex-shrink:0">${cover ? `<img src="${escapeHTML(cover)}" alt="Bìa ${escapeHTML(title)}" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:76px;height:108px;object-fit:cover;border-radius:6px;background:var(--tag-bg)" onerror="this.style.display='none';this.nextElementSibling.hidden=false"><span hidden>Không tải được bìa</span>` : '<span style="font-size:12px;color:var(--muted)">Chưa có bìa</span>'}</div>
    <div style="flex:1;min-width:0">
      <a href="https://fanqienovel.com/page/${row.id}" target="_blank" rel="noopener noreferrer" style="font-weight:600;font-size:16px">${escapeHTML(title)}</a>
      <div style="font:11px monospace;color:var(--muted);margin:3px 0 8px">${row.id}</div>
      ${stats ? `<div style="font-size:12px;color:var(--muted)">${stats}</div>` : ''}
      ${tags ? `<div style="font-size:12px;color:var(--muted);overflow-wrap:anywhere">Tag: ${escapeHTML(tags)}</div>` : ''}
      ${years ? `<div class="book-time notranslate">${years}</div>` : ''}
      ${abstract ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0">${escapeHTML(abstract)}</p>` : ''}
    </div>
  </div>`;
}

function fqIdScoreRender() {
  const state = fqIdScoreState;
  const sorted = fqIdScoreSorted();
  const done = sorted.filter(row => row.status === 'done').length;
  const errors = sorted.filter(row => row.status === 'error').length;
  const numeric = sorted.filter(row => row.status === 'done' && row.score !== null).length;
  const missingYears = sorted.filter(fqIdScoreNeedsYears).length;
  const yearNote = missingYears && !state.running
    ? !window.fqShareApiFetchBookPage && !window.fqShareApiFetchChapterTimes
      ? 'Cập nhật Fanqie Share API Score Bridge lên 1.6.3 rồi tải lại trang để lấy năm, tag và gender.'
      : `${missingYears} ID thiếu năm chương. Có thể thử lại.`
    : '';
  const tagNote = state.rows.length && !state.running && window.fqShareApiFetchChapterTimes && !window.fqShareApiFetchBookPage
    ? 'Cập nhật Fanqie Share API Score Bridge lên 1.6.3 để lấy đủ tag và gender.'
    : '';
  const progress = [
    state.phase === 'bridge' ? 'Đang lấy score qua Fanqie Bridge' : state.phase ? 'Đang lấy score' : '',
    state.yearsRunning ? (window.fqShareApiFetchBookPage ? 'Đang lấy năm chương, tag và gender' : 'Đang lấy năm chương') : '',
  ].filter(Boolean).join(' · ');
  const policyNote = state.rows.length && !state.cleanupPolicy ? 'Chưa tải được cấu hình cleanup theo năm.' : '';
  const statusText = state.running
    ? state.stopped ? 'Đang dừng, chờ yêu cầu đang gửi…' : progress || 'Đang xử lý…'
    : state.stopped ? 'Đã dừng.' : 'Sẵn sàng.';
  fqIdScoreEl('info').textContent = `${statusText} ${done}/${sorted.length} ID xong · ${numeric} có điểm · ${done - numeric} N/A · ${errors} lỗi. ${state.note} ${yearNote} ${tagNote} ${policyNote}`.trim();
  fqIdScoreEl('start').disabled = state.running;
  fqIdScoreEl('input').disabled = state.running;
  fqIdScoreEl('clear').disabled = state.running;
  fqIdScoreEl('stop').disabled = !state.running || state.stopped;
  fqIdScoreEl('retry').disabled = state.running || !(missingYears || sorted.some(row => row.status !== 'done'));
  const copyable = sorted.some(row => row.status === 'done' || row.status === 'error');
  fqIdScoreEl('copy').disabled = !copyable;
  fqIdScoreEl('copy-table').disabled = !copyable;
  const pages = Math.max(1, Math.ceil(sorted.length / 200));
  state.page = Math.min(pages, Math.max(1, state.page));
  const start = (state.page - 1) * 200;
  fqIdScoreEl('pages').innerHTML = sorted.length ? `<button class="pagination-btn" onclick="fqIdScorePage(-1)" ${state.page === 1 ? 'disabled' : ''}>←</button><span class="pagination-info">Trang ${state.page}/${pages} · ${sorted.length} ID</span><button class="pagination-btn" onclick="fqIdScorePage(1)" ${state.page === pages ? 'disabled' : ''}>→</button>` : '';
  fqIdScoreEl('results').innerHTML = sorted.slice(start, start + 200).map((row, index) => {
    const status = row.status === 'done' ? (row.score === null ? 'Chưa có điểm' : 'Xong') : row.status === 'error' ? row.error : row.status === 'loading' ? 'Đang lấy…' : row.status === 'deferred' ? 'Chờ Fanqie Bridge ở pha cuối' : 'Chờ';
    return `<tr style="vertical-align:top;border-bottom:1px solid var(--border)"><td style="padding:12px 8px">${start + index + 1}<button type="button" class="btn btn-outline btn-sm" style="display:block;margin-top:8px" onclick="fqIdScoreHide(${htmlJSString(row.id)})" title="Ẩn truyện và bỏ qua khi copy ID">Ẩn</button></td><td style="padding:12px 8px;min-width:300px;max-width:750px">${fqIdScoreBookHTML(row)}</td><td style="padding:12px 8px;font-weight:700;white-space:nowrap">${row.status === 'done' ? (row.score === null ? 'N/A' : escapeHTML(row.display)) : '—'}</td><td style="padding:12px 8px;font-size:12px">${escapeHTML(status)}</td></tr>`;
  }).join('');
}

function fqIdScoreScheduleRender() {
  if (fqIdScoreState.timer !== null) return;
  fqIdScoreState.timer = setTimeout(() => {
    fqIdScoreState.timer = null;
    fqIdScoreRender();
  }, 150);
}

function fqIdScoreHide(id) {
  const row = fqIdScoreState.rows.find(row => row.id === String(id));
  if (!row) return;
  row.manuallyHidden = true;
  fqIdScoreRender();
}

function fqIdScorePage(delta) { fqIdScoreState.page += delta; fqIdScoreRender(); }
function fqIdScoreStop() { fqIdScoreState.stopped = true; fqIdScoreRender(); }
function fqIdScoreClear() {
  if (fqIdScoreState.running) return;
  fqIdScoreState.rows = [];
  fqIdScoreState.stopped = false;
  fqIdScoreState.note = '';
  fqIdScoreRender();
}

async function fqIdScoreStart(retry = false) {
  const state = fqIdScoreState;
  if (state.running) return;
  let policy;
  try {
    [, policy] = await Promise.all([
      ensureCleanupKeywords(true),
      fqIdScoreLoadCleanupPolicy().catch(error => {
        console.warn('[Score theo ID] Lỗi tải cấu hình cleanup', error);
        return null;
      }),
    ]);
  } catch (error) {
    toast('Không tải được từ khóa cleanup: ' + error.message, 'err');
    return;
  }
  if (state.running) return;
  const fetchScore = window.fqShareApiFetchShareInfo;
  if (typeof fetchScore !== 'function') { toast('Cập nhật công cụ Fanqie score lên 1.5.1 rồi tải lại trang để lấy trực tiếp Share API.', 'err'); return; }
  if (!retry) {
    const parsed = fqIdScoreParse(fqIdScoreEl('input').value);
    if (!parsed.ids.length) { toast('Không tìm thấy ID Fanqie hợp lệ.', 'err'); return; }
    state.rows = parsed.ids.map((id, order) => ({ id, order, score: null, status: 'pending', error: '' }));
    state.note = parsed.duplicates ? `Đã bỏ ${parsed.duplicates} ID trùng.` : '';
    state.page = 1;
  }
  state.cleanupPolicy = policy;
  const queue = fqIdScoreSorted().filter(row => row.status !== 'done');
  if (!queue.length && !fqIdScoreSorted().some(fqIdScoreNeedsYears)) {
    fqIdScoreRender();
    return;
  }
  state.running = true;
  state.stopped = false;
  state.phase = queue.length ? 'initial' : '';
  const scoreReady = new Map(queue.map(row => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return [row.id, {promise, resolve}];
  }));
  let next = 0;
  fqIdScoreRender();
  const worker = async () => {
    while (!state.stopped && next < queue.length) {
      const row = queue[next++];
      if (row.manuallyHidden || fqIdScoreCleanupHidden(row)) continue;
      row.status = 'loading';
      fqIdScoreScheduleRender();
      try {
        // Same response supplies score and display-only metadata.
        // Never call the normal score side-effect path.
        const bridgePhase = state.phase === 'bridge';
        const fetchMeta = window.fqShareApiFetchBookMeta;
        if (bridgePhase && typeof fetchMeta !== 'function') throw new Error('Fanqie Bridge chưa sẵn sàng; cập nhật công cụ score rồi thử lại.');
        // Use the same fallback-enabled helper as Daily, without requestScore's
        // shared-cache, automatic-read or persistent-status side effects.
        const response = bridgePhase ? await fetchMeta(row.id, {deferBridge: false}) : await fetchScore(row.id);
        const book = response?.book_info || response?.data?.book_info;
        if (book && typeof book === 'object' && !Array.isArray(book) && Object.keys(book).length) {
          row.book = book;
          scoreReady.get(row.id)?.resolve();
        }
        row.firstChapterYear = row.fanqieFirstYear || fqIdScoreYear(book?.first_chapter_time) || fqIdScoreYear(response?.first_chapter_time) || row.firstChapterYear;
        row.lastChapterYear = row.fanqieLastYear || fqIdScoreYear(book?.last_chapter_time) || fqIdScoreYear(response?.last_chapter_time) ||
          fqIdScoreYear(book?.last_chapter_first_pass_time) || fqIdScoreYear(book?.last_chapter_update_time) ||
          fqIdScoreYear(book?.last_publish_time) || row.lastChapterYear;
        const shareInfo = response?.share_info || response?.data;
        if (shareInfo) row.shareInfo = shareInfo;
        fqIdScoreCleanupHidden(row);
        const raw = response && typeof response === 'object' ? response.score : response;
        const value = raw == null ? '' : String(raw).trim();
        if (!value) throw new Error('Score trống; có thể thử lại.');
        const na = /^N\/?A$/i.test(value);
        if (na && !bridgePhase) {
          row.status = 'deferred';
          row.error = '';
          continue;
        }
        const score = Number(value);
        if (!na && (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(score) || score < 0 || score > 10)) throw new Error('Score trả về không hợp lệ.');
        row.score = na ? null : score;
        row.display = na ? 'N/A' : value;
        row.status = 'done';
        row.error = '';
      } catch (error) {
        row.status = 'error';
        row.error = String(error?.message || error);
      }
      fqIdScoreScheduleRender();
    }
  };
  const runScores = async () => {
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
    // Like Daily: complete the direct pass before invoking Bridge for errors
    // and missing scores. Only the final fallback can resolve an ID as N/A.
    if (!state.stopped) {
      const failed = queue.filter(row => row.status === 'error' || row.status === 'deferred');
      if (failed.length) {
        queue.splice(0, queue.length, ...failed);
        next = 0;
        state.phase = 'bridge';
        fqIdScoreRender();
        await worker();
      }
    }
    state.phase = '';
    fqIdScoreScheduleRender();
  };
  try {
    await Promise.all([fqIdScoreLoadYears(scoreReady), runScores().finally(() => {
      for (const gate of scoreReady.values()) gate.resolve();
    })]);
  } finally {
    state.running = false;
    state.phase = '';
    clearTimeout(state.timer);
    state.timer = null;
    fqIdScoreRender();
  }
}

async function fqIdScoreCopy(withScore) {
  try { await ensureCleanupKeywords(true); }
  catch (error) { toast('Không tải được từ khóa cleanup: ' + error.message, 'err'); return; }
  fqIdScoreRender();
  const rows = fqIdScoreSorted().filter(row => row.status === 'done' || row.status === 'error');
  if (!rows.length) return;
  const text = withScore
    ? 'ID\tScore\n' + rows.map(row => row.id + '\t' + (row.status === 'error' ? 'ERROR' : row.score === null ? 'N/A' : row.display)).join('\n')
    : rows.map(row => row.id).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Đã copy ${rows.length} ID theo score; gồm ID lỗi; đã bỏ truyện ẩn, truyện khớp cleanup và ID chưa chạy.`, 'ok');
  } catch (error) { toast('Không copy được: ' + error.message, 'err'); }
}


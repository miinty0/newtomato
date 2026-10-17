'use strict';

// Deliberately isolated from requestScore: no status updates, automatic read,
// shared score cache, global metadata registration, or persistent storage.
const fqIdScoreState = { rows: [], running: false, stopped: false, page: 1, timer: null, note: '' };
const fqIdScoreEl = id => document.getElementById('idscore-' + id);

function fqIdScoreParse(text) {
  const matches = String(text).match(/\d+/g) || [];
  const valid = matches.filter(id => /^\d{15,22}$/.test(id));
  const ids = [...new Set(valid)]; // Keep IDs as strings: they exceed JS safe integers.
  return { ids, duplicates: valid.length - ids.length };
}

function fqIdScoreSorted() {
  const group = row => row.status === 'done' ? (row.score === null ? 1 : 0) : row.status === 'error' ? 2 : 3;
  return [...fqIdScoreState.rows].sort((a, b) =>
    group(a) - group(b) || (group(a) === 0 ? b.score - a.score : 0) || a.order - b.order);
}

function fqIdScoreCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) { return ''; }
}

function fqIdScoreBookHTML(row) {
  const book = row.book || {};
  const cover = fqIdScoreCoverUrl(book.thumb_url);
  const fieldText = value => value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
  const fields = Object.entries(book).map(([key, value]) => `<div style="display:grid;grid-template-columns:145px minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--border)"><dt>${escapeHTML(key)}</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(fieldText(value))}</dd></div>`).join('');
  const title = book.book_name || book.book_short_name || row.shareInfo?.text || row.id;
  const abstract = book.abstract || row.shareInfo?.sub_text || '';
  const stats = [
    ['Tác giả', book.author], ['Tag', book.tags], ['Danh mục', book.category],
    ['Số chương', book.serial_count], ['Số chữ', book.word_number], ['Lượt đọc', book.read_count],
    ['Trạng thái', book.creation_status == null ? null : String(book.creation_status) === '0' ? 'Hoàn thành' : String(book.creation_status) === '1' ? 'Còn tiếp' : book.creation_status],
  ].filter(([, value]) => value != null && value !== '');
  const metadataMissing = row.status === 'done' && !Object.keys(book).length;
  return `<div style="display:flex;gap:14px;align-items:flex-start">
    <div style="width:76px;flex-shrink:0">${cover ? `<img src="${escapeHTML(cover)}" alt="Bìa ${escapeHTML(title)}" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:76px;height:108px;object-fit:cover;border-radius:6px;background:var(--tag-bg)" onerror="this.style.display='none';this.nextElementSibling.hidden=false"><span hidden>Không tải được bìa</span>` : '<span style="font-size:12px;color:var(--muted)">Chưa có bìa</span>'}</div>
    <div style="flex:1;min-width:0">
      <a href="https://fanqienovel.com/page/${row.id}" target="_blank" rel="noopener noreferrer" style="font-weight:600;font-size:16px">${escapeHTML(title)}</a>
      <div style="font:11px monospace;color:var(--muted);margin:3px 0 8px">${row.id}</div>
      <div style="font-size:12px;color:var(--muted)">${stats.map(([label, value]) => `${label}: ${escapeHTML(fieldText(value))}`).join(' · ')}</div>
      ${abstract ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0">${escapeHTML(abstract)}</p>` : ''}
      ${metadataMissing ? '<p style="color:var(--muted);font-size:12px">Chưa nhận được thông tin truyện. Cập nhật Fanqie score lên 1.5.0 và bấm Lấy score để lấy lại; nếu API lỗi thì chỉ có điểm từ nguồn dự phòng.</p>' : ''}
      ${fields ? `<details><summary style="cursor:pointer;color:var(--accent)">Toàn bộ field book_info (${Object.keys(book).length})</summary><dl style="font-size:12px;margin:8px 0">${fields}</dl></details>` : ''}
      ${row.shareInfo ? `<details><summary style="cursor:pointer;color:var(--muted);font-size:12px">Toàn bộ dữ liệu Share API</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;margin:8px 0">${escapeHTML(JSON.stringify(row.shareInfo, null, 2))}</pre></details>` : ''}
    </div>
  </div>`;
}

function fqIdScoreRender() {
  const state = fqIdScoreState;
  const sorted = fqIdScoreSorted();
  const done = sorted.filter(row => row.status === 'done').length;
  const errors = sorted.filter(row => row.status === 'error').length;
  const numeric = sorted.filter(row => row.status === 'done' && row.score !== null).length;
  fqIdScoreEl('info').textContent = `${state.running ? (state.stopped ? 'Đang dừng, chờ yêu cầu đang gửi…' : 'Đang lấy score…') : state.stopped ? 'Đã dừng.' : 'Sẵn sàng.'} ${done}/${sorted.length} ID xong · ${numeric} có điểm · ${done - numeric} N/A · ${errors} lỗi. ${state.note}`;
  fqIdScoreEl('start').disabled = state.running;
  fqIdScoreEl('input').disabled = state.running;
  fqIdScoreEl('clear').disabled = state.running;
  fqIdScoreEl('stop').disabled = !state.running || state.stopped;
  fqIdScoreEl('retry').disabled = state.running || !sorted.some(row => row.status !== 'done');
  fqIdScoreEl('copy').disabled = !done;
  fqIdScoreEl('copy-table').disabled = !done;
  const pages = Math.max(1, Math.ceil(sorted.length / 200));
  state.page = Math.min(pages, Math.max(1, state.page));
  const start = (state.page - 1) * 200;
  fqIdScoreEl('pages').innerHTML = sorted.length ? `<button class="pagination-btn" onclick="fqIdScorePage(-1)" ${state.page === 1 ? 'disabled' : ''}>←</button><span class="pagination-info">Trang ${state.page}/${pages} · ${sorted.length} ID</span><button class="pagination-btn" onclick="fqIdScorePage(1)" ${state.page === pages ? 'disabled' : ''}>→</button>` : '';
  fqIdScoreEl('results').innerHTML = sorted.slice(start, start + 200).map((row, index) => {
    const status = row.status === 'done' ? (row.score === null ? 'Chưa có điểm' : 'Xong') : row.status === 'error' ? row.error : row.status === 'loading' ? 'Đang lấy…' : 'Chờ';
    return `<tr style="vertical-align:top;border-bottom:1px solid var(--border)"><td style="padding:12px 8px">${start + index + 1}</td><td style="padding:12px 8px;min-width:300px;max-width:750px">${fqIdScoreBookHTML(row)}</td><td style="padding:12px 8px;font-weight:700;white-space:nowrap">${row.status === 'done' ? (row.score === null ? 'N/A' : escapeHTML(row.display)) : '—'}</td><td style="padding:12px 8px;font-size:12px">${escapeHTML(status)}</td></tr>`;
  }).join('');
}

function fqIdScoreScheduleRender() {
  if (fqIdScoreState.timer !== null) return;
  fqIdScoreState.timer = setTimeout(() => {
    fqIdScoreState.timer = null;
    fqIdScoreRender();
  }, 150);
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
  const fetchScore = window.fqShareApiFetchBookMeta;
  if (typeof fetchScore !== 'function') { toast('Kết nối lấy score chưa sẵn sàng. Thử lại khi kết nối đã tải xong.', 'err'); return; }
  if (!retry) {
    const parsed = fqIdScoreParse(fqIdScoreEl('input').value);
    if (!parsed.ids.length) { toast('Không tìm thấy ID Fanqie hợp lệ.', 'err'); return; }
    state.rows = parsed.ids.map((id, order) => ({ id, order, score: null, status: 'pending', error: '' }));
    state.note = parsed.duplicates ? `Đã bỏ ${parsed.duplicates} ID trùng.` : '';
    state.page = 1;
  }
  const queue = state.rows.filter(row => row.status !== 'done');
  if (!queue.length) return;
  state.running = true;
  state.stopped = false;
  let next = 0;
  fqIdScoreRender();
  const worker = async () => {
    while (!state.stopped && next < queue.length) {
      const row = queue[next++];
      row.status = 'loading';
      fqIdScoreScheduleRender();
      try {
        // Same response supplies score and display-only metadata.
        // Never call the normal score side-effect path.
        const response = await fetchScore(row.id);
        const book = response?.book_info || response?.data?.book_info || {};
        row.book = book && typeof book === 'object' && !Array.isArray(book) ? book : {};
        row.shareInfo = response?.share_info || response?.data || null;
        const raw = response && typeof response === 'object' ? response.score : response;
        const value = raw == null ? '' : String(raw).trim();
        if (!value) throw new Error('Score trống; có thể thử lại.');
        const na = /^N\/?A$/i.test(value);
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
  try {
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
  } finally {
    state.running = false;
    clearTimeout(state.timer);
    state.timer = null;
    fqIdScoreRender();
  }
}

async function fqIdScoreCopy(withScore) {
  const rows = fqIdScoreSorted().filter(row => row.status === 'done');
  if (!rows.length) return;
  const text = withScore
    ? 'ID\tScore\n' + rows.map(row => row.id + '\t' + (row.score === null ? 'N/A' : row.display)).join('\n')
    : rows.map(row => row.id).join('|');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Đã copy ${rows.length} ID theo score; bỏ qua ID lỗi / chưa chạy.`, 'ok');
  } catch (error) { toast('Không copy được: ' + error.message, 'err'); }
}

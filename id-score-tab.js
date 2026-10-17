'use strict';

// Deliberately isolated from requestScore: no status updates, automatic read,
// shared score cache, metadata registration, or persistent storage.
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
    return `<tr><td style="padding:8px">${start + index + 1}</td><td style="padding:8px"><a href="https://fanqienovel.com/page/${row.id}" target="_blank" rel="noopener noreferrer">${row.id}</a></td><td style="padding:8px">${row.status === 'done' ? (row.score === null ? 'N/A' : escapeHTML(row.display)) : '—'}</td><td style="padding:8px">${escapeHTML(status)}</td></tr>`;
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
        // Existing transport returns an object; consume only score and discard
        // all remaining fields. Never call the normal score side-effect path.
        const response = await fetchScore(row.id);
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

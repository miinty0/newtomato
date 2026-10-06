'use strict';
let fqRankingReadSet = new Set();
const fqRankingState = { initialized: false, worker: null, pending: new Map(), books: [], sections: [], section: 0, next: 0, more: false, version: '', generation: 0, busy: false };
const FQ_RANK_ORIGIN = 'https://fanqienovel.com';
const FQ_RANK_CHANNEL = 'wd-fq-bridge-v2';
let fqRankingCategories = { male: [], female: [] };
let fqRankingSnapshot = null;
const fqRankEl = id => document.getElementById(id);

window.addEventListener('message', event => {
  const data = event.data;
  if (event.origin !== FQ_RANK_ORIGIN || event.source !== fqRankingState.worker || data?.__wdFqBridge !== FQ_RANK_CHANNEL || data.kind !== 'response') return;
  const request = fqRankingState.pending.get(data.id);
  if (!request) return;
  clearTimeout(request.timer); fqRankingState.pending.delete(data.id);
  if (data.ok) request.resolve(data.result);
  else request.reject(new Error(data.error || 'Fanqie request lỗi'));
});

function fqRankRequest(action, payload = {}, timeout = 90000) {
  const worker = fqRankingState.worker;
  if (!worker || worker.closed) return Promise.reject(new Error('Bấm “Kết nối tab Fanqie”, đợi tab tải xong rồi lấy danh sách.'));
  const id = 'rank-' + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fqRankingState.pending.delete(id);
      reject(new Error('Fanqie không phản hồi. Kiểm tra bridge v4.2.1 đang bật và tab Fanqie đã tải xong; dữ liệu cũ được giữ lại.'));
    }, timeout);
    fqRankingState.pending.set(id, { resolve, reject, timer });
    worker.postMessage({ __wdFqBridge: FQ_RANK_CHANNEL, kind: 'request', id, action, payload }, FQ_RANK_ORIGIN);
  });
}

async function fqConnectRankings() {
  fqRankingState.worker = window.open(FQ_RANK_ORIGIN + '/search', 'fq-ranking-worker');
  if (!fqRankingState.worker) { fqRankEl('fq-ranking-info').textContent = 'Trình duyệt chặn popup; cho phép mở tab Fanqie rồi thử lại.'; return; }
  fqRankEl('fq-ranking-info').textContent = 'Đang chờ tab Fanqie tải bridge…';
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = await fqRankRequest('ping', {}, 2500);
      if (!result.capabilities?.includes('rank-list')) throw new Error('Cần cập nhật bridge v4.2.1.');
      fqRankEl('fq-ranking-info').textContent = `Đã kết nối bridge ${result.version}. Bấm “Lấy danh sách mới”.`;
      return;
    } catch (error) {
      if (attempt === 11 || error.message.includes('Cần cập nhật')) { fqRankEl('fq-ranking-info').textContent = error.message; return; }
    }
  }
}

async function initRankings() {
  if (fqRankingState.initialized) { renderRankings(); return; }
  fqRankingState.initialized = true;
  fqRankEl('fq-ranking-info').textContent = 'Đang tải snapshot bảng Fanqie…';
  try {
    const [categories, snapshot, read] = await Promise.all([
      fetch('data/ranking-categories.json').then(r => { if (!r.ok) throw new Error('Không tải được danh mục'); return r.json(); }),
      fetch('data/ranking-snapshot.json').then(r => { if (!r.ok) throw new Error('Không tải được snapshot'); return r.json(); }),
      ghRaw('data/read.json').catch(() => [])
    ]);
    fqRankingCategories = categories; fqRankingSnapshot = snapshot; fqRankingReadSet = new Set(read.map(String));
    fqRankingChanged(true);
  } catch (error) { fqRankingState.initialized = false; fqRankEl('fq-ranking-info').textContent = error.message; }
}

function fqRankingChanged(resetCategory = false) {
  fqRankingState.generation++;
  const type = fqRankEl('fq-ranking-type').value;
  const category = fqRankEl('fq-ranking-category');
  const rows = fqRankingCategories[fqRankEl('fq-ranking-gender').value === '0' ? 'female' : 'male'];
  if (resetCategory || !category.options.length) {
    category.replaceChildren(...rows.map(row => new Option(`${row.id} – ${CATEGORY_NAMES[row.id] || row.name}`, row.id)));
  }
  category.disabled = fqRankEl('fq-ranking-gender').disabled = !['reading', 'new'].includes(type);
  fqRankingState.books = []; fqRankingState.sections = []; fqRankingState.more = false; fqRankingState.next = 0; fqRankingState.version = '';
  fqRankEl('fq-ranking-sections').replaceChildren(); fqRankEl('fq-ranking-words').replaceChildren();
  booksPage.rankings = 1;
  if (fqRankingSnapshot?.[type]) {
    const snapshot = fqRankingSnapshot[type];
    fqRankingState.books = FqRankings.unique(snapshot.books);
    fqRankEl('fq-ranking-info').textContent = `${snapshot.title} · Snapshot ${fqRankingSnapshot.fetched_at} · ${fqRankingState.books.length} truyện. Kết nối Fanqie để làm mới.`;
  } else fqRankEl('fq-ranking-info').textContent = 'Kết nối tab Fanqie rồi bấm “Lấy danh sách mới”.';
  renderRankings();
}

async function fqFetchRankings(append) {
  if (fqRankingState.busy) return;
  if (append && !fqRankingState.more) return;
  const generation = fqRankingState.generation;
  const type = fqRankEl('fq-ranking-type').value;
  const offset = append ? fqRankingState.next : 0;
  fqRankingState.busy = true;
  fqRankEl('fq-ranking-info').textContent = 'Đang lấy dữ liệu trực tiếp từ Fanqie…';
  try {
    const result = await fqRankRequest(type === 'landing' ? 'search-landing' : 'rank-list', {
      type, offset, categoryId: fqRankEl('fq-ranking-category').value,
      gender: fqRankEl('fq-ranking-gender').value, rankVersion: append ? fqRankingState.version : ''
    });
    if (generation !== fqRankingState.generation) return;
    if (type === 'landing') {
      if (!Array.isArray(result.sections) || !result.sections.length) throw new Error('Trang tìm kiếm chưa trả danh sách; giữ dữ liệu cũ.');
      fqRankingState.sections = result.sections; fqRankingState.more = false; fqRankingState.section = 0;
      fqRankEl('fq-ranking-sections').replaceChildren(...result.sections.map((section, i) => {
        const button = document.createElement('button'); button.className = 'btn btn-outline btn-sm'; button.textContent = section.title;
        button.onclick = () => fqSelectRankingSection(i); return button;
      }));
      fqSelectRankingSection(0);
    } else {
      if (!Array.isArray(result.books)) throw new Error('Phản hồi thiếu danh sách; giữ dữ liệu cũ.');
      const incoming = FqRankings.unique(result.books, offset);
      const merged = append ? [...fqRankingState.books, ...incoming] : incoming;
      const seen = new Set();
      const previousCount = fqRankingState.books.length;
      fqRankingState.books = merged.filter(book => !seen.has(book.book_id) && seen.add(book.book_id));
      fqRankingState.more = Boolean(result.has_more) && Number(result.next_offset) > offset && incoming.length > 0 && (!append || fqRankingState.books.length > previousCount);
      fqRankingState.next = Number(result.next_offset) || offset + result.books.length;
      fqRankingState.version = result.rank_version || '';
      if (!append) booksPage.rankings = 1;
      fqRankEl('fq-ranking-info').textContent = `${result.title || type} · ${result.fetched_at} · đã tải ${fqRankingState.books.length}${result.total != null ? '/' + result.total : ''} truyện${result.unresolved ? ` · ${result.unresolved} truyện chưa lấy được tên gốc (□)` : ''}`;
      renderRankings();
    }
  } catch (error) {
    if (generation === fqRankingState.generation) fqRankEl('fq-ranking-info').textContent = error.message;
  } finally { fqRankingState.busy = false; }
}

function fqSelectRankingSection(index) {
  const section = fqRankingState.sections[index];
  if (!section) return;
  fqRankingState.section = index;
  fqRankingState.books = FqRankings.unique(section.books || []);
  booksPage.rankings = 1;
  fqRankEl('fq-ranking-info').textContent = `${section.title} · ${fqRankingState.books.length} truyện · danh sách rút gọn từ trang tìm kiếm`;
  fqRankEl('fq-ranking-words').replaceChildren(...(section.words || []).map(word => {
    const link = document.createElement('a'); link.className = 'btn btn-outline btn-sm'; link.textContent = word.word + (word.tag ? ' · ' + word.tag : '');
    link.href = FQ_RANK_ORIGIN + '/search/' + encodeURIComponent(word.word); link.target = '_blank'; link.rel = 'noopener'; return link;
  }));
  renderRankings();
}

function fqFilteredRankingBooks() {
  return filterByStatus(fqRankingState.books.filter(book => !fqRankingReadSet.has(book.book_id) && !automaticReadHidden.has(book.book_id)));
}
function renderRankings() {
  const root = fqRankEl('rankings-books');
  if (!root) return;
  const books = fqFilteredRankingBooks();
  registerBooks(books); unobserveScoresIn(root);
  const page = renderPagination('rankings', books.length);
  const visible = books.slice(page.start, page.end);
  root.innerHTML = visible.map(book => bookCardHTML(book, 'rankings', fqRankingReadSet)).join('') || '<div class="state-box">Chưa có truyện phù hợp trong danh sách này.</div>';
  loadScoresForCards(visible, root);
  fqRankEl('fq-ranking-more').style.display = fqRankingState.more ? '' : 'none';
  updateReadBar('rankings');
}
async function fqCopyRankings() {
  try { await navigator.clipboard.writeText(fqFilteredRankingBooks().map(book => book.book_id).join('\n')); toast('Đã copy ID trong danh sách đang hiển thị.', 'ok'); }
  catch (error) { toast(error.message, 'err'); }
}

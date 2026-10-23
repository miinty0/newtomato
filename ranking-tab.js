'use strict';
let fqRankingReadSet = new Set();
let fqRankingKeywords = [];
const fqRankingPendingOrigins = new Map();
const FQ_RANK_LAST_UPDATE_CUTOFF = 2024;
const FQ_RANK_PAGE_SIZE = 30;
const fqRankingState = { initialized: false, worker: null, pending: new Map(), books: [], entries: [], sections: [], section: 0, next: 0, more: false, version: '', session: '', generation: 0, busy: false, loaded: false, paused: false, signatures: new Set(), title: '', fetchedAt: '' };
const FQ_RANK_ORIGIN = 'https://fanqienovel.com';
const FQ_RANK_CHANNEL = 'wd-fq-bridge-v2';
let fqRankingCategories = { male: [], female: [] };
let fqRankingSnapshot = null;
const fqRankEl = id => document.getElementById(id);

const FQ_RANK_TITLES = { peak: 'Đỉnh cao trên web', editor: 'Đề cử nữ tần trên web', reading: 'Đang đọc trên web', new: 'Truyện mới trên web' };
const fqRankHasHan = value => /[\u3400-\u9fff]/.test(String(value || ''));
function fqRankSectionName(title, i = 0) {
  const names = { '猜你想搜': 'Gợi ý tìm kiếm', '番茄热搜榜': 'Tìm kiếm nổi bật trên Cà Chua', '巅峰榜': 'Bảng đỉnh cao', '漫画榜': 'Bảng truyện tranh', '推荐': 'Đề cử', '番茄热搜': 'Tìm kiếm nổi bật', '热搜': 'Tìm kiếm nổi bật' };
  return names[title] || (fqRankHasHan(title) ? 'Mục đề cử ' + (i + 1) : title);
}
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
      reject(new Error('Fanqie không phản hồi. Kiểm tra kết nối và đợi tab Fanqie tải xong; dữ liệu cũ được giữ lại.'));
    }, timeout);
    fqRankingState.pending.set(id, { resolve, reject, timer });
    worker.postMessage({ __wdFqBridge: FQ_RANK_CHANNEL, kind: 'request', id, action, payload }, FQ_RANK_ORIGIN);
  });
}

async function fqConnectRankings() {
  fqRankingState.worker = window.open(FQ_RANK_ORIGIN + '/search', 'fq-ranking-worker');
  if (!fqRankingState.worker) { fqRankEl('fq-ranking-info').textContent = 'Trình duyệt chặn popup; cho phép mở tab Fanqie rồi thử lại.'; return; }
  fqRankEl('fq-ranking-info').textContent = 'Đang chờ kết nối tab Fanqie…';
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = await fqRankRequest('ping', {}, 2500);
      if (!result.capabilities?.includes('rank-filter-meta')) throw new Error('Kết nối Fanqie chưa hỗ trợ chức năng cần thiết.');
      fqRankEl('fq-ranking-info').textContent = 'Đã kết nối Fanqie. Bấm “Lấy danh sách mới”.';
      return;
    } catch (error) {
      if (attempt === 11 || error.message.includes('Cần cập nhật')) { fqRankEl('fq-ranking-info').textContent = error.message; return; }
    }
  }
}

async function fqLoadRankingFilters() {
  const [read, keywords] = await Promise.all([
    ghRaw('data/read.json'),
    ghRaw('data/cleanup_abstract_keywords.json').catch(error => { if (/HTTP 404/.test(error.message)) return []; throw error; })
  ]);
  if (!Array.isArray(read) || !Array.isArray(keywords) || keywords.some(word => typeof word !== 'string')) throw new Error('Dữ liệu read/từ khóa dọn dẹp không hợp lệ');
  // Preserve in-flight local read updates while refreshing the data branch.
  fqRankingReadSet = new Set([...fqRankingReadSet, ...read.map(String)]);
  fqRankingKeywords = [...new Set(keywords.map(word => word.trim()).filter(Boolean))];
}
function fqRankVisibleCount() {
  return fqRankingState.entries.length || fqFilteredRankingBooks().length;
}
function fqRankRefillCurrentPage() {
  const target = (Number(booksPage.rankings) || 1) * FQ_RANK_PAGE_SIZE;
  if (!fqRankingState.loaded || !fqRankingState.more || fqRankingState.busy || fqRankingState.paused || fqRankVisibleCount() >= target) return;
  Promise.resolve().then(() => {
    if (!fqRankingState.busy && !fqRankingState.paused && fqRankingState.more && fqRankVisibleCount() < target) fqFetchRankings(true, target);
  });
}
// Successful live fetches are tracked per repository and Vietnam calendar day.
const fqRankingProgressMemory = new Map();
function fqRankingProgressDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function fqRankingProgressStorageKey() {
  const repo = typeof CFG === 'undefined' ? '' : CFG.user + '/' + CFG.repo;
  return 'fq_ranking_runs:' + repo;
}
function fqLoadRankingProgress() {
  const day = fqRankingProgressDay();
  const key = fqRankingProgressStorageKey();
  const memoryKey = key + ':' + day;
  let saved = {};
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (value?.day === day && value.runs && typeof value.runs === 'object') saved = value.runs;
  } catch (_) {}
  const runs = { ...saved, ...(fqRankingProgressMemory.get(memoryKey) || {}) };
  fqRankingProgressMemory.set(memoryKey, runs);
  return { day, runs };
}
function fqRankingScopeKey(scope) {
  return JSON.stringify([scope.type, scope.period || '', String(scope.gender ?? ''), String(scope.categoryId ?? ''), String(scope.subTab ?? '')]);
}
function fqRankingRunScope(type = fqRankEl('fq-ranking-type').value, overrides = {}) {
  const value = id => fqRankEl('fq-ranking-' + id)?.value || '';
  const gender = String(overrides.gender ?? value('gender'));
  if (type === 'app-200') {
    const selected = String(overrides.subTab ?? value('subtab'));
    const subTab = selected === 'auto' || !selected ? gender === '1' ? '5' : gender === '0' ? '4' : '1' : selected;
    return { type, period: 'special', gender: subTab === '5' ? '1' : subTab === '4' ? '0' : gender, subTab, categoryId: '0' };
  }
  if (type.startsWith('app-')) return { type, period: String((overrides.period ?? value('period')) || 'daily'), gender, categoryId: '0' };
  if (['reading', 'new'].includes(type)) return { type, period: 'web', gender, categoryId: String(overrides.categoryId ?? value('category')) };
  return { type };
}
function fqRankingScopeDone(scope, runs = fqLoadRankingProgress().runs) {
  return Boolean(runs[fqRankingScopeKey(scope)]);
}
function fqRankingStandardScope(type, period, gender) {
  if (type === 'app-200') return fqRankingRunScope(type, { gender, subTab: 'auto' });
  return { type, period, gender: String(gender), categoryId: '0' };
}
function fqRankingPeriodDone(type, period, runs = fqLoadRankingProgress().runs) {
  return ['2', '1', '0'].every(gender => fqRankingScopeDone(fqRankingStandardScope(type, period, gender), runs));
}
function fqRankingBoardDone(type, runs = fqLoadRankingProgress().runs) {
  if (type === 'app-200') return fqRankingPeriodDone(type, 'special', runs);
  if (type.startsWith('app-')) return ['daily', 'weekly', 'monthly'].every(period => fqRankingPeriodDone(type, period, runs));
  if (['reading', 'new'].includes(type)) {
    return ['0', '1'].every(gender => {
      const categories = fqRankingCategories[gender === '0' ? 'female' : 'male'] || [];
      return categories.length > 0 && categories.every(row => fqRankingScopeDone({ type, period: 'web', gender, categoryId: String(row.id) }, runs));
    });
  }
  return fqRankingScopeDone({ type }, runs);
}
function fqMarkRankingRun(scope, startedDay) {
  const progress = fqLoadRankingProgress();
  if (startedDay !== progress.day) return;
  progress.runs[fqRankingScopeKey(scope)] = new Date().toISOString();
  fqRankingProgressMemory.set(fqRankingProgressStorageKey() + ':' + progress.day, progress.runs);
  try { localStorage.setItem(fqRankingProgressStorageKey(), JSON.stringify(progress)); }
  catch (error) { console.warn('Không lưu được dấu đã chạy Bảng Fanqie:', error); }
  fqRenderRankingChecks();
}
function fqRankingCheckLabel(option, checked) {
  if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent.replace(/^✓\s*/, '');
  option.textContent = (checked ? '✓ ' : '') + option.dataset.baseLabel;
}
function fqRenderRankingChecks() {
  const typeSelect = fqRankEl('fq-ranking-type');
  if (!typeSelect?.options) return;
  const progress = fqLoadRankingProgress();
  const type = typeSelect.value;
  const current = fqRankingRunScope(type);
  for (const option of typeSelect.options) fqRankingCheckLabel(option, fqRankingBoardDone(option.value, progress.runs));
  const genderSelect = fqRankEl('fq-ranking-gender');
  for (const option of genderSelect.options || []) {
    const supported = type.startsWith('app-') || ['reading', 'new'].includes(type) && option.value !== '2';
    const scope = type === 'app-200'
      ? fqRankingStandardScope(type, 'special', option.value)
      : fqRankingRunScope(type, { gender: option.value });
    fqRankingCheckLabel(option, supported && fqRankingScopeDone(scope, progress.runs));
    option.disabled = ['reading', 'new'].includes(type) && option.value === '2';
  }
  for (const option of fqRankEl('fq-ranking-period')?.options || []) {
    fqRankingCheckLabel(option, type.startsWith('app-') && type !== 'app-200' && fqRankingPeriodDone(type, option.value, progress.runs));
  }
  for (const option of fqRankEl('fq-ranking-subtab')?.options || []) {
    const gender = ({ '1': '2', '4': '0', '5': '1' })[option.value] ?? current.gender;
    const scope = fqRankingRunScope('app-200', { subTab: option.value, gender });
    fqRankingCheckLabel(option, type === 'app-200' && fqRankingScopeDone(scope, progress.runs));
  }
  if (['reading', 'new'].includes(type)) for (const option of fqRankEl('fq-ranking-category')?.options || []) {
    fqRankingCheckLabel(option, fqRankingScopeDone(fqRankingRunScope(type, { categoryId: option.value }), progress.runs));
  }
  const info = fqRankEl('fq-ranking-run-checks');
  if (info) {
    const total = type === 'app-200' ? 3 : type.startsWith('app-') ? 9 : null;
    let completed = 0;
    if (total) for (const period of type === 'app-200' ? ['special'] : ['daily', 'weekly', 'monthly']) {
      for (const gender of ['2', '1', '0']) if (fqRankingScopeDone(fqRankingStandardScope(type, period, gender), progress.runs)) completed++;
    }
    info.textContent = '✓ Lấy dữ liệu thành công hôm nay (' + progress.day + ')' +
      (total ? ': ' + completed + '/' + total + ' lượt' : fqRankingScopeDone(current, progress.runs) ? ' · mục đang chọn đã chạy' : ' · mục đang chọn chưa chạy') +
      '. Chọn mục hoặc xem snapshot không tính là đã chạy.';
  }
}
function fqScheduleRankingCheckDayReset() {
  if (typeof setTimeout !== 'function') return;
  const now = Date.now(), dayMs = 86400000, offset = 7 * 3600000;
  const next = (Math.floor((now + offset) / dayMs) + 1) * dayMs - offset;
  const timer = setTimeout(() => { fqRenderRankingChecks(); fqScheduleRankingCheckDayReset(); }, Math.max(1000, next - now + 100));
  timer?.unref?.();
}
window.addEventListener('focus', () => fqRenderRankingChecks());
window.addEventListener('storage', event => { if (event.key === fqRankingProgressStorageKey()) fqRenderRankingChecks(); });
fqScheduleRankingCheckDayReset();

async function initRankings() {
  if (fqRankingState.initialized) { renderRankings(); return; }
  fqRankingState.initialized = true;
  fqRankEl('fq-ranking-info').textContent = 'Đang tải snapshot bảng Fanqie…';
  try {
    const [categories, snapshot] = await Promise.all([
      ghRaw('data/ranking-categories.json'),
      ghRaw('data/ranking-snapshot.json'),
      fqLoadRankingFilters()
    ]);
    fqRankingCategories = categories; fqRankingSnapshot = snapshot;
    fqRankingChanged(true);
  } catch (error) { fqRankingState.initialized = false; fqRankEl('fq-ranking-info').textContent = error.message; }
}

function fqRankingChanged(resetCategory = false) {
  fqRankingState.generation++;
  const type = fqRankEl('fq-ranking-type').value;
  const category = fqRankEl('fq-ranking-category');
  const rows = fqRankingCategories[fqRankEl('fq-ranking-gender').value === '0' ? 'female' : 'male'];
  if (resetCategory || !category.options.length) {
    category.replaceChildren(...rows.map(row => new Option(`${row.id} – ${fqRankHasHan(CATEGORY_NAMES[row.id] || row.name) ? "Thể loại " + row.id : CATEGORY_NAMES[row.id] || row.name}`, row.id)));
  }
  const isApp = type.startsWith('app-');
  if (type === 'app-200') {
    const subtab = fqRankEl('fq-ranking-subtab');
    if (resetCategory) subtab.value = 'auto';
    else if (['1', '4', '5'].includes(subtab.value)) fqRankEl('fq-ranking-gender').value = ({ '1': '2', '4': '0', '5': '1' })[subtab.value];
  }
  const usesCategory = ['reading', 'new'].includes(type);
  category.disabled = !usesCategory;
  category.hidden = !usesCategory;
  category.style.display = usesCategory ? '' : 'none';
  category.title = 'Thể loại chỉ áp dụng cho bảng Đang đọc/Truyện mới trên website';
  fqRankEl('fq-ranking-gender').disabled = !isApp && !['reading', 'new'].includes(type);
  if (!isApp && fqRankEl('fq-ranking-gender').value === '2') fqRankEl('fq-ranking-gender').value = '1';
  fqRankEl('fq-ranking-period').style.display = isApp && type !== 'app-200' ? '' : 'none';
  fqRankEl('fq-ranking-subtab').style.display = type === 'app-200' ? '' : 'none';
  fqRankingState.books = []; fqRankingState.entries = []; fqRankingState.sections = []; fqRankingState.more = false; fqRankingState.next = 0; fqRankingState.version = ''; fqRankingState.session = ''; fqRankingState.loaded = false; fqRankingState.paused = false; fqRankingState.signatures.clear();
  fqRankEl('fq-ranking-sections').replaceChildren(); fqRankEl('fq-ranking-words').replaceChildren();
  booksPage.rankings = 1;
  if (fqRankingSnapshot?.[type]) {
    const snapshot = fqRankingSnapshot[type];
    fqRankingState.books = FqRankings.unique(snapshot.books);
    fqRankEl('fq-ranking-info').textContent = `${FQ_RANK_TITLES[type] || fqRankSectionName(snapshot.title)} · Snapshot ${fqRankingSnapshot.fetched_at} · ${fqRankingState.books.length} truyện. Kết nối Fanqie để làm mới.`;
  } else fqRankEl('fq-ranking-info').textContent = 'Kết nối tab Fanqie rồi bấm “Lấy danh sách mới”.';
  fqRenderRankingChecks();
  renderRankings();
}

async function fqFetchRankings(append, targetOverride) {
  if (fqRankingState.busy || append && !fqRankingState.more) return;
  const generation = fqRankingState.generation;
  const runScope = fqRankingRunScope();
  const runDay = fqRankingProgressDay();
  const type = fqRankEl('fq-ranking-type').value;
  const beforeCount = fqRankVisibleCount();
  const target = targetOverride || (append ? (Math.floor(beforeCount / FQ_RANK_PAGE_SIZE) + 1) * FQ_RANK_PAGE_SIZE : FQ_RANK_PAGE_SIZE);
  fqRankingState.busy = true; fqRankingState.paused = false;
  fqRankEl('fq-ranking-info').textContent = 'Đang cập nhật read và từ khóa dọn dẹp…';
  let pages = 0, failure = '';
  try {
    await fqLoadRankingFilters();
    if (generation !== fqRankingState.generation) return;
    const isApp = type.startsWith('app-');
    const gender = Number(fqRankEl('fq-ranking-gender').value);
    const tab = fqRankEl('fq-ranking-subtab').value;
    const subTab = tab === 'auto' || !tab ? (gender === 1 ? 5 : gender === 0 ? 4 : 1) : Number(tab);
    let offset = append ? fqRankingState.next : 0;
    let continuation = append;
    let session = append ? fqRankingState.session : '';
    let version = append ? fqRankingState.version : '';
    const signatures = append ? fqRankingState.signatures : new Set();
    do {
      fqRankEl('fq-ranking-info').textContent = `Đang bù card sau lọc · offset ${offset} · ${fqRankVisibleCount()}/${target}`;
      const result = await fqRankRequest(isApp ? 'app-rank-list' : type === 'landing' ? 'search-landing' : 'rank-list', isApp ? {
        algoType: Number(type.slice(4)), offset, categoryId: 0,
        gender: type === 'app-200' && subTab === 5 ? 1 : type === 'app-200' && subTab === 4 ? 0 : gender,
        period: type === 'app-200' ? 'daily' : fqRankEl('fq-ranking-period').value || 'daily',
        ...(type === 'app-200' ? { subTab } : {}), sessionId: session,
        requireAbstract: fqRankingKeywords.length > 0
      } : { type, offset, categoryId: fqRankEl('fq-ranking-category').value,
        gender: fqRankEl('fq-ranking-gender').value, rankVersion: version, requireAbstract: fqRankingKeywords.length > 0 });
      if (generation !== fqRankingState.generation) return;
      pages++;
      if (type === 'landing') {
        if (!Array.isArray(result.sections) || !result.sections.length) throw new Error('Trang tìm kiếm chưa trả danh sách; giữ dữ liệu cũ.');
        fqRankingState.sections = result.sections; fqRankingState.more = false; fqRankingState.section = 0;
        fqRankEl('fq-ranking-sections').replaceChildren(...result.sections.map((section, i) => {
          const button = document.createElement('button'); button.className = 'btn btn-outline btn-sm'; button.textContent = fqRankSectionName(section.title, i);
          button.onclick = () => fqSelectRankingSection(i); return button;
        }));
        fqRankingState.loaded = true; fqSelectRankingSection(0); fqMarkRankingRun(runScope, runDay); return;
      }
      if (!Array.isArray(result.books)) throw new Error('Phản hồi thiếu danh sách; giữ dữ liệu cũ.');
      const entries = Array.isArray(result.entries) ? result.entries : [];
      const entryMode = entries.length > 0 || continuation && fqRankingState.entries.length > 0;
      const incoming = entryMode ? entries : FqRankings.unique(result.books, offset);
      const signature = (entryMode ? 'entries:' : 'books:') + incoming.map(row => row.id || row.book_id).join('|');
      if (incoming.length && signatures.has(signature)) {
        fqRankingState.more = false; failure = 'API lặp lại trang; đã dừng tải.'; break;
      }
      signatures.add(signature);
      const previous = continuation ? (entryMode ? fqRankingState.entries : fqRankingState.books) : [];
      const seen = new Set();
      const merged = [...previous, ...incoming].filter(row => { const id = row.id || row.book_id; return !seen.has(id) && seen.add(id); });
      if (entryMode) { fqRankingState.entries = merged; fqRankingState.books = []; }
      else { fqRankingState.books = merged; fqRankingState.entries = []; }
      const next = Number(result.next_offset);
      fqRankingState.more = Boolean(result.has_more) && Number.isFinite(next) && next > offset && incoming.length > 0;
      fqRankingState.next = Number.isFinite(next) ? next : offset;
      fqRankingState.session = session = result.session_id || session;
      fqRankingState.version = version = result.rank_version || version;
      fqRankingState.signatures = signatures;
      fqRankingState.loaded = true;
      fqRankingState.title = isApp ? result.title : FQ_RANK_TITLES[type] || fqRankSectionName(result.title) || type;
      fqRankingState.fetchedAt = result.fetched_at || '';
      if (!continuation) booksPage.rankings = 1;
      renderRankings();
      offset = fqRankingState.next; continuation = true;
    } while (fqRankVisibleCount() < target && fqRankingState.more && pages < 40);
    if (pages >= 40 && fqRankingState.more && fqRankVisibleCount() < target) {
      fqRankingState.paused = true; failure = 'Đã lấy 40 trang trong lượt này; bấm tải tiếp để tiếp tục.';
    }
    if (append && !targetOverride && beforeCount >= FQ_RANK_PAGE_SIZE && fqRankVisibleCount() > beforeCount) booksPage.rankings = Math.floor(beforeCount / FQ_RANK_PAGE_SIZE) + 1;
  } catch (error) { failure = error.message; fqRankingState.paused = true; }
  finally {
    fqRankingState.busy = false;
    if (generation === fqRankingState.generation) {
      if (pages > 0 && !failure && !fqRankingState.paused) fqMarkRankingRun(runScope, runDay);
      renderRankings();
      const count = fqRankVisibleCount();
      const pending = fqRankingKeywords.length ? fqRankingState.books.filter(book => !book.abstract_verified && !fqRankingReadSet.has(book.book_id)).length : 0;
      fqRankEl('fq-ranking-info').textContent = `${fqRankingState.title || 'Bảng Fanqie'} · ${count} mục sau lọc · 30 card/trang${!failure && !fqRankingState.more && count < target ? ' · nguồn đã hết hoặc không hỗ trợ tải tiếp' : ''}${pending ? ' · ' + pending + ' truyện thiếu tóm tắt, chưa hiển thị' : ''}${failure ? ' · ' + failure : ''}`;
    }
  }
}

function fqSelectRankingSection(index) {
  const section = fqRankingState.sections[index];
  if (!section) return;
  fqRankingState.section = index;
  fqRankingState.entries = [];
  fqRankingState.books = FqRankings.unique(section.books || []);
  booksPage.rankings = 1;
  fqRankEl('fq-ranking-info').textContent = `${fqRankSectionName(section.title, index)} · ${fqRankingState.books.length} truyện · danh sách rút gọn từ trang tìm kiếm`;
  fqRankEl('fq-ranking-words').replaceChildren(...(section.words || []).map(word => {
    const link = document.createElement('a'); link.className = 'btn btn-outline btn-sm'; link.textContent = word.word + (word.tag ? ' · ' + word.tag : '');
    link.href = FQ_RANK_ORIGIN + '/search/' + encodeURIComponent(word.word); link.target = '_blank'; link.rel = 'noopener'; return link;
  }));
  renderRankings();
}

function fqRankingBoardKey() {
  const value = id => fqRankEl('fq-ranking-' + id)?.value || '';
  const type = value('type');
  if (type === 'landing') return JSON.stringify([type, fqRankingState.section]);
  if (['reading', 'new'].includes(type)) return JSON.stringify([type, value('gender'), value('category')]);
  if (type.startsWith('app-')) return JSON.stringify([type, value('gender'), type === 'app-200' ? value('subtab') : value('period')]);
  return JSON.stringify([type]);
}
function fqSetPendingReadOrigin(bookId, tab, marked) {
  if (tab !== 'rankings') return;
  const id = String(bookId);
  if (marked) fqRankingPendingOrigins.set(id, fqRankingBoardKey());
  else fqRankingPendingOrigins.delete(id);
}
function fqRankPendingReadHidden(bookId) {
  if (typeof pendingRead === 'undefined') return false;
  const id = String(bookId);
  for (const [tab, ids] of Object.entries(pendingRead)) {
    if (!ids.has(id)) continue;
    if (tab !== 'rankings' || fqRankingPendingOrigins.get(id) !== fqRankingBoardKey()) return true;
  }
  return false;
}
function fqRankingBookAllowed(book) {
  const id = String(book.book_id);
  return !fqRankingReadSet.has(id) && !automaticReadHidden.has(id) && !fqRankPendingReadHidden(id) &&
    !FqRankings.cleanupReason(book, fqRankingKeywords, FQ_RANK_LAST_UPDATE_CUTOFF) &&
    (!fqRankingKeywords.length || book.abstract_verified);
}
function fqFilteredRankingBooks() {
  return filterByStatus(fqRankingState.books.filter(fqRankingBookAllowed));
}
function renderRankings() {
  fqRenderRankingChecks();
  const root = fqRankEl('rankings-books');
  if (!root) return;
  if (fqRankingState.entries.length) {
    unobserveScoresIn(root);
    const page = renderPagination('rankings', fqRankingState.entries.length);
    const esc = value => String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    root.innerHTML = fqRankingState.entries.slice(page.start, page.end).map((entry, i) => {
      const cover = /^https:\/\//.test(entry.cover_url) ? `<img class="book-thumb" src="${esc(entry.cover_url)}" alt="" loading="lazy">` : '';
      const label = { author: 'Tác giả', video: 'Phát sóng', hotword: 'Từ khóa' }[entry.kind] || 'Nội dung';
      return `<div class="book-card">${cover}<div class="book-rank">#${page.start + i + 1} · ${label}</div><a class="book-title" href="${FQ_RANK_ORIGIN}/search/${encodeURIComponent(entry.query)}" target="_blank" rel="noopener">${esc(entry.title)}</a><div>${esc(entry.detail)}</div></div>`;
    }).join('');
    fqRankEl('fq-ranking-more').style.display = fqRankingState.more ? '' : 'none';
    fqRankEl('rankings-read-bar').style.display = 'none';
    fqRankRefillCurrentPage();
    return;
  }
  const books = fqFilteredRankingBooks();
  registerBooks(books); unobserveScoresIn(root);
  const page = renderPagination('rankings', books.length);
  const visible = books.slice(page.start, page.end);
  root.innerHTML = visible.map(book => bookCardHTML(book, 'rankings', fqRankingReadSet)).join('') || '<div class="state-box">Chưa có truyện phù hợp trong danh sách này.</div>';
  loadScoresForCards(visible, root);
  fqRankEl('fq-ranking-more').style.display = fqRankingState.more ? '' : 'none';
  updateReadBar('rankings');
  fqRankRefillCurrentPage();
}
async function fqCopyRankings() {
  if (fqRankingState.entries.length) { toast('Bảng này không có ID truyện để copy.', 'err'); return; }
  try { await navigator.clipboard.writeText(fqFilteredRankingBooks().filter(book => typeof pendingRead === 'undefined' || !Object.values(pendingRead).some(ids => ids.has(String(book.book_id)))).map(book => book.book_id).join('\n')); toast('Đã copy ID trong danh sách đang hiển thị.', 'ok'); }
  catch (error) { toast(error.message, 'err'); }
}

async function fqDiagnoseRankingCategory(categoryId = 24, algoType = 135) {
  categoryId = Number(categoryId);
  algoType = Number(algoType);
  if (!Number.isInteger(categoryId) || categoryId < 1 || categoryId > 10000) throw new Error('Category ID phải từ 1 đến 10000');
  if (![135, 116].includes(algoType)) throw new Error('Lệnh này dùng cho bảng theo thể loại 135 hoặc 116');
  const gender = Number(fqRankEl('fq-ranking-gender').value);
  const period = fqRankEl('fq-ranking-period').value || 'daily';
  const results = [];
  for (const category of [0, categoryId]) {
    try {
      const result = await fqRankRequest('app-rank-probe', { algoType, categoryId: category, gender, period, offset: 0 });
      const data = result.raw?.data || {};
      const view = data.cell_view || {};
      const books = new Map();
      function walk(cell) {
        if (!cell || typeof cell !== 'object') return;
        for (const book of cell.book_data || []) {
          const id = String(book.book_id ?? book.bookId ?? '');
          if (id && !books.has(id)) books.set(id, { id, category: book.category ?? book.category_id ?? null });
        }
        for (const child of cell.cell_data || []) walk(child);
      }
      walk(view);
      const hints = [];
      function scan(value, path = 'data', depth = 0) {
        if (!value || typeof value !== 'object' || depth > 5 || hints.length >= 50) return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'book_data') continue;
          if (/category|genre|rank_sub|filter|tab/i.test(key) && child != null && ['string', 'number', 'boolean'].includes(typeof child)) {
            hints.push({ path: path + '.' + key, value: String(child).slice(0, 200) });
          }
          if (child && typeof child === 'object') scan(child, path + '.' + key, depth + 1);
          if (hints.length >= 50) break;
        }
      }
      scan(data);
      const params = Object.fromEntries(['algo_type', 'category_id', 'rank_sub_info_id', 'rank_sub_info_type', 'genre_type', 'list_type', 'gender_list_type']
        .map(key => [key, result.params?.[key] ?? null]));
      results.push({
        requestedCategory: category, ok: result.ok, error: result.error || null, params,
        returnedAlgo: view.algo ?? null, firstPageBookCount: books.size,
        firstBooks: [...books.values()].slice(0, 15), nextOffset: data.next_offset ?? null,
        hasMore: data.has_more ?? null, viewKeys: Object.keys(view),
        cells: (result.cells || []).slice(0, 30).map(cell => ({ path: cell.path, title: cell.title, books: cell.books, keys: cell.keys })),
        metadataHints: hints,
      });
    } catch (error) { results.push({ requestedCategory: category, ok: false, error: error.message }); }
  }
  const ids = result => (result.firstBooks || []).map(book => book.id);
  const first = ids(results[0]), second = ids(results[1]);
  const report = {
    algoType, gender, period, comparison: {
      sameFirstPageIds: first.length > 0 && first.length === second.length && first.every((id, i) => id === second[i]),
      overlappingSampleIds: first.filter(id => second.includes(id)).length,
    }, results,
  };
  window.fqLastCategoryDiagnostic = report;
  console.log('FQ_CATEGORY_DIAGNOSTIC\n' + JSON.stringify(report, null, 2));
  return report;
}
window.fqDiagnoseRankingCategory = fqDiagnoseRankingCategory;

// Home action: remove selected IDs from read.json without deleting book data.
let homeUnreadSaving = false;
function parseHomeUnreadIds(value) {
  const tokens = String(value || '').split(/[|,\s]+/).filter(Boolean);
  return {
    ids: [...new Set(tokens.filter(id => /^\d{15,20}$/.test(id)))],
    invalid: tokens.filter(id => !/^\d{15,20}$/.test(id)),
  };
}
function updateHomeUnreadPreview() {
  const input = document.getElementById('home-unread-ids');
  const preview = document.getElementById('home-unread-preview');
  const button = document.getElementById('home-unread-save');
  const { ids, invalid } = parseHomeUnreadIds(input.value);
  preview.classList.toggle('invalid', invalid.length > 0);
  preview.textContent = invalid.length
    ? `Có ${invalid.length} giá trị không phải fanqie_id: ${invalid.slice(0, 3).join(', ')}`
    : ids.length ? `${ids.length} ID duy nhất cần xoá khỏi read.json.` : 'Dán ID cần xoá khỏi read.json.';
  button.disabled = homeUnreadSaving || !ids.length || invalid.length > 0;
}
async function removeReadIds(ids) {
  const selected = new Set([...ids].map(String));
  const write = async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const meta = await ghGetFile('data/read.json');
      const current = JSON.parse(b64DecodeUTF8(meta.content));
      if (!Array.isArray(current)) throw new Error('read.json không phải danh sách ID');
      const remaining = current.filter(id => !selected.has(String(id)));
      const removedIds = new Set(current.filter(id => selected.has(String(id))).map(String));
      if (!removedIds.size) return { removed: 0, absent: selected.size };
      try {
        await ghPutFile('data/read.json', JSON.stringify(remaining, null, 2), 'remove pasted book IDs from read list', meta.sha);
        return { removed: removedIds.size, absent: selected.size - removedIds.size };
      } catch (error) {
        if (!isStatusShaConflict(error) || attempt === 5) throw error;
        await statusSyncDelay(attempt);
      }
    }
  };
  if (navigator.locks?.request) {
    return navigator.locks.request('fq-read:' + CFG.user + '/' + CFG.repo, { mode: 'exclusive' }, write);
  }
  return write();
}
function applyUnreadIdsLocally(ids) {
  for (const id of ids) {
    dailyReadSet.delete(id);
    rcReadSet.delete(id);
    specialReadSet.delete(id);
    if (typeof fqRankingReadSet !== 'undefined') fqRankingReadSet.delete(id);
    for (const entry of [...Object.values(catData), ...Object.values(rcData)]) entry.readSet.delete(id);
    automaticReadQueue.delete(id);
    copiedReadQueued.delete(id);
    automaticReadHidden.delete(id);
    // Do not immediately auto-add a manually removed ID again in this session.
    automaticReadSaved.add(id);
    for (const [tab, pending] of Object.entries(pendingRead)) {
      pending.delete(id);
      updateReadBar(tab);
    }
  }
  if (dailyLoaded) renderDaily();
  if (Object.keys(catData).length) renderCatPanels();
  if (Object.keys(rcData).length) renderRcPanels();
  if (specialLoaded) renderSpecial();
  if (typeof fqRankingState !== 'undefined' && fqRankingState.initialized) renderRankings();
}
async function saveHomeUnreadIds() {
  if (homeUnreadSaving) return;
  const input = document.getElementById('home-unread-ids');
  const preview = document.getElementById('home-unread-preview');
  const button = document.getElementById('home-unread-save');
  const { ids, invalid } = parseHomeUnreadIds(input.value);
  if (!ids.length || invalid.length) { updateHomeUnreadPreview(); return; }
  if (homeReadSaving) { toast('Đang lưu danh sách đã đọc; hãy chờ hoàn tất rồi xoá ID.', ''); return; }
  homeUnreadSaving = true;
  input.disabled = true;
  button.disabled = true;
  button.textContent = '⏳ Đang xoá…';
  try {
    // Finish an in-flight automatic write before removing IDs from GitHub.
    if (automaticReadActive) await automaticReadActive.catch(() => {});
    const result = await removeReadIds(ids);
    applyUnreadIdsLocally(ids);
    input.value = '';
    const message = `Đã xoá ${result.removed} ID khỏi read.json; ${result.absent} ID không có trong danh sách.`;
    toast(message, 'ok');
    preview.textContent = message;
  } catch (error) {
    preview.textContent = 'Không xoá được ID: ' + error.message;
    toast(preview.textContent, 'err');
  } finally {
    homeUnreadSaving = false;
    input.disabled = false;
    button.textContent = 'Xoá khỏi read.json';
    button.disabled = !input.value.trim();
  }
}

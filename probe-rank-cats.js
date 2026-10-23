const https = require('https');
const fs = require('fs');
const path = require('path');

function knownRankIds(config) {
  return new Set([...(config.rankMold2 || []), ...(config.rankMold1 || [])].map(e => Number(e.cat_id)));
}
function candidateIds(categories, config, { missingOnly = true, start = 1, end = Infinity } = {}) {
  const known = knownRankIds(config);
  return [...new Set(categories.map(e => Number(e.id)))]
    .filter(id => Number.isSafeInteger(id) && id >= start && id <= end && (!missingOnly || !known.has(id)))
    .sort((a, b) => a - b);
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 15000,
    }, response => {
      response.setEncoding('utf8');
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode, data }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
function classifyRankResponse(response) {
  if (response.status !== 200) throw new Error('HTTP ' + response.status);
  if (!response.data || !response.data.trim()) {
    const error = new Error('HTTP 200 but response body is empty');
    error.code = 'EMPTY_RESPONSE_BODY';
    throw error;
  }
  let json;
  try { json = JSON.parse(response.data); }
  catch (error) {
    const match = response.data.match(/(?:^|[,{]\s*)"book_id"\s*:\s*(?:"([1-9]\d*)"|([1-9]\d*)(?=\s*[,}\]]))/);
    if (match) return { hasBooks: true, recoveredFromInvalidJson: true };
    throw new Error('Invalid JSON without a complete book_id');
  }
  if (json?.code !== 0) throw new Error('API code=' + String(json?.code));
  const data = json?.data;
  if (Array.isArray(data?.book_list) && data.book_list.some(book => /^[1-9]\d*$/.test(String(book?.book_id)))) return { hasBooks: true };
  if (data?.total_num != null && data.total_num !== '' && Number.isFinite(Number(data.total_num)) && Number(data.total_num) >= 0) {
    return { hasBooks: Number(data.total_num) > 0 };
  }
  throw new Error('Response has no usable book_id or total_num');
}
function mergeRankEntries(oldList, newList) {
  const byId = new Map((oldList || []).map(entry => [Number(entry.cat_id), entry]));
  for (const entry of newList) if (!byId.has(Number(entry.cat_id))) byId.set(Number(entry.cat_id), entry);
  return [...byId.values()].sort((a, b) => Number(a.cat_id) - Number(b.cat_id));
}
async function probeRankCats(categories, existing, {
  missingOnly = true, start = 1, end = Infinity,
  request = httpGet, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log, checkpoint = () => {},
} = {}) {
  const ids = candidateIds(categories, existing, { missingOnly, start, end });
  const additions = { rankMold2: [], rankMold1: [] };
  const report = {
    candidate_ids: ids, excluded_known: missingOnly ? candidateIds(categories, existing, { missingOnly: false, start, end }).length - ids.length : 0,
    checked_ids: [], newly_valid_ids: [], no_rank_ids: [], unresolved: [],
    stop_reason: null, resume_start: null, api_requests: 0,
  };
  let streak = 0, streakStart = null;
  log('Rankcat: ' + ids.length + ' candidates; ' + report.excluded_known + ' already valid IDs excluded.');
  function snapshot() {
    return {
      ...existing,
      // The old cursor sliced the catalogue and could miss new lower IDs.
      last_probed_cat_id: undefined,
      updated_at: new Date().toISOString(),
      rankMold2: mergeRankEntries(existing.rankMold2, additions.rankMold2),
      rankMold1: mergeRankEntries(existing.rankMold1, additions.rankMold1),
    };
  }
  outer: for (const id of ids) {
    let hasAny = false, failed = false;
    for (const mold of [2, 1]) {
      const key = 'rankMold' + mold;
      // Preserve known per-mold settings even in an explicitly requested full scan.
      if ((existing[key] || []).some(entry => Number(entry.cat_id) === id)) {
        hasAny = true;
        continue;
      }
      for (const gender of [0, 1]) {
        const url = 'https://fanqienovel.com/api/rank/category/list?app_id=2503&rank_list_type=3&offset=0&limit=1&category_id=' + id + '&rank_version=&gender=' + gender + '&rankMold=' + mold;
        try {
          report.api_requests++;
          const result = classifyRankResponse(await request(url));
          streak = 0;
          streakStart = null;
          log('cat ' + id + ' mold=' + mold + ' gender=' + gender + ': ' + (result.hasBooks ? 'has rank books' : 'total_num=0'));
          if (result.hasBooks) {
            additions[key].push(gender === 0 ? { cat_id: id } : { cat_id: id, gender });
            hasAny = true;
            if (!report.newly_valid_ids.includes(id) && !knownRankIds(existing).has(id)) report.newly_valid_ids.push(id);
            // Save successful discoveries immediately, including partial categories.
            checkpoint(snapshot(), report);
            await sleep(400);
            break;
          }
        } catch (error) {
          failed = true;
          report.unresolved.push({ id, rankMold: mold, gender, reason: error.message });
          log('cat ' + id + ' mold=' + mold + ' gender=' + gender + ': UNRESOLVED — ' + error.message);
          if (error.code === 'EMPTY_RESPONSE_BODY') {
            if (!streak) streakStart = id;
            streak++;
            if (streak >= 3) {
              report.stop_reason = 'empty_body_streak';
              report.resume_start = streakStart;
              checkpoint(snapshot(), report);
              log('Stopped after 3 consecutive empty API bodies; saved results; resume from category ' + streakStart);
              break outer;
            }
          } else {
            streak = 0;
            streakStart = null;
          }
        }
        await sleep(400);
      }
    }
    report.checked_ids.push(id);
    if (!hasAny && !failed) report.no_rank_ids.push(id);
    checkpoint(snapshot(), report);
    await sleep(600);
  }
  const config = snapshot();
  checkpoint(config, report);
  return { config, report };
}
function readConfig(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value.rankMold2) || !Array.isArray(value.rankMold1)) throw new Error('Invalid valid_rank_cats.json; refusing to replace it');
  return value;
}
async function main() {
  const dataDir = process.env.RANKCAT_DATA_DIR || path.join(__dirname, 'data');
  const categories = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories_1-2000.json'), 'utf8'));
  if (!Array.isArray(categories) || !categories.length) throw new Error('Category catalogue is empty or invalid');
  const configPath = path.join(dataDir, 'valid_rank_cats.json');
  const existing = readConfig(configPath);
  const start = Number(process.env.PROBE_START || 1);
  const end = process.env.PROBE_END ? Number(process.env.PROBE_END) : Infinity;
  if (!Number.isSafeInteger(start) || start < 1 || !(end === Infinity || Number.isSafeInteger(end)) || end < start) throw new Error('Invalid range');
  const missingOnly = process.env.PROBE_MISSING_ONLY !== 'false';
  const reportPath = path.join(dataDir, 'rankcat-probe-report.json');
  function checkpoint(config, report) {
    for (const [file, value] of [[configPath, config], [reportPath, report]]) {
      fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
      fs.renameSync(file + '.tmp', file);
    }
  }
  const { report } = await probeRankCats(categories, existing, { start, end, missingOnly, checkpoint });
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n### Rankcat discovery\n' +
      '- Already valid IDs excluded: ' + report.excluded_known + '\n' +
      '- Candidates: ' + report.candidate_ids.length + '; checked: ' + report.checked_ids.length + '\n' +
      '- Newly valid: ' + (report.newly_valid_ids.join(', ') || 'none') + '\n' +
      '- Unresolved requests: ' + report.unresolved.length + '\n' +
      (report.stop_reason ? '- Paused after 3 empty API bodies; resume from **' + report.resume_start + '**.\n' : '- Finished candidate list.\n'));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { knownRankIds, candidateIds, classifyRankResponse, probeRankCats };

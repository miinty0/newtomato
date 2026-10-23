const https = require('https');
const fs = require('fs');
const path = require('path');

function knownRankIds(config) {
  return new Set([...(config.rankMold2 || []), ...(config.rankMold1 || [])].map(e => Number(e.cat_id)));
}
function candidateIds(categories, config, { missingOnly = false, start = 1, end = Infinity } = {}) {
  const known = knownRankIds(config);
  const ids = categories.map(e => Number(e.id));
  if (!missingOnly) ids.push(...known);
  return [...new Set(ids)]
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
  if (response.status !== 200) {
    const error = new Error('HTTP ' + response.status);
    if (response.status === 403 || response.status === 429) error.code = 'RATE_LIMITED';
    throw error;
  }
  if (!response.data || !response.data.trim()) {
    const error = new Error('HTTP 200 but response body is empty');
    error.code = 'EMPTY_RESPONSE_BODY';
    throw error;
  }
  let json;
  try { json = JSON.parse(response.data); }
  catch (error) {
    // Recover only complete fields. A trailing bare number may be truncated,
    // so it must have a delimiter; a quoted number must have a closing quote.
    const code = response.data.match(/(?:^|[,{]\s*)"code"\s*:\s*(-?\d+)(?=\s*[,}\]])/);
    if (code && Number(code[1]) !== 0) throw new Error('API code=' + code[1]);
    const total = response.data.match(/(?:^|[,{]\s*)"total_num"\s*:\s*(?:"(0|[1-9]\d*)"|(0|[1-9]\d*)(?=\s*[,}\]]))/);
    if (total) {
      const totalNum = Number(total[1] ?? total[2]);
      if (Number.isSafeInteger(totalNum)) {
        return { hasBooks: totalNum > 0, totalNum, recoveredFromInvalidJson: true };
      }
    }
    const match = response.data.match(/(?:^|[,{]\s*)"(?:book_id|bookId)"\s*:\s*(?:"([1-9]\d*)"|([1-9]\d*)(?=\s*[,}\]]))/);
    if (match) return { hasBooks: true, totalNum: null, recoveredFromInvalidJson: true };
    throw new Error('Invalid JSON without a complete total_num or book_id/bookId');
  }
  if (json?.code !== 0) throw new Error('API code=' + String(json?.code));
  const data = json?.data;
  // A valid total_num is authoritative, including an explicit zero.
  if ((typeof data?.total_num === 'number' || typeof data?.total_num === 'string') &&
      String(data.total_num).trim() !== '' && Number.isSafeInteger(Number(data.total_num)) && Number(data.total_num) >= 0) {
    return { hasBooks: Number(data.total_num) > 0, totalNum: Number(data.total_num) };
  }
  if (Array.isArray(data?.book_list) && data.book_list.some(book => /^[1-9]\d*$/.test(String(book?.book_id ?? book?.bookId)))) {
    return { hasBooks: true, totalNum: null };
  }
  throw new Error('Response has no usable total_num or book_id/bookId');
}

async function probeRankCats(categories, existing, {
  missingOnly = false, start = 1, end = Infinity,
  request = httpGet, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log, checkpoint = () => {},
} = {}) {
  const ids = candidateIds(categories, existing, { missingOnly, start, end });
  const known = knownRankIds(existing);
  const maps = Object.fromEntries([2, 1].map(mold => [
    'rankMold' + mold, new Map((existing['rankMold' + mold] || []).map(entry => [Number(entry.cat_id), { ...entry }])),
  ]));
  const report = {
    mode: missingOnly ? 'missing_only' : 'revalidate_all',
    candidate_ids: ids, excluded_known: missingOnly ? candidateIds(categories, existing, { missingOnly: false, start, end }).length - ids.length : 0,
    checked_ids: [], newly_valid_ids: [], no_rank_ids: [], unresolved: [],
    checks: [], changes: [], stop_reason: null, resume_start: null, api_requests: 0,
  };
  let streak = 0, streakStart = null;
  log('Rankcat: mode=' + report.mode + '; ' + ids.length + ' candidates; ' + report.excluded_known + ' already valid IDs excluded.');
  function snapshot() {
    return {
      ...existing, last_probed_cat_id: undefined, updated_at: new Date().toISOString(),
      rankMold2: [...maps.rankMold2.values()].sort((a, b) => Number(a.cat_id) - Number(b.cat_id)),
      rankMold1: [...maps.rankMold1.values()].sort((a, b) => Number(a.cat_id) - Number(b.cat_id)),
    };
  }
  function applyMold(id, mold, results) {
    const key = 'rankMold' + mold;
    const old = maps[key].get(id);
    const positives = [...results.entries()].filter(([, result]) => result?.hasBooks).map(([gender]) => gender);
    if (positives.length) {
      // Prefer gender 0 whenever it has rank books, even if the old entry used 1.
      const oldGender = Number(old?.gender ?? 0);
      const gender = positives.includes(0) ? 0 : 1;
      const entry = { ...old, cat_id: id };
      if (gender === 1) entry.gender = 1;
      else delete entry.gender;
      maps[key].set(id, entry);
      if (!old || oldGender !== gender) {
        report.changes.push({ id, rankMold: mold, previous_gender: old ? oldGender : null, gender, action: old ? 'correct_gender' : 'add' });
      }
      if (!known.has(id) && !report.newly_valid_ids.includes(id)) report.newly_valid_ids.push(id);
    } else if (results.size === 2 && results.get(0) && results.get(1)) {
      // Remove an old Mold only when BOTH genders were successfully confirmed zero.
      if (old) {
        maps[key].delete(id);
        report.changes.push({ id, rankMold: mold, action: 'remove_confirmed_empty' });
      }
    }
    checkpoint(snapshot(), report);
  }
  outer: for (const id of ids) {
    let failed = false;
    for (const mold of [2, 1]) {
      const results = new Map();
      for (const gender of [0, 1]) {
        // Gender 1 is a fallback only for a confirmed total_num=0 at gender 0.
        // Errors, empty bodies and unknown totals are never treated as zero.
        if (gender === 1 && results.get(0)?.totalNum !== 0) break;
        const url = 'https://fanqienovel.com/api/rank/category/list?app_id=2503&rank_list_type=3&offset=0&limit=1&category_id=' + id + '&rank_version=&gender=' + gender + '&rankMold=' + mold;
        try {
          report.api_requests++;
          const result = classifyRankResponse(await request(url));
          results.set(gender, result);
          report.checks.push({ id, rankMold: mold, gender, total_num: result.totalNum, has_books: result.hasBooks, recovered_from_invalid_json: !!result.recoveredFromInvalidJson });
          streak = 0;
          streakStart = null;
          log('cat ' + id + ' mold=' + mold + ' gender=' + gender + ': total_num=' + (result.totalNum ?? 'unknown') + '; ' + (result.hasBooks ? 'has rank books' : 'confirmed zero'));
        } catch (error) {
          failed = true;
          results.set(gender, null);
          report.unresolved.push({ id, rankMold: mold, gender, reason: error.message });
          log('cat ' + id + ' mold=' + mold + ' gender=' + gender + ': UNRESOLVED — ' + error.message);
          if (error.code === 'RATE_LIMITED') {
            report.stop_reason = 'rate_limited';
            report.resume_start = id;
            applyMold(id, mold, results);
            log('Rate limit/block response; saved results; resume from category ' + id + ' after cooldown.');
            break outer;
          }
          if (error.code === 'EMPTY_RESPONSE_BODY') {
            if (!streak) streakStart = id;
            streak++;
            if (streak >= 3) {
              report.stop_reason = 'empty_body_streak';
              report.resume_start = streakStart;
              applyMold(id, mold, results);
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
      applyMold(id, mold, results);
    }
    report.checked_ids.push(id);
    if (!failed && !maps.rankMold2.has(id) && !maps.rankMold1.has(id)) report.no_rank_ids.push(id);
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
  const missingOnly = process.env.PROBE_MISSING_ONLY === 'true';
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
      '- Mode: ' + report.mode + '\n' +
      '- Gender/configuration changes: ' + report.changes.length + '\n' +
      '- Already valid IDs excluded: ' + report.excluded_known + '\n' +
      '- Candidates: ' + report.candidate_ids.length + '; checked: ' + report.checked_ids.length + '\n' +
      '- Newly valid: ' + (report.newly_valid_ids.join(', ') || 'none') + '\n' +
      '- Unresolved requests: ' + report.unresolved.length + '\n' +
      (report.stop_reason ? '- Paused (' + report.stop_reason + '); resume from **' + report.resume_start + '**.\n' : '- Finished candidate list.\n'));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { knownRankIds, candidateIds, classifyRankResponse, probeRankCats };

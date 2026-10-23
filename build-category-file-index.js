const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mirrors the Git blob SHA returned by the GitHub tree API.
function blobSha(bytes) {
  return crypto.createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
}

function buildCategoryFileIndex(dataDir) {
  const index = { version: 1, category: {}, rankcat: {} };
  for (const file of fs.readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile()) continue;
    const match = /^(category|rank_cat)_(\d+)\.json$/.exec(file.name);
    if (!match) continue;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid category ID: ' + file.name);
    const bytes = fs.readFileSync(path.join(dataDir, file.name));
    const data = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid category file: ' + file.name);
    index[match[1] === 'category' ? 'category' : 'rankcat'][id] = {
      update_time: data.update_time || null,
      sha: blobSha(bytes),
    };
  }
  const output = path.join(dataDir, 'category-file-index.json');
  const content = JSON.stringify(index) + '\n';
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== content) {
    fs.writeFileSync(output + '.tmp', content);
    fs.renameSync(output + '.tmp', output);
  }
  return index;
}

if (require.main === module) {
  const dataDir = path.resolve(process.argv[2] || path.join(__dirname, 'data'));
  const index = buildCategoryFileIndex(dataDir);
  console.log('Category file index: ' + Object.keys(index.category).length + ' categories, ' + Object.keys(index.rankcat).length + ' rank categories');
}
module.exports = { buildCategoryFileIndex, blobSha };

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(process.argv[2] || '.');

// Các thư mục/tên nên bỏ qua khi duyệt
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function normalizeThumbUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const match = url.match(/novel-pic\/([^~?]+)/);
  if (!match) return url; // không đúng định dạng fanqienovel → giữ nguyên
  const normalized = `https://p6-novel.byteimg.com/thumb/novel-pic/${match[1]}`;
  return normalized;
}
function walkAndFix(node) {
  let changed = 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      changed += walkAndFix(item);
    }
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (key === 'thumb_url' && typeof val === 'string') {
        const fixed = normalizeThumbUrl(val);
        if (fixed !== val) {
          node[key] = fixed;
          changed++;
        }
      } else if (val && typeof val === 'object') {
        changed += walkAndFix(val);
      }
    }
  }
  return changed;
}

function listJsonFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  console.log(`Scanning: ${ROOT_DIR}`);
  const files = listJsonFiles(ROOT_DIR);
  console.log(`Found ${files.length} .json files`);

  let filesChanged = 0;
  let urlsChanged = 0;
  let filesFailed = 0;

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      console.log(`  ! read failed: ${file} (${e.message})`);
      filesFailed++;
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`  ! invalid JSON, skipped: ${file} (${e.message})`);
      filesFailed++;
      continue;
    }

    const changed = walkAndFix(data);
    if (changed > 0) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      console.log(`  ✓ ${path.relative(ROOT_DIR, file)} — fixed ${changed} thumb_url`);
      filesChanged++;
      urlsChanged += changed;
    }
  }

  console.log('='.repeat(50));
  console.log(`Done. Files scanned: ${files.length}`);
  console.log(`Files changed:       ${filesChanged}`);
  console.log(`thumb_url fixed:     ${urlsChanged}`);
  if (filesFailed > 0) console.log(`Files failed to read/parse: ${filesFailed}`);
}

main();

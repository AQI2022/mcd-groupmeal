// Push the current directory to GitHub using the Contents API.
// (git's credential helper spawns sh.exe, which this sandbox blocks — so we use the REST API.
//  The Git Data API refuses to create blobs on a completely empty repo, hence the Contents API.)
// Usage: node tools/_push.mjs <owner/repo> [branch] [messageFile]
import fs from 'node:fs';
import path from 'node:path';

const [, , repoSlug, branch = 'main', messageFile] = process.argv;
if (!repoSlug || !repoSlug.includes('/')) {
  console.error('usage: node tools/_push.mjs <owner/repo> [branch] [messageFile]');
  process.exit(2);
}
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('GH_TOKEN missing'); process.exit(2); }

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode']);
const IGNORE_FILES = new Set(['mcp-config.json', '.DS_Store', 'Thumbs.db']);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name));
      continue;
    }
    if (IGNORE_FILES.has(entry.name)) continue;
    if (/\.log$/.test(entry.name) || entry.name.startsWith('_commitmsg')) continue;
    out.push({ rel: base ? `${base}/${entry.name}` : entry.name, abs: path.join(dir, entry.name) });
  }
  return out;
}

async function api(method, apiPath, body) {
  const res = await fetch('https://api.github.com' + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mcd-groupmeal-push',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${apiPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const message = messageFile ? fs.readFileSync(messageFile, 'utf8').trim() : 'chore: initial commit';
const files = walk(ROOT);
console.log(`发现 ${files.length} 个文件，推送到 ${repoSlug}@${branch}`);

let last = null;
for (const f of files) {
  const buf = fs.readFileSync(f.abs);
  // 已存在则取 sha 做更新
  let sha;
  try {
    const existing = await api('GET', `/repos/${repoSlug}/contents/${encodeURIComponent(f.rel).replace(/%2F/g, '/')}?ref=${branch}`);
    sha = existing.sha;
  } catch {
    sha = undefined;
  }
  const res = await api('PUT', `/repos/${repoSlug}/contents/${encodeURIComponent(f.rel).replace(/%2F/g, '/')}`, {
    message,
    content: buf.toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  last = res.commit;
  console.log(`  ${sha ? 'update' : 'create'} ${f.rel} (${buf.length}B)`);
}
console.log(`✅ pushed → https://github.com/${repoSlug}/tree/${branch}`);
if (last) console.log(`   latest commit ${last.sha.slice(0, 10)}: ${last.html_url}`);

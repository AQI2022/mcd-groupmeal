#!/usr/bin/env node
/**
 * 把引擎源码同步进云函数目录（cloudfunctions/mcd/lib/）。
 *
 * 为什么需要同步而不是 `npm install`：
 *   · 微信云函数部署时要「云端安装依赖」，而本项目是零依赖的纯 ESM；
 *   · 让云函数直接引用仓库根目录的 src/ 在部署时会丢失（只上传云函数目录）。
 * 于是用一个极小的同步器：复制 + 记录 sha256 清单，`--check` 用来在测试里防止漂移。
 *
 * 用法：
 *   node tools/build-mp-cloud.mjs           # 写入/更新 cloudfunctions/mcd/lib
 *   node tools/build-mp-cloud.mjs --check   # 只检查是否与 src/ 一致，不一致退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 云函数真正会用到的引擎模块（不含 cli/server：它们依赖 fs、http 服务器与命令行参数）。 */
export const CLOUD_FILES = [
  'money.mjs',
  'json.mjs',
  'http-fetch.mjs',
  'mcp-client.mjs',
  'mcd.mjs',
  'tiers.mjs',
  'promotions.mjs',
  'basket.mjs',
  'split.mjs',
  'optimizer.mjs',
  'render.mjs',
  'phone.mjs',
  'mock.mjs',
  'slim.mjs',
];

export const SRC_DIR = path.join(ROOT, 'src');
export const LIB_DIR = path.join(ROOT, 'cloudfunctions', 'mcd', 'lib');

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * @param {{write?: boolean}} [opts]
 * @returns {{ok:boolean, files:Array<{name:string,status:'same'|'missing'|'stale'|'extra'}>, manifest:object}}
 */
export function syncCloudLib({ write = false } = {}) {
  const files = [];
  const manifest = { generatedBy: 'tools/build-mp-cloud.mjs', source: 'src/', files: {} };

  for (const name of CLOUD_FILES) {
    const srcPath = path.join(SRC_DIR, name);
    const destPath = path.join(LIB_DIR, name);
    const srcBuf = readIfExists(srcPath);
    if (!srcBuf) {
      files.push({ name, status: 'missing' });
      continue;
    }
    const destBuf = readIfExists(destPath);
    const same = !!destBuf && Buffer.compare(srcBuf, destBuf) === 0;
    files.push({ name, status: same ? 'same' : 'stale' });
    manifest.files[name] = sha256(srcBuf);
    if (write && !same) {
      fs.mkdirSync(LIB_DIR, { recursive: true });
      fs.writeFileSync(destPath, srcBuf);
      files[files.length - 1].status = 'same';
    }
  }

  // lib 里多出来的 .mjs：说明有人手改了云函数副本或删了源码模块
  let extras = [];
  try {
    extras = fs
      .readdirSync(LIB_DIR)
      .filter((f) => f.endsWith('.mjs') && !CLOUD_FILES.includes(f));
  } catch {
    extras = [];
  }
  for (const name of extras) files.push({ name, status: 'extra' });

  if (write) {
    fs.mkdirSync(LIB_DIR, { recursive: true });
    fs.writeFileSync(path.join(LIB_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  const ok = files.every((f) => f.status === 'same');
  return { ok, files, manifest };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const check = process.argv.slice(2).includes('--check');
  const result = syncCloudLib({ write: !check });
  const changed = result.files.filter((f) => f.status !== 'same');

  if (check) {
    if (result.ok) {
      process.stdout.write(`✅ cloudfunctions/mcd/lib 与 src/ 一致（${CLOUD_FILES.length} 个文件）\n`);
    } else {
      process.stderr.write('❌ cloudfunctions/mcd/lib 与 src/ 不一致：\n');
      for (const f of changed) process.stderr.write(`   · ${f.name} → ${f.status}\n`);
      process.stderr.write('   运行 node tools/build-mp-cloud.mjs 重新同步。\n');
      process.exit(1);
    }
  } else {
    process.stdout.write(`已同步 ${CLOUD_FILES.length} 个模块到 cloudfunctions/mcd/lib（更新 ${changed.length} 个）\n`);
  }
}

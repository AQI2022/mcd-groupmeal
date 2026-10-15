#!/usr/bin/env node
/**
 * mcd-groupmeal CLI
 *
 *   optimize  跨门店比价 + 满折/满减最优方案 + 拆单结论
 *   stores    只看门店情报（最省调用量）
 *   demo      用内置演示数据跑通全流程（不发任何网络请求）
 *   doctor    连通性 / Token / 工具清单自检
 *
 * 全部零运行时依赖（只用 Node 内置模块）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './mcp-client.mjs';
import { listAddresses, queryGroupMealStores, loadStoreProfile, resolveAddress, TtlCache } from './mcd.mjs';
import { optimize } from './optimizer.mjs';
import { renderReport, renderStores } from './render.mjs';
import { summarizeLadders } from './promotions.mjs';
import { yuanToCents } from './money.mjs';
import { MockClient } from './mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USAGE = `mcd-groupmeal · 麦当劳团餐满减优化引擎

用法：
  mcd-groupmeal optimize --people 20 --budget 35 --address 西安 [选项]
  mcd-groupmeal stores   --address 西安
  mcd-groupmeal demo
  mcd-groupmeal doctor

选项：
  --people, -n <int>      人数（必填，optimize 模式）
  --budget, -b <yuan>     人均预算（元，必填）
  --address, -a <text>    地址匹配文本：城市名 / 写字楼名 / 完整地址
  --prefer <a,b>          偏好品类或餐品关键词，如 汉堡,薯条,饮料
  --assist <GMS001,...>   只考虑指定助餐档位
  --max-orders <int>      拆单上限，默认 3
  --variants <int>        每店候选篮子数，默认 3
  --max-calls <int>       calculate-price 调用硬上限，默认 150
  --reservation <time>    预约时间 "yyyy-MM-dd HH:mm"（全链路透传）
  --json                  以 JSON 输出结果
  --no-cache              关闭 10 分钟本地缓存
  --token <token>         临时指定 MCP Token（仅调试；正式用法见下）
  -h, --help              显示本帮助

Token 来源（按优先级）：
  1) 环境变量 MCD_MCP_TOKEN
  2) 当前目录或项目根目录的 mcp-config.json（见 mcp-config.example.json）
`;

function parseArgs(argv) {
  const out = { _: [] };
  const alias = { n: 'people', b: 'budget', a: 'address', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && a !== '-')) {
      const key = alias[a.replace(/^-+/, '')] ?? a.replace(/^-+/, '');
      if (key === 'json' || key === 'help') { out[key] = true; continue; }
      if (key === 'no-cache') { out.cache = false; continue; }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { out[key] = true; continue; }
      out[key] = val;
      i++;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Token 装载：env → cwd/mcp-config.json → 项目根/mcp-config.json。 */
export function loadTokenConfig({ explicitToken, cwd = process.cwd() } = {}) {
  if (explicitToken && explicitToken !== true) return { token: String(explicitToken), url: 'https://mcp.mcd.cn', from: 'argv(--token, 仅调试)' };
  if (process.env.MCD_MCP_TOKEN) return { token: process.env.MCD_MCP_TOKEN.trim(), url: process.env.MCD_MCP_URL || 'https://mcp.mcd.cn', from: 'env:MCD_MCP_TOKEN' };
  const candidates = [path.join(cwd, 'mcp-config.json'), path.join(ROOT, 'mcp-config.json')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const server = j?.mcpServers?.['mcd-mcp'] ?? Object.values(j?.mcpServers ?? {})[0] ?? j;
      const raw = server?.headers?.Authorization ?? server?.headers?.authorization ?? j?.token ?? j?.MCD_MCP_TOKEN;
      if (raw) return { token: String(raw).replace(/^Bearer\s+/i, '').trim(), url: server?.url || 'https://mcp.mcd.cn', from: file };
    } catch (e) {
      throw new Error(`解析 ${file} 失败：${e.message}`);
    }
  }
  return null;
}

function buildClient(args) {
  const cfg = loadTokenConfig({ explicitToken: args.token });
  if (!cfg?.token) {
    const err = new Error(
      '没有找到 MCP Token。请任选其一：\n' +
        '  · 复制 mcp-config.example.json 为 mcp-config.json 并填入真实 Token（推荐）\n' +
        '  · 设置环境变量 MCD_MCP_TOKEN\n' +
        '  · 想先看看效果：运行 `mcd-groupmeal demo`（内置演示数据，不需要 Token）',
    );
    err.code = 'NO_TOKEN';
    throw err;
  }
  return { client: new McpClient({ token: cfg.token, url: cfg.url }), from: cfg.from };
}

async function readStoresOnly(client, { addressQuery, cache, reservationDate }) {
  const book = await listAddresses(client);
  if (!book.length) {
    const err = new Error('账号地址簿为空。请先在麦当劳 App / 小程序里保存至少一个收货地址。');
    err.code = 'EMPTY_ADDRESS_BOOK';
    throw err;
  }
  const address = resolveAddress(book, addressQuery);
  if (!address) throw new Error(`地址簿里找不到匹配「${addressQuery}」的地址（共 ${book.length} 条）`);
  const stores = await queryGroupMealStores(client, address.addressId);
  const reports = [];
  for (const store of stores) {
    const p = await loadStoreProfile(client, store, { addressId: address.addressId, cache, reservationDate });
    reports.push({
      store: { storeCode: store.storeCode, beCode: store.beCode, storeName: store.storeName, reservation: store.reservation },
      menuSize: Object.keys(p.menu.meals).length,
      assistance: p.assistance,
      ladders: summarizeLadders(p.promotions),
      discountOnly: false,
    });
  }
  return { address, stores, storeReports: reports, plans: [], best: null, verdict: null, warnings: [] };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] ?? (args.help ? 'help' : 'help');

  if (args.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const people = Number(args.people ?? 0);
  const budgetPerPersonCents = yuanToCents(args.budget ?? 0);
  const cache = args.cache === false ? null : new TtlCache(600000);

  if (command === 'demo') {
    const n = people || 20;
    const budget = budgetPerPersonCents || yuanToCents(35);
    const client = new MockClient();
    const result = await optimize({
      client,
      people: n,
      budgetPerPersonCents: budget,
      addresses: [{ addressId: 'DEMO', fullAddress: '演示市演示区演示路 1 号 演示大厦 21 楼', contactName: '演示用户', phone: '***' }],
      prefer: splitList(args.prefer),
      maxOrders: Number(args['max-orders'] ?? 3),
      variants: Number(args.variants ?? 3),
      maxCalls: Number(args['max-calls'] ?? 150),
      cache,
    });
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      process.stdout.write('⚠️ 演示数据：门店名、餐品与价格均为构造数据，不是真实门店报价。\n\n');
      process.stdout.write(renderReport(result, { people: n, budgetPerPersonCents: budget }) + '\n');
    }
    return 0;
  }

  if (command === 'doctor') {
    const { client, from } = buildClient(args);
    const info = await client.initialize().catch((e) => {
      process.stdout.write(`❌ initialize 失败：${e.message}\n`);
      return null;
    });
    if (info === null) return 1;
    process.stdout.write(`✅ 握手成功：${JSON.stringify(info)}\n`);
    const tools = await client.listTools();
    process.stdout.write(`✅ 工具数：${tools.length}\n`);
    for (const want of ['delivery-query-stores', 'query-meals', 'query-meal-assistance', 'query-promotions', 'calculate-price']) {
      process.stdout.write(`   ${client.findTool(want) ? '✓' : '✗'} ${want}\n`);
    }
    const book = await listAddresses(client);
    process.stdout.write(`ℹ️ Token 来源：${from}\n`);
    process.stdout.write(`ℹ️ 地址簿条数：${book.length}${book.length ? '' : '（⚠️ 没有地址就查不到团餐门店）'}\n`);
    process.stdout.write(`ℹ️ 本次请求数：${client.callCount}\n`);
    return 0;
  }

  if (!people || !budgetPerPersonCents) {
    process.stderr.write('❌ 需要 --people 与 --budget。示例：mcd-groupmeal optimize --people 20 --budget 35 --address 西安\n');
    return 2;
  }

  const { client, from } = buildClient(args);
  if (command === 'stores') {
    const result = await readStoresOnly(client, { addressQuery: args.address, cache, reservationDate: args.reservation });
    process.stdout.write(renderStores(result) + '\n');
    return 0;
  }

  const result = await optimize({
    client,
    people,
    budgetPerPersonCents,
    addressQuery: args.address,
    prefer: splitList(args.prefer),
    assistCodes: splitList(args.assist),
    maxOrders: Number(args['max-orders'] ?? 3),
    variants: Number(args.variants ?? 3),
    maxCalls: Number(args['max-calls'] ?? 150),
    reservationDate: args.reservation,
    cache,
  });

  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write(`Token 来源：${from}\n\n`);
    process.stdout.write(renderReport(result, { people, budgetPerPersonCents }) + '\n');
  }
  return result.best ? 0 : 1;
}

function splitList(v) {
  if (!v || v === true) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`❌ ${err.message}\n`);
      process.exit(1);
    });
}

export { main, parseArgs, USAGE };

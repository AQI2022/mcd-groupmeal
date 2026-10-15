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
import { solvePhoneOrder, renderPhoneCard, placeOrder, CHANNEL } from './phone.mjs';
import { summarizeLadders } from './promotions.mjs';
import { yuanToCents } from './money.mjs';
import { MockClient } from './mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USAGE = `mcd-groupmeal · 麦当劳团餐满减优化引擎

用法：
  mcd-groupmeal optimize --people 20 --budget 35 --address 西安 [选项]
  mcd-groupmeal phone    --city 西安市 --keyword 长安大厦 --want 巨无霸,中杯美式 [选项]
  mcd-groupmeal phone    --channel delivery --address 西安 --want 巨无霸,薯条 [选项]
  mcd-groupmeal stores   --address 西安
  mcd-groupmeal demo
  mcd-groupmeal doctor

phone（手机点餐）选项：
  --channel <pickup|delivery>  到店自取（默认，不需要地址簿）/ 麦乐送（需要地址簿）
  --city <城市>                到店必填（与 --keyword 同用，按位置搜店）
  --keyword <位置关键词>       到店必填，如 长安大厦
  --address, -a <text>         麦乐送：地址簿匹配文本（城市名/写字楼）
  --want <a,b>                 想吃什么，如 巨无霸,中杯美式,薯条（不给则按预算自动配餐）
  --budget, -b <yuan>          单人预算（元，可选；自动配餐时用于砍项）
  --stores <int>               最多比价几家门店，默认 5
  --max-calls <int>            算价调用硬上限，默认 60
  --no-coupon-scan             不探测「券专属商品」
  --include-closed             连打烊门店也尝试（默认跳过并列出来）
  --pay                        真实创建订单并返回付款 H5 链接（会下真单，需你确认）
  --demo                       手机点餐离线演示（构造数据，不联网、不需要 Token）
  --json                       以 JSON 输出结果

选项：
  --people, -n <int>      人数（必填，optimize 模式）
  --budget, -b <yuan>     人均预算（元，必填 optimize / 可选 phone）
  --address, -a <text>    地址匹配文本：城市名 / 写字楼名 / 完整地址
  --prefer <a,b>          偏好品类或餐品关键词，如 汉堡,薯条,饮料
  --assist <GMS001,...>   只考虑指定助餐档位
  --max-orders <int>      拆单上限，默认 3
  --variants <int>        每店候选篮子数，默认 3
  --reservation <time>    预约时间 "yyyy-MM-dd HH:mm"（全链路透传）
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
  const BOOL = new Set(['json', 'help', 'no-cache', 'no-coupon-scan', 'include-closed', 'pay', 'demo']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && a !== '-')) {
      const key = alias[a.replace(/^-+/, '')] ?? a.replace(/^-+/, '');
      if (BOOL.has(key)) {
        if (key === 'no-cache') out.cache = false;
        else out[key] = true;
        continue;
      }
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
      // 单店单接口失败会被降级为空集合（如门店打烊时 query-meals 返回 code=600057）。
      // 必须把原因带到输出里，否则「菜单 0 项」会被误读成「这家店没有团餐」。
      degraded: p.degraded,
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

  // ---- 手机点餐：到店自取 / 麦乐送（个人小单，券驱动）
  if (command === 'phone') {
    const channel = args.channel === 'delivery' || args.channel === CHANNEL.DELIVERY ? CHANNEL.DELIVERY : CHANNEL.PICKUP;
    if (channel === CHANNEL.PICKUP && !args.city && !args.keyword && !args.demo) {
      process.stderr.write(
        '❌ 到店点餐需要位置：--city 西安市 --keyword 长安大厦（或只给 --city，按收藏门店搜索）。\n' +
          '   麦乐送请用：mcd-groupmeal phone --channel delivery --address 西安 --want 巨无霸,薯条\n' +
          '   只想看效果（不联网、不需要 Token）：mcd-groupmeal phone --demo --want 巨无霸,美式中杯\n',
      );
      return 2;
    }
    const demoMode = args.demo === true;
    const client = demoMode ? new MockClient() : buildClient(args).client;
    const from = demoMode ? '演示数据（不联网）' : loadTokenConfig({ explicitToken: args.token })?.from ?? 'mcp-config.json';
    const result = await solvePhoneOrder({
      client,
      channel,
      addressQuery: args.address === true ? undefined : args.address,
      city: args.city === true ? undefined : args.city,
      keyword: args.keyword === true ? undefined : args.keyword,
      want: splitList(args.want),
      budgetCents: budgetPerPersonCents || undefined,
      maxStores: Number(args.stores ?? 5),
      maxCalls: Number(args['max-calls'] ?? 60),
      couponFirst: args['no-coupon-scan'] !== true,
      includeClosed: args['include-closed'] === true,
      reservationDate: args.reservation,
      cache,
    });

    if (args.pay && result.best) {
      // ⚠️ 会创建真实未支付订单；--pay 是显式确认开关
      const order = await placeOrder(client, result.best, { addressId: result.best.addressId });
      process.stdout.write(
        `\n🧾 已创建订单\n   orderId: ${order.orderId}\n   应付：¥${order.amount}\n   付款链接：${order.payH5Url}\n` +
          '   （未支付；链接可在手机上直接打开付款，请自己核对金额与门店）\n\n',
      );
      if (args.json) process.stdout.write(JSON.stringify({ ...result, order }, null, 2) + '\n');
      else process.stdout.write(renderPhoneCard(result) + '\n');
      return 0;
    }

    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      if (demoMode) process.stdout.write('⚠️ 演示数据：门店名、券与价格均为构造数据，不是真实门店报价。\n\n');
      process.stdout.write(`Token 来源：${from}\n\n`);
      process.stdout.write(renderPhoneCard(result) + '\n');
    }
    return result.comparisons.length ? 0 : 1;
  }

  const { client, from } = buildClient(args);

  if (command === 'stores') {
    const result = await readStoresOnly(client, { addressQuery: args.address, cache, reservationDate: args.reservation });
    process.stdout.write(renderStores(result) + '\n');
    return 0;
  }

  if (!people || !budgetPerPersonCents) {
    process.stderr.write('❌ 需要 --people 与 --budget。示例：mcd-groupmeal optimize --people 20 --budget 35 --address 西安\n');
    return 2;
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

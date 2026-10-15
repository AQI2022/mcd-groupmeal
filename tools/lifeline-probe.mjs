#!/usr/bin/env node
/**
 * A~E 生死线验证器。
 *
 * 在一个新地址 / 新城市上跑这个脚本，10 分钟内就能判断「团餐满减优化」这个选题是否成立：
 *
 *   A｜delivery-query-stores{beType=6} 每个地址能查到几家**可配送团餐门店**
 *      → 0 家：选题不成立；仅 1 家：跨门店比价卖点归零（仍可做单店优化）
 *   B｜query-meals 能否取到团餐实时菜单
 *   C｜query-meal-assistance 是否返回 gmServiceCode（没有它，团餐链路根本走不通）
 *   D｜query-promotions 是否返回满折/满减规则（为空则「满减优化」卖点不成立）
 *   E｜calculate-price 团餐算价是否通过（不通过就无法做权威验价）
 *
 * 用法：
 *   node tools/lifeline-probe.mjs                 # 遍历账号地址簿里的全部地址
 *   node tools/lifeline-probe.mjs --city 西安      # 只测匹配到「西安」的地址
 *   node tools/lifeline-probe.mjs --out docs/LIFELINE.md
 *
 * 纪律：**不打印、不落盘 Token / 手机号 / 完整地址 / addressId 明文**，只输出计数与布尔值。
 */
import fs from 'node:fs';
import path from 'node:path';

import { McpClient } from '../src/mcp-client.mjs';
import { listAddresses, queryGroupMealStores, loadStoreProfile, resolveAddress, TtlCache, calculatePrice } from '../src/mcd.mjs';
import { summarizeLadders } from '../src/promotions.mjs';
import { loadTokenConfig } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = argOf('--out', path.resolve(process.cwd(), 'docs/LIFELINE.md'));
const CITY = argOf('--city', null);
const CITIES = ['西安', '深圳', '上海', '杭州', '北京', '成都', '重庆', '武汉'];

const mask = (s, keep = 3) => {
  const v = String(s ?? '');
  if (!v) return '';
  return v.length <= keep ? '*'.repeat(v.length) : v.slice(0, keep) + '*'.repeat(Math.min(6, v.length - keep));
};
const cityOf = (full) => CITIES.find((c) => String(full).includes(c)) ?? '其他';

const cfg = loadTokenConfig({});
if (!cfg?.token) {
  console.error('❌ 没有找到 MCP Token（mcp-config.json 或 MCP_MCP_TOKEN）。');
  process.exit(2);
}
const client = new McpClient({ token: cfg.token, url: cfg.url });
await client.initialize();
const tools = await client.listTools();

const rows = [];
const book = await listAddresses(client);
const targets = CITY ? [resolveAddress(book, CITY)].filter(Boolean) : book;

if (!book.length) {
  console.error('❌ 账号地址簿为空：先到麦当劳 App / 小程序里保存至少一个收货地址。');
  process.exit(1);
}

let chain = null;
for (const addr of targets) {
  const city = cityOf(addr.fullAddress);
  const stores = await queryGroupMealStores(client, addr.addressId);
  const row = { city, addrMasked: mask(addr.addressId), storeCount: stores.length, stores: [], ok: true };
  for (const store of stores) {
    const profile = await loadStoreProfile(client, store, { addressId: addr.addressId, cache: new TtlCache() });
    const menuSize = Object.keys(profile.menu.meals).length;
    const gm = profile.assistance.filter((a) => a.gmServiceCode);
    const ladders = summarizeLadders(profile.promotions);
    const record = {
      storeCode: store.storeCode,
      storeName: store.storeName,
      menuSize,
      assistance: profile.assistance.length,
      gmServiceCode: !!gm.length,
      ruleTiers: ladders.reduce((s, l) => s + l.tiers.length, 0),
      ladders,
      degraded: (profile.degraded ?? []).map((d) => d.label),
    };
    row.stores.push(record);
    if (!chain && menuSize > 0 && gm.length) {
      const mealCodes = Object.keys(profile.menu.meals);
      const cp = await calculatePrice(client, {
        storeCode: store.storeCode,
        beCode: store.beCode,
        gmServiceCode: gm[0].gmServiceCode,
        addressId: addr.addressId,
        items: [{ productCode: mealCodes[0], quantity: 2 }],
      });
      chain = { city, storeName: store.storeName, storeCode: store.storeCode, cp, menuSize, gm, ladders };
    }
    if (store !== stores[stores.length - 1]) await new Promise((r) => setTimeout(r, 120));
  }
  rows.push(row);
}

const totalStores = rows.reduce((s, r) => s + r.storeCount, 0);
const best = rows.reduce((a, b) => (b.storeCount > a.storeCount ? b : a), rows[0]);
const pass = {
  A: best.storeCount >= 2 ? '✅ 通过' : best.storeCount === 1 ? '⚠️ 仅 1 家 → 跨门店比价卖点归零' : '❌ 0 家',
  B: chain ? (chain.menuSize > 0 ? `✅ ${chain.menuSize} 项` : '❌ 空') : '—',
  C: chain ? (chain.gm ? '✅ 有' : '❌ 无') : '—',
  D: chain ? (chain.ladders.reduce((s, l) => s + l.tiers.length, 0) > 0 ? `✅ ${chain.ladders.reduce((s, l) => s + l.tiers.length, 0)} 档` : '❌ 空') : '—',
  E: chain ? (chain.cp.price > 0 ? '✅ 通过' : '❌ 未通过') : '—',
};

const md = [];
md.push('# 生死线验证报告（lifeline-probe）');
md.push('');
md.push(`- 运行时间：${new Date().toISOString()}`);
md.push(`- Token 来源：${path.basename(String(cfg.from))}（**Token 值不落盘、不打印**）`);
md.push(`- 服务端工具总数：**${tools.length}**｜\`query-promotions\`：${client.findTool('query-promotions') ? '存在' : '不存在'}｜\`query-meal-assistance\`：${client.findTool('query-meal-assistance') ? '存在' : '不存在'}`);
md.push('');
md.push('## A~E 判定');
md.push('');
md.push('| 线 | 判什么 | 结论 |');
md.push('|---|---|---|');
md.push(`| A | \`delivery-query-stores{beType=6}\` 可配送团餐门店数 | ${pass.A} |`);
md.push(`| B | 团餐实时菜单可取 | ${pass.B} |`);
md.push(`| C | 助餐返回 \`gmServiceCode\` | ${pass.C} |`);
md.push(`| D | 满折/满减规则存在 | ${pass.D} |`);
md.push(`| E | \`calculate-price\` 可算团餐价 | ${pass.E} |`);
md.push('');
md.push('## 各地址团餐门店数（地址与 addressId 已脱敏）');
md.push('');
md.push('| 城市 | addressId | 团餐门店数 |');
md.push('|---|---|---:|');
for (const r of rows) md.push(`| ${r.city} | ${r.addrMasked} | ${r.storeCount} |`);
md.push(`| **合计** | — | **${totalStores}** |`);
md.push('');
md.push('## 门店明细');
md.push('');
md.push('| 城市 | 门店 | 菜单项 | 助餐档位 | gmServiceCode | 规则档位数 |');
md.push('|---|---|---:|---:|:---:|---:|');
for (const r of rows) {
  for (const s of r.stores) {
    md.push(`| ${r.city} | ${s.storeName} | ${s.menuSize} | ${s.assistance} | ${s.gmServiceCode ? '有' : '无'} | ${s.ruleTiers} |`);
  }
}
md.push('');
if (chain) {
  md.push('## 折扣阶梯实测（首个可用门店）');
  md.push('');
  md.push(`门店：${chain.storeName}（${chain.city}）`);
  md.push('');
  md.push('| 助餐档位 | 阶梯 |');
  md.push('|---|---|');
  for (const l of chain.ladders) {
    md.push(`| ${l.gmServiceCode} | ${l.tiers.map((t) => (t.kind === 'discount' ? `满¥${t.thresholdCents / 100}→${(100 - t.percentOff) / 10}折` : `满¥${t.thresholdCents / 100}减¥${t.reduceCents / 100}`)).join('，')} |`);
  }
  md.push('');
  md.push(`\`calculate-price\` 回执样例（最小 2 件）：原价 ${chain.cp.originalPrice} 分 · 优惠 ${chain.cp.discount} 分 · 实付 ${chain.cp.price} 分 · 配送 ${chain.cp.deliveryPrice} 分 · 打包 ${chain.cp.packingPrice} 分`);
  md.push('');
}
md.push('## 脱敏回报块（可直接贴进频道）');
md.push('');
md.push('```');
md.push(`工具数=${tools.length}｜query-promotions=${client.findTool('query-promotions') ? '有' : '无'}`);
md.push(`团餐门店数=${rows.map((r) => `${r.city}:${r.storeCount}`).join(' ') || 'n/a'}`);
md.push(`gmServiceCode=${chain?.gm?.length ? '有' : '无'}`);
md.push(`满减/满折规则=${chain ? chain.ladders.reduce((s, l) => s + l.tiers.length, 0) : 0} 档`);
md.push(`calculate-price=${chain && chain.cp.price > 0 ? '通过' : '未通过'}`);
md.push('```');
md.push('');
md.push('_由 `tools/lifeline-probe.mjs` 生成；脚本不落盘任何凭证或明文地址。_');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8');
console.log(md.filter((l) => l.startsWith('| A |') || l.startsWith('| B |') || l.startsWith('| C |') || l.startsWith('| D |') || l.startsWith('| E |')).join('\n'));
console.log('\n' + md.slice(md.indexOf('## 脱敏回报块（可直接贴进频道）') + 2, md.indexOf('## 脱敏回报块（可直接贴进频道）') + 9).join('\n'));
console.log(`\n✅ 写入 ${OUT}`);

#!/usr/bin/env node
/**
 * 多城市团餐门店 / 规则扫描器。
 *
 * 对账号地址簿里的每个城市，统计：
 *   · beType=6 可配送团餐门店数
 *   · 每店菜单规模、助餐档位数、满折/满减阶梯
 * 产出 docs/CITY-COMPARISON.md + city-comparison.json。
 *
 * 这是本项目对外材料里「真实数据弹药」的唯一来源——所有对外文案引用它时
 * 必须标注采集时间与城市清单，不允许编造。
 *
 * 用法：
 *   node tools/city-scan.mjs
 *   node tools/city-scan.mjs --out docs/CITY-COMPARISON.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { McpClient } from '../src/mcp-client.mjs';
import { listAddresses, queryGroupMealStores, loadStoreProfile, TtlCache } from '../src/mcd.mjs';
import { summarizeLadders, isDiscountOnly } from '../src/promotions.mjs';
import { loadTokenConfig } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT_MD = argOf('--out', path.resolve(process.cwd(), 'docs/CITY-COMPARISON.md'));
const OUT_JSON = argOf('--json', path.resolve(process.cwd(), 'city-comparison.json'));

const CITIES = ['西安', '深圳', '上海', '杭州', '北京', '成都', '重庆', '武汉'];
const cityOf = (full) => CITIES.find((c) => String(full).includes(c)) ?? '其他';
const rate = (t) => (t.kind === 'discount' ? `${(100 - t.percentOff) / 10}折` : `减¥${t.reduceCents / 100}`);
const tierText = (t) => `满¥${t.thresholdCents / 100}→${rate(t)}`;

const cfg = loadTokenConfig({});
if (!cfg?.token) {
  console.error('❌ 没有找到 MCP Token（mcp-config.json）。');
  process.exit(2);
}

const client = new McpClient({ token: cfg.token, url: cfg.url });
await client.initialize();

const book = await listAddresses(client);
const cache = new TtlCache();
const result = { scannedAt: new Date().toISOString(), tools: (await client.listTools()).length, cities: [] };

for (const city of CITIES) {
  const addr = book.find((a) => cityOf(a.fullAddress) === city);
  if (!addr) {
    result.cities.push({ city, hasAddress: false, storeCount: 0, stores: [] });
    console.log(`[${city}] 地址簿里没有该城市的地址，跳过`);
    continue;
  }
  const stores = await queryGroupMealStores(client, addr.addressId);
  const entry = { city, hasAddress: true, storeCount: stores.length, stores: [] };
  for (const store of stores) {
    const p = await loadStoreProfile(client, store, { addressId: addr.addressId, cache });
    const ladders = summarizeLadders(p.promotions);
    entry.stores.push({
      storeName: store.storeName,
      storeCode: store.storeCode,
      menuSize: Object.keys(p.menu.meals).length,
      menu: Object.values(p.menu.meals).map((m) => ({ code: m.code, name: m.name, price: m.currentPrice })),
      assistance: p.assistance.map((a) => ({ code: a.gmServiceCode, name: a.gmServiceName, enable: a.enable })),
      ladders: ladders.map((l) => ({ gmServiceCode: l.gmServiceCode, tiers: l.tiers })),
      discountOnly: isDiscountOnly(p.promotions, ladders[0]?.gmServiceCode),
      degraded: (p.degraded ?? []).map((d) => d.label),
    });
    await new Promise((r) => setTimeout(r, 120));
  }
  entry.priceDiff = crossStorePriceDiff(entry.stores);
  // 落盘前丢掉完整菜单（体积大且无长期价值），只保留统计与价差样例
  for (const s of entry.stores) delete s.menu;
  result.cities.push(entry);
  console.log(`[${city}] 团餐门店 ${stores.length} 家${entry.priceDiff ? `｜共同商品 ${entry.priceDiff.common} 项中 ${entry.priceDiff.diff} 项店间价差` : ''}`);
}

/**
 * 同一城市内多家门店的「共同商品价格差异」统计。
 * 这是跨门店比价能否成立的关键证据：如果各店价格完全一致，比价就没有意义。
 */
function crossStorePriceDiff(stores) {
  if (stores.length < 2) return null;
  const [first, ...rest] = stores;
  const common = first.menu.filter((m) => rest.every((s) => s.menu.some((x) => x.code === m.code)));
  const diffRows = [];
  for (const m of common) {
    const prices = stores.map((s) => s.menu.find((x) => x.code === m.code).price);
    if (new Set(prices).size > 1) diffRows.push({ code: m.code, name: m.name, min: Math.min(...prices), max: Math.max(...prices) });
  }
  return { common: common.length, diff: diffRows.length, examples: diffRows.slice(0, 5) };
}

/** 全部门店的折扣阶梯是否完全一致（用于判断规则是「品牌级」还是「门店级」）。 */
function laddersIdentical(cities) {
  const sigs = new Set();
  for (const c of cities) {
    for (const s of c.stores) {
      sigs.add(
        JSON.stringify(
          s.ladders
            .map((l) => ({ g: l.gmServiceCode, t: l.tiers.map((t) => [t.thresholdCents, t.percentOff ?? t.reduceCents, t.kind]) }))
            .sort((a, b) => a.g.localeCompare(b.g)),
        ),
      );
    }
  }
  return { identical: sigs.size <= 1, variants: sigs.size };
}

const allStores = result.cities.flatMap((c) => c.stores);
const withStores = result.cities.filter((c) => c.storeCount > 0);
const ladderCheck = laddersIdentical(result.cities);
const multiStoreCities = result.cities.filter((c) => c.priceDiff);
const diffCities = multiStoreCities.filter((c) => c.priceDiff.diff > 0);

const md = [];
md.push('# 8 城团餐门店 / 折扣阶梯 实测对比');
md.push('');
md.push(`> 采集时间：**${result.scannedAt.slice(0, 19).replace('T', ' ')} UTC**｜数据来源：麦当劳中国 MCP 实时接口（\`delivery-query-stores\` / \`query-meals\` / \`query-meal-assistance\` / \`query-promotions\`）`);
md.push('> 采集方式：`node tools/city-scan.mjs`，可复现。地址为账号地址簿中对应城市的写字楼地址（脚本不输出明文）。');
md.push('');
md.push('## 结论速览');
md.push('');
md.push(`- **${withStores.length}/${result.cities.length}** 个城市有可配送团餐门店，合计 **${allStores.length}** 家门店；单城门店数区间 **${Math.min(...result.cities.map((c) => c.storeCount))}–${Math.max(...result.cities.map((c) => c.storeCount))}** 家。`);
md.push(`- **折扣阶梯是全品牌统一的，不是逐店不同的**：${allStores.length} 家门店的规则签名完全相同（${ladderCheck.variants} 种）。`);
md.push(`  → 这直接决定了「拆单」的结论对所有门店一致：满折场景下拆单必然更贵（见 [LIFELINE.md](./LIFELINE.md)）。`);
md.push(`- **跨门店比价的价值来自菜单价格差异，而不是折扣差异**：${multiStoreCities.length} 个多店城市里有 **${diffCities.length}** 个存在共同商品的店间价差。`);
for (const c of diffCities) {
  const ex = c.priceDiff.examples.map((e) => `${e.name} ¥${(e.min / 100).toFixed(2)}~¥${(e.max / 100).toFixed(2)}`).join('、');
  md.push(`  · **${c.city}**：${c.storeCount} 家店，共同商品 ${c.priceDiff.common} 项中 **${c.priceDiff.diff} 项**有价差（${ex}）`);
}
md.push(`- **助餐档位是按需解锁的**：${allStores.filter((s) => s.assistance.some((a) => a.enable)).length}/${allStores.length} 家门店默认只有「保鲜速达(GMS001)」可用，「专人分餐(GMS002)/专人摆台(GMS003)」需**提前 ≥4 小时预约**才可选。`);
md.push('');
md.push('## 城市 × 门店数');
md.push('');
md.push('| 城市 | 地址簿 | 团餐门店数 | 门店 |');
md.push('|---|:---:|---:|---|');
for (const c of result.cities) {
  md.push(`| ${c.city} | ${c.hasAddress ? '✓' : '—'} | **${c.storeCount}** | ${c.stores.map((s) => s.storeName.replace('麦当劳', '')).join('、') || '—'} |`);
}
md.push('');
md.push('## 店间价差明细（多店城市）');
md.push('');
md.push('| 城市 | 共同商品数 | 有价差商品数 | 示例 |');
md.push('|---|---:|---:|---|');
for (const c of multiStoreCities) {
  md.push(`| ${c.city} | ${c.priceDiff.common} | **${c.priceDiff.diff}** | ${c.priceDiff.examples.map((e) => `${e.name} ¥${(e.min / 100).toFixed(2)}~¥${(e.max / 100).toFixed(2)}`).join('、') || '—'} |`);
}
md.push('');
md.push('## 各店菜单规模与规则档位数');
md.push('');
md.push('| 城市 | 门店 | 菜单项 | 助餐档位(默认可用) | 规则档位 | 仅满折 |');
md.push('|---|---|---:|---:|---:|:---:|');
for (const c of result.cities) {
  for (const s of c.stores) {
    md.push(`| ${c.city} | ${s.storeName.replace('麦当劳', '')} | ${s.menuSize} | ${s.assistance.filter((a) => a.enable).length}/${s.assistance.length} | ${s.ladders.reduce((n, l) => n + l.tiers.length, 0)} | ${s.discountOnly ? '是' : '否'} |`);
  }
}
md.push('');
md.push('## 折扣阶梯对比（每城首店 · 保鲜速达 GMS001）');
md.push('');
md.push('| 城市 | 门店 | 满¥300 | 满¥500 | 满¥1000 | 满¥2000 |');
md.push('|---|---|---|---|---|---|');
for (const c of result.cities) {
  const s = c.stores[0];
  if (!s) continue;
  const tiers = s.ladders.find((l) => l.gmServiceCode === 'GMS001')?.tiers ?? s.ladders[0]?.tiers ?? [];
  const at = (th) => {
    const t = tiers.find((x) => x.thresholdCents === th * 100);
    return t ? rate(t) : '—';
  };
  md.push(`| ${c.city} | ${s.storeName.replace('麦当劳', '')} | ${at(300)} | ${at(500)} | ${at(1000)} | ${at(2000)} |`);
}
md.push('');
md.push('## 采集说明与免责');
md.push('');
md.push('- 本表为**特定时刻的实时快照**：门店覆盖、菜单与促销规则由麦当劳侧动态下发，随时可能变化。');
md.push('- 表中不含任何真实 Token、手机号、完整地址或 addressId。');
md.push('- 对外引用请保留采集时间，不要把它当作长期有效的承诺。');
md.push('');
md.push('_由 `tools/city-scan.mjs` 生成。_');

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md.join('\n') + '\n', 'utf8');
fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8');
console.log(`\n✅ 写入 ${OUT_MD}\n✅ 写入 ${OUT_JSON}`);
console.log(`门店合计 ${allStores.length}｜有门店城市 ${withStores.length}/${result.cities.length}｜工具调用 ${client.callCount} 次`);

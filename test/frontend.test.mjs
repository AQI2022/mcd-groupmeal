/**
 * 前端渲染层测试（`node test/frontend.test.mjs`）。
 *
 * 为什么值得单独测：这个项目**没有构建步骤**，前端唯一的「编译期」就是这里。
 * public/render.js 被刻意写成纯函数（不碰 document、不读全局），
 * 所以可以在 Node 里直接喂真实数据和演示数据，确认：
 *   · 渲染不抛异常（手机上一旦抛异常就是白屏，而我没法在浏览器里替你回归）；
 *   · 关键信息真的出现在 HTML 里（门店名、券、实付金额、拆单结论）；
 *   · 门店全打烊时给出的是**如实说明**，而不是一个空页面或假方案。
 *
 * 样本来源：
 *   ① 演示数据 —— 由 MockClient 现场生成，覆盖「有方案」的全部 UI 分支（券、券专属商品、跨门店比价…）；
 *   ② 真实数据 —— test/fixtures/real-phone-*.json，是 2026-10-15 真 Token 实测快照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPhone, renderGroup, yuan, plain, row } from '../public/render.js';
import { solvePhoneOrder, renderPhoneCard, CHANNEL } from '../src/phone.mjs';
import { optimize } from '../src/optimizer.mjs';
import { renderReport } from '../src/render.mjs';
import { MockClient } from '../src/mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test/fixtures');

/** 造一份和 src/server.mjs 完全同形的 payload。 */
async function demoPhonePayload(params = {}) {
  const client = new MockClient();
  const result = await solvePhoneOrder({
    client,
    channel: CHANNEL.PICKUP,
    city: '演示市',
    keyword: '演示路',
    want: ['巨无霸', '中杯美式'],
    ...params,
  });
  return { kind: 'phone', demo: true, canOrder: false, jobId: 'frontend-fixture', from: '演示数据', result, text: renderPhoneCard(result) };
}

async function demoGroupPayload() {
  const client = new MockClient();
  const people = 20;
  const budgetPerPersonCents = 3500;
  const result = await optimize({
    client,
    people,
    budgetPerPersonCents,
    addresses: [{ addressId: 'DEMO', fullAddress: '演示市演示区演示路 1 号 演示大厦 21 楼', contactName: '演示用户', phone: '***' }],
  });
  return { kind: 'optimize', demo: true, jobId: 'frontend-fixture', from: '演示数据', result, text: renderReport(result, { people, budgetPerPersonCents }) };
}

// ───────────────────────────────────────── 纯工具

test('render: yuan / plain / row 的基本行为', () => {
  assert.equal(yuan(3980), '¥39.80');
  assert.equal(yuan(0), '¥0.00');
  assert.equal(yuan(undefined), '¥0.00');
  assert.equal(yuan(-570), '¥-5.70', '负数不是预期输入：调用方统一写成 −${yuan(正值)} 表示优惠');
  assert.equal(plain('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(!plain('"><script>').includes('<script>'), '必须转义，避免把接口数据当 HTML 解析');
  assert.match(row('实付', '¥39.80', 'total'), /class="row total"/);
});

// ───────────────────────────────────────── 手机点餐：有方案

test('renderPhone: 演示数据下渲染出完整点餐卡，不抛异常', async () => {
  const payload = await demoPhonePayload();
  const html = renderPhone(payload);
  const best = payload.result.best;

  assert.ok(html.length > 1500, `HTML 太短，可能没渲染出内容（${html.length} B）`);
  assert.match(html, /class="hero"/);
  assert.ok(html.includes(best.store.storeName.replace(/^麦当劳/, '')), '必须出现最优门店名');
  assert.ok(html.includes(`¥${(best.best.priceCents / 100).toFixed(2)}`), '必须出现实付金额');
  assert.match(html, /实付（官方算价）/);
  for (const it of best.best.items) assert.ok(html.includes(it.name), `清单里缺少 ${it.name}`);
  for (const t of best.best.couponTitles) assert.ok(html.includes(t), `用券信息里缺少 ${t}`);

  // 券专属商品必须被标注出来（这是本项目「券找货」的差异点）
  assert.match(html, /券专属商品：菜单里搜不到/);
  // 到店自取不应出现配送费行
  assert.ok(!html.includes('配送费'), '到店自取不该有配送费行');
  // 演示模式不给下单入口
  assert.ok(!html.includes('id="act-order"'), '演示模式不能出现下单按钮');
  assert.match(html, /id="act-copy"/);
  // 原始纯文本报告要以转义形式嵌进去
  assert.ok(html.includes('手机点餐卡'), '应当附带原始纯文本报告');
});

test('renderPhone: 打烊门店与跨门店比价都渲染出来', async () => {
  const payload = await demoPhonePayload({ stores: 5 });
  const html = renderPhone(payload);
  if (payload.result.closed.length) {
    assert.match(html, /已排除（当前非营业时间）/);
    assert.ok(html.includes(payload.result.closed[0].storeName), '打烊门店要列出来');
  }
  if (payload.result.comparisons.length > 1) {
    assert.match(html, /同单跨门店比价/);
    assert.match(html, /换个门店最多差/, '要给出店间价差');
  }
  assert.ok(payload.result.closed.length + payload.result.comparisons.length > 0, '样本要覆盖到至少一个分支');
});

test('renderPhone: 麦乐送要出现配送费/打包费与麦乐送标记', async () => {
  const payload = await demoPhonePayload({ channel: CHANNEL.DELIVERY, city: undefined, keyword: undefined, addressQuery: '演示', want: ['巨无霸'] });
  const html = renderPhone(payload);
  assert.ok(payload.result.best, '麦乐送演示样本应当有方案');
  assert.match(html, /麦乐送到这个地址/);
  assert.match(html, /配送费/);
  assert.match(html, /打包费/);
});

// ───────────────────────────────────────── 手机点餐：无方案（真实数据）

test('renderPhone: 门店全打烊时如实说明，而不是空白页', () => {
  const file = path.join(FIXTURES, 'real-phone-allclosed.json');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.result.comparisons.length, 0, '这份快照就是「一家都比不出来」的真实场景');
  assert.ok(payload.result.closed.length > 0);

  const html = renderPhone(payload);
  assert.match(html, /没有可比价的门店/);
  assert.match(html, /已排除（当前非营业时间）/);
  assert.ok(html.includes(payload.result.closed[0].storeName));
  assert.match(html, /不是「这家店没有菜单」/, '要把「打烊」和「没有菜单」区分清楚');
  assert.ok(!html.includes('id="act-order"'), '没有方案时不能出现下单按钮');
});

// ───────────────────────────────────────── 团餐

test('renderGroup: 演示数据下渲染出最优方案与拆单结论', async () => {
  const payload = await demoGroupPayload();
  const html = renderGroup(payload);
  const best = payload.result.best;

  assert.ok(html.length > 800, `HTML 太短（${html.length} B）`);
  assert.ok(html.includes(best.store.storeName.replace(/^麦当劳/, '')), '必须出现门店名');
  assert.ok(html.includes(`¥${(best.totals.price / 100).toFixed(2)}`), '必须出现实付');
  assert.match(html, /人均/);
  assert.match(html, /拆单结论/);
  assert.match(html, /金额怎么来的/);
  assert.match(html, /id="g-copy"/);
});

test('renderGroup: 没有方案时不崩，并给出提示', () => {
  const html = renderGroup({ demo: false, result: { best: null, warnings: ['该地址附近没有可配送的团餐门店（beType=6）。'] } });
  assert.match(html, /没有可用方案/);
  assert.match(html, /没有可配送的团餐门店/);
});

test('renderPhone / renderGroup: 空 payload 也不能白屏', () => {
  assert.match(renderPhone(null), /没有拿到结果/);
  assert.match(renderPhone({}), /没有拿到结果/);
  assert.match(renderGroup(undefined), /没有拿到结果/);
});

// ───────────────────────────────────────── fixture 本身的守门

test('fixtures: 真实快照里不能残留个人地址或 Token', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.startsWith('real-') && f.endsWith('.json'));
  assert.ok(files.length >= 1, '至少要有一份真实快照');
  for (const f of files) {
    const raw = readFileSync(path.join(FIXTURES, f), 'utf8');
    // 到店自取链路不含地址簿；万一以后加了麦乐送快照，也必须已脱敏
    assert.ok(!/125dABF5|Bearer\s+\w{10,}/.test(raw), `${f} 里疑似有 Token`);
    assert.ok(!/\d{11}/.test(raw), `${f} 里疑似有 11 位手机号`);
    const j = JSON.parse(raw);
    if (j.result?.address) {
      assert.match(j.result.address.fullAddress, /脱敏/, `${f} 的地址必须已脱敏`);
      assert.equal(j.result.address.addressId, 'REDACTED');
    }
    for (const c of j.result?.comparisons ?? []) assert.notEqual(c.addressId, undefined);
  }
});

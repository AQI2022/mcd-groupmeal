/**
 * 单元测试（零依赖，`node --test`）。
 * 覆盖三块最容易算错的地方：规则解析、拆单枚举/分配、分档约束。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTiers,
  productScope,
  lineParticipates,
  eligibleSubtotalCents,
  hitTier,
  discountOfRule,
  bestPromotionFor,
  isDiscountOnly,
  summarizeLadders,
  isRuleActive,
} from '../src/promotions.mjs';
import { partitionsOf, candidateSplits, splitItems, splitVerdict } from '../src/split.mjs';
import { tierFor, classify, BUDGET_TIERS } from '../src/tiers.mjs';
import { yuanToCents, formatCents, formatDiscountRate } from '../src/money.mjs';
import { extractJson, matchBrace } from '../src/json.mjs';
import { buildBaskets, buildPools } from '../src/basket.mjs';
import { demoMenu, demoCalculatePrice, DEMO_STORES, DEMO_PICKUP_STORES, DEMO_COUPON_ONLY_CODE, demoCoupons, MockClient } from '../src/mock.mjs';
import { buildCatalog, matchKeywords, couponPlans, priceCovers, solvePhoneOrder, renderPhoneCard, placeOrder, CHANNEL } from '../src/phone.mjs';
import { availableCoupons, campaignCalendar } from '../src/mcd.mjs';
import { optimize } from '../src/optimizer.mjs';
import { renderReport } from '../src/render.mjs';

// ---------------------------------------------------------------- 金额
test('money: 元→分 与展示', () => {
  assert.equal(yuanToCents('15.5'), 1550);
  assert.equal(yuanToCents(0.1), 10);
  assert.equal(yuanToCents(''), 0);
  assert.equal(formatCents(3760), '¥37.60');
  assert.equal(formatCents(-120), '−¥1.20');
  assert.equal(formatDiscountRate(26), '7.4折');
  assert.equal(formatDiscountRate(0), '10折');
});

test('money: 整数分加总不产生浮点误差', () => {
  const parts = Array.from({ length: 10 }, () => yuanToCents(0.1));
  const total = parts.reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.equal(formatCents(total), '¥1.00');
});

// ---------------------------------------------------------------- 规则解析
const RULE_DISCOUNT = {
  promotionId: 'R1',
  promotionType: '33',
  ruleCategory: 30,
  gmServiceCode: 'GMS001',
  startTime: '2025-01-01 00:00:00',
  endTime: '2030-01-01 00:00:00',
  products: [{ type: '2', productCode: 'X1' }],
  ruleDetail: { orderDiscount: { discount: '26', startDiscountPoint: '500' } },
};

test('promotions: 满折档位解析（门槛单位是元）', () => {
  const tiers = parseTiers(RULE_DISCOUNT);
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0].thresholdCents, 50000);
  assert.equal(tiers[0].percentOff, 26);
  assert.equal(tiers[0].kind, 'discount');
});

test('promotions: 满减档位解析并升序', () => {
  const rule = {
    ruleDetail: {
      orderReduce: {
        reduceInfo: [
          { startDiscountPoint: '600', reduceAmount: '120' },
          { startDiscountPoint: '200', reduceAmount: '30' },
          { startDiscountPoint: '100', reduceAmount: '10' },
        ],
      },
    },
  };
  const tiers = parseTiers(rule);
  assert.deepEqual(tiers.map((t) => t.thresholdCents), [10000, 20000, 60000]);
  assert.deepEqual(tiers.map((t) => t.reduceCents), [1000, 3000, 12000]);
});

test('promotions: products[].type=2 表示「不包含」', () => {
  const scope = productScope(RULE_DISCOUNT);
  assert.equal(scope.mode, 'exclude');
  assert.equal(lineParticipates(RULE_DISCOUNT, 'A'), true);
  assert.equal(lineParticipates(RULE_DISCOUNT, 'X1'), false);
  const lines = [
    { productCode: 'A', quantity: 2, unitPriceCents: 10000 },
    { productCode: 'X1', quantity: 1, unitPriceCents: 99900 },
  ];
  assert.equal(eligibleSubtotalCents(RULE_DISCOUNT, lines), 20000);
});

test('promotions: 未达门槛不给优惠，达门槛按最高档计算', () => {
  const lines = (qty) => [{ productCode: 'A', quantity: qty, unitPriceCents: 10000 }];
  assert.equal(discountOfRule(RULE_DISCOUNT, lines(4)).cents, 0); // ¥400 < ¥500
  assert.equal(discountOfRule(RULE_DISCOUNT, lines(5)).cents, 13000); // ¥500 × 26% = ¥130
  assert.equal(discountOfRule(RULE_DISCOUNT, lines(9)).cents, 23400); // ¥900 × 26%
});

test('promotions: 多档时取「门槛≤小计」中门槛最高的那档', () => {
  const rules = [
    RULE_DISCOUNT,
    { ...RULE_DISCOUNT, promotionId: 'R2', ruleDetail: { orderDiscount: { discount: '34', startDiscountPoint: '2000' } } },
    { ...RULE_DISCOUNT, promotionId: 'R3', ruleDetail: { orderDiscount: { discount: '22', startDiscountPoint: '300' } } },
  ];
  const lines = [{ productCode: 'A', quantity: 20, unitPriceCents: 10000 }]; // ¥2000
  const best = bestPromotionFor(rules, { gmServiceCode: 'GMS001', lines });
  assert.equal(best.rule.promotionId, 'R2');
  assert.equal(best.cents, 68000); // ¥2000 × 34%
});

test('promotions: 助餐档位不匹配的规则不参与', () => {
  const rules = [{ ...RULE_DISCOUNT, gmServiceCode: 'GMS002' }];
  const lines = [{ productCode: 'A', quantity: 20, unitPriceCents: 10000 }];
  assert.equal(bestPromotionFor(rules, { gmServiceCode: 'GMS001', lines }).cents, 0);
});

test('promotions: 过期规则被过滤', () => {
  const expired = { ...RULE_DISCOUNT, startTime: '2020-01-01 00:00:00', endTime: '2020-12-31 00:00:00' };
  assert.equal(isRuleActive(expired, new Date('2026-10-15T00:00:00Z')), false);
  assert.equal(isRuleActive(RULE_DISCOUNT, new Date('2026-10-15T00:00:00Z')), true);
});

test('promotions: 满折场景判定（决定「别拆」的口径）', () => {
  assert.equal(isDiscountOnly([RULE_DISCOUNT], 'GMS001'), true);
  const reduceRule = { ...RULE_DISCOUNT, ruleCategory: 40, ruleDetail: { orderReduce: { reduceInfo: [{ startDiscountPoint: '300', reduceAmount: '60' }] } } };
  assert.equal(isDiscountOnly([reduceRule], 'GMS001'), false);
});

test('promotions: 阶梯汇总按助餐档位分组并去重', () => {
  const rules = [
    RULE_DISCOUNT,
    { ...RULE_DISCOUNT, promotionId: 'R3', ruleDetail: { orderDiscount: { discount: '22', startDiscountPoint: '300' } } },
    { ...RULE_DISCOUNT, promotionId: 'R4', gmServiceCode: 'GMS002' },
  ];
  const summary = summarizeLadders(rules);
  assert.deepEqual(summary.map((s) => s.gmServiceCode), ['GMS001', 'GMS002']);
  assert.deepEqual(summary[0].tiers.map((t) => t.thresholdCents), [30000, 50000]);
});

// ---------------------------------------------------------------- 拆单
test('split: 整数拆分枚举正确', () => {
  // 生成顺序为「首项降序」，无序去重后应与手工枚举一致
  const p2 = partitionsOf(6, 2).map((x) => x.join('+')).sort();
  assert.deepEqual(p2, ['3+3', '4+2', '5+1']);
  assert.deepEqual(partitionsOf(6, 1), [[6]]);
  const p3 = partitionsOf(5, 3);
  assert.equal(p3.length, 2); // 3+1+1, 2+2+1
  assert.ok(p3.every((g) => g.reduce((a, b) => a + b, 0) === 5));
  assert.equal(partitionsOf(2, 3).length, 0); // 人数不足无法拆更多单
});

test('split: 候选拆法覆盖 k=2 与 k=3，且人数守恒', () => {
  const splits = candidateSplits(20, { maxOrders: 3, limitPerK: 6 });
  assert.ok(splits.length > 0);
  assert.ok(splits.some((s) => s.orderCount === 2));
  assert.ok(splits.some((s) => s.orderCount === 3));
  for (const s of splits) {
    assert.equal(s.groups.reduce((a, b) => a + b, 0), 20);
    assert.ok(s.groups.length === s.orderCount);
  }
  assert.ok(candidateSplits(2, { maxOrders: 3 }).every((s) => s.orderCount === 2));
  assert.equal(candidateSplits(1, { maxOrders: 3 }).length, 0);
});

test('split: 商品按人数比例分配到各单且数量守恒', () => {
  const items = [
    { productCode: 'A', quantity: 20, unitPriceCents: 1000 },
    { productCode: 'B', quantity: 20, unitPriceCents: 500 },
  ];
  const orders = splitItems(items, [15, 5]);
  assert.equal(orders.length, 2);
  const total = orders.flat().reduce((s, i) => s + i.quantity, 0);
  assert.equal(total, 40);
  for (const o of orders) assert.ok(o.every((i) => i.quantity > 0));
});

test('split: 诚实的拆单结论', () => {
  const worse = splitVerdict(50480, 53122, { discountOnly: true, orderCount: 3 });
  assert.equal(worse.shouldSplit, false);
  assert.equal(worse.headline, '别拆');
  assert.match(worse.reason, /满折/);

  const better = splitVerdict(40000, 38000, { discountOnly: false, orderCount: 2 });
  assert.equal(better.shouldSplit, true);
  assert.equal(better.deltaCents, 2000);

  const none = splitVerdict(40000, null, {});
  assert.equal(none.shouldSplit, false);
});

// ---------------------------------------------------------------- 分档
test('tiers: 官方五档边界', () => {
  assert.equal(tierFor(yuanToCents(19.99)).id, 'lt20');
  assert.equal(tierFor(yuanToCents(20)).id, '20-30');
  assert.equal(tierFor(yuanToCents(29.99)).id, '20-30');
  assert.equal(tierFor(yuanToCents(30)).id, '30-40');
  assert.equal(tierFor(yuanToCents(40)).id, '40-50');
  assert.equal(tierFor(yuanToCents(50)).id, 'gt50');
  assert.equal(tierFor(yuanToCents(999)).id, 'gt50');
  assert.equal(BUDGET_TIERS.length, 5);
});

test('tiers: 品类识别', () => {
  assert.ok(classify({ name: '巨无霸' }).has('burger'));
  assert.ok(classify({ name: '中薯条' }).has('fries'));
  assert.ok(!classify({ name: '中薯条' }).has('snack'));
  assert.ok(classify({ name: '可口可乐（中）' }).has('drink'));
  assert.ok(classify({ name: '奥利奥麦旋风' }).has('dessert'));
  assert.ok(classify({ name: '神秘新品' }).has('other'));
});

// ---------------------------------------------------------------- 篮子
test('basket: 生成的篮子满足分档约束且不超预算', () => {
  const menu = demoMenu();
  const { tier, baskets } = buildBaskets({ menu, people: 20, budgetPerPersonCents: yuanToCents(35), promotions: [], gmServiceCode: 'GMS001' });
  assert.equal(tier.id, '30-40');
  assert.ok(baskets.length >= 1);
  for (const b of baskets) {
    assert.ok(b.items.length >= 2, '至少要有汉堡 + 饮料');
    const kinds = new Set(b.items.map((i) => i.category));
    assert.ok(kinds.has('burger'));
    assert.ok(kinds.has('drink'));
    assert.ok(b.perHeadCents <= yuanToCents(35), `人均 ${b.perHeadCents} 不应超预算`);
  }
  const pools = buildPools(menu);
  assert.equal(pools.burger[0].name, '麦香鸡'); // 最便宜的汉堡
});

test('basket: 偏好关键词替换同类餐品', () => {
  const menu = demoMenu();
  const { baskets } = buildBaskets({ menu, people: 10, budgetPerPersonCents: yuanToCents(40), prefer: ['巨无霸'] });
  assert.ok(baskets.some((b) => b.items.some((i) => i.name === '巨无霸')));
});

// ---------------------------------------------------------------- MCP 返回体解析
test('json: 从「markdown + 内嵌 JSON + 尾随文字」里提取 JSON', () => {
  const mixed = '# 说明\n|{序号}|{data.addresses[].addressId}|\n尾注\n{"success":true,"code":200,"data":{"addresses":[{"addressId":"1"}]}}## 展示结果时…';
  const j = extractJson(mixed);
  assert.equal(j.success, true);
  assert.equal(j.data.addresses[0].addressId, '1');
});

test('json: 花括号嵌套与字符串内的括号不干扰配对', () => {
  const text = '前 `{a}` 中 {"success":true,"code":200,"data":{"s":"} 不是结尾 {","n":[1,2,{"x":3}]}} 后';
  const j = extractJson(text);
  assert.equal(j.code, 200);
  assert.equal(j.data.s, '} 不是结尾 {');
  assert.equal(matchBrace(text, text.indexOf('{"success"')), text.indexOf('"n":[1,2,{"x":3}]}}') + '"n":[1,2,{"x":3}]}}'.length - 1);
});

test('json: 纯 JSON 直接返回，无 JSON 时返回 null', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(extractJson('没有任何 JSON'), null);
  assert.equal(extractJson(''), null);
});

// ---------------------------------------------------------------- 离线定价器一致性
test('mock: 离线定价器复刻官方口径（用 2026-10-15 真实回执校准）', () => {
  const store = DEMO_STORES[0]; // GMS001: 满300→22% 满500→26%
  const menu = demoMenu();

  // 真实回执 A：西安大话南门餐厅，中薯条 ¥15 × 2 → 商品 ¥30 + 配送 ¥6 + 打包 ¥1.60 = 实付 ¥37.60，无优惠
  const cp2 = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 2 }] });
  assert.equal(menu.meals['1005'].currentPrice * 2, 3000);
  assert.equal(cp2.discount, 0);
  assert.equal(cp2.price, 3760);

  // 真实回执 B：同一门店，小计 ¥300 → 命中满 ¥300 档 22% off，实付 ¥246.00
  const cp20 = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 20 }] });
  assert.equal(cp20.discount, 30000 + 600 + 600 - cp20.price);
  assert.equal(cp20.price, 24600); // ¥300 − ¥66(22%) + ¥6 配送 + ¥6 打包
  assert.equal(cp20.enjoyable.balance, 20000); // 距满 ¥500 还差 ¥200
  assert.equal(cp20.enjoyable.realDiscount, 7.4); // 满 ¥500 档 = 7.4 折

  // 真实回执 C：小计 ¥510 → 命中满 ¥500 档 26% off，且已免配送费
  const cp34 = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 34 }] });
  assert.equal(cp34.deliveryPrice, 0);
  assert.equal(cp34.price, 51000 - 13260 + 0 + 900);
});

test('mock: 满折场景下拆单必定更贵（与真实引擎结论一致）', () => {
  const store = DEMO_STORES[0];
  const single = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 20 }] });
  const a = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 10 }] });
  const b = demoCalculatePrice({ store, gmServiceCode: 'GMS001', items: [{ productCode: '1005', quantity: 10 }] });
  assert.ok(a.price + b.price > single.price, '拆 2 单必须比不拆贵');
});

// ---------------------------------------------------------------- 手机点餐（phone）
test('phone: 券商品不在菜单里也必须能匹配到（券找货）', () => {
  const menu = demoMenu();
  const coupons = demoCoupons();
  const catalog = buildCatalog(menu, coupons);
  // 9001 美式中杯只存在于券里，菜单里没有
  assert.equal(menu.meals[DEMO_COUPON_ONLY_CODE], undefined);
  const hit = matchKeywords(catalog, ['美式中杯']);
  assert.equal(hit.picked.length, 1);
  assert.equal(hit.picked[0].item.code, DEMO_COUPON_ONLY_CODE);
  assert.equal(hit.picked[0].item.couponOnly, true);
  assert.equal(hit.picked[0].item.couponId, 'DEMO-C2');
});

test('phone: 关键词匹配优先完全相等，且未命中时给相近建议', () => {
  const catalog = buildCatalog(demoMenu(), demoCoupons());
  const a = matchKeywords(catalog, ['巨无霸', '中薯条']);
  assert.deepEqual(a.picked.map((p) => p.item.code), ['1001', '2001']);
  const b = matchKeywords(catalog, ['不存在的商品']);
  assert.equal(b.picked.length, 0);
  assert.equal(b.missing.length, 1);
});

test('phone: 单券组合不会顺带用上别的券', () => {
  const coupons = demoCoupons();
  const cart = [
    { productCode: '1001', quantity: 1, name: '巨无霸' },
    { productCode: DEMO_COUPON_ONLY_CODE, quantity: 1, name: '美式中杯', couponId: 'DEMO-C2', couponCode: 'DEMOCODE2' },
  ];
  const plans = couponPlans(cart, coupons);
  const onlyC1 = plans.find((p) => p.label.includes('巨无霸7折'));
  assert.equal(onlyC1.items.find((i) => i.productCode === '1001').couponId, 'DEMO-C1');
  assert.equal(onlyC1.items.find((i) => i.productCode === DEMO_COUPON_ONLY_CODE).couponId, undefined, '只用 C1 时不能挂 C2');
  const both = plans.find((p) => p.label.startsWith('全部'));
  assert.equal(both.items.find((i) => i.productCode === DEMO_COUPON_ONLY_CODE).couponId, 'DEMO-C2');
});

test('phone: priceCovers 识别「券商品被丢弃」的组合（防止假结论）', () => {
  const requested = [{ productCode: '1001', quantity: 1 }, { productCode: DEMO_COUPON_ONLY_CODE, quantity: 1 }];
  const dropped = { productList: [{ productCode: '1001', quantity: 1 }] };
  const full = { productList: [{ productCode: '1001', quantity: 1 }, { productCode: DEMO_COUPON_ONLY_CODE, quantity: 1 }] };
  assert.equal(priceCovers(dropped, requested), false);
  assert.equal(priceCovers(full, requested), true);
});

test('phone: 到店自取端到端（打烊门店被排除，最优方案用上券）', async () => {
  const client = new MockClient();
  const result = await solvePhoneOrder({
    client, channel: CHANNEL.PICKUP, city: '演示市', keyword: '演示路',
    want: ['巨无霸', '美式中杯'], couponFirst: false,
  });
  assert.equal(result.channel, CHANNEL.PICKUP);
  assert.equal(result.closed.length, 1, '打烊门店必须被列出来，而不是当成「没有菜单」');
  assert.equal(result.closed[0].storeCode, '9000004');
  assert.ok(result.comparisons.length >= 2);
  const best = result.best;
  assert.equal(best.best.complete, true, '最优方案必须买齐清单');
  // 巨无霸 24.00×0.7 = 16.80；美式中杯 19.00×0.5 = 9.50 → 26.30
  assert.equal(best.best.priceCents, 2630);
  assert.equal(best.best.couponTitles.length, 2);
  assert.equal(best.best.deliveryCents, 0, '到店自取没有配送费');
  assert.equal(best.noCouponComplete, false, '含券商品时「不用券」买不齐，不能当基线');
  assert.ok(best.couponOnlyItems.length === 1);
  // 所有金额都来自算价：卡面必须能渲染出实付
  const card = renderPhoneCard(result);
  assert.match(card, /实付 ¥26\.30/);
});

test('phone: maxStores 是「比价几家」而不是「扫描几家」——打烊门店不占名额', async () => {  // 真实场景：2026-10-15 23:57 西安，按距离最近的 3 家全部打烊，第 4 家才营业。
  // 若让打烊门店占用 maxStores 名额，用户会得到「一家都比不出来」的错误结论。
  class ClosedFirstMock extends MockClient {
    async callTool(name, args) {
      if (name === 'query-nearby-stores') {
        const rows = [...DEMO_PICKUP_STORES].sort((a, b) => (a.businessStatus === b.businessStatus ? 0 : a.businessStatus ? 1 : -1));
        return { ok: true, json: { success: true, code: 200, data: rows }, text: '', code: 200, message: '', tool: name, isError: false };
      }
      return super.callTool(name, args);
    }
  }
  const result = await solvePhoneOrder({
    client: new ClosedFirstMock(), channel: CHANNEL.PICKUP, city: '演示市', keyword: '演示路',
    want: ['巨无霸'], couponFirst: false, maxStores: 2, maxCalls: 40,
  });
  assert.equal(result.closed.length, 1, '打烊门店要如实列出来');
  assert.equal(result.closed[0].storeCode, '9000004');
  assert.equal(result.comparisons.length, 2, `打烊门店不能占用比价名额，实际比价 ${result.comparisons.length} 家`);
  assert.ok(result.stores.length >= 3, '扫描过的门店（含打烊的）都要出现在备选列表里');
});

test('phone: 麦乐送端到端（含配送+打包，且券后省得出来）', async () => {  const client = new MockClient();
  const result = await solvePhoneOrder({ client, channel: CHANNEL.DELIVERY, addressQuery: '演示', want: ['巨无霸', '中薯条'], couponFirst: false });
  assert.equal(result.channel, CHANNEL.DELIVERY);
  const b = result.best;
  // 巨无霸 24.00(券后 16.80) + 中薯条 15.00 = 31.80 商品 + 配送 6 + 打包 1.60
  assert.equal(b.best.productPriceCents, 3180);
  assert.equal(b.best.deliveryCents, 600);
  assert.equal(b.best.priceCents, 3940);
  assert.equal(b.couponSavingCents, 720, '比不用券省 = 24.00 × 30%');
  assert.equal(b.noCouponComplete, true);
});

test('phone: 自动配餐（不给 want）按预算砍项，且不超预算', async () => {
  const client = new MockClient();
  const result = await solvePhoneOrder({
    client, channel: CHANNEL.PICKUP, city: '演示市', keyword: '演示路',
    budgetCents: 3000, couponFirst: false,
  });
  assert.ok(result.best, '自动配餐也必须给出方案');
  assert.ok(result.best.best.items.length >= 1);
  assert.equal(result.best.overBudget, result.best.best.priceCents > 3000);
});

test('phone: 下单只创建订单、不支付（离线后端验证参数拼装）', async () => {
  const client = new MockClient();
  const result = await solvePhoneOrder({ client, channel: CHANNEL.PICKUP, city: '演示市', keyword: '演示路', want: ['巨无霸'], couponFirst: false });
  const order = await placeOrder(client, result.best);
  assert.equal(order.orderId, 'DEMO-ORDER-0001');
  assert.match(order.payH5Url, /^https:\/\//);
});

test('phone: 文字型工具（麦麦省券/活动日历）不会被误判为失败', async () => {
  const client = new MockClient();
  const avail = await availableCoupons(client);
  assert.equal(avail.ok, true);
  assert.equal(avail.kind, 'text');
  assert.ok(avail.titles.length >= 2, '必须从 Markdown 里解析出券名');
  const cal = await campaignCalendar(client);
  assert.equal(cal.ok, true);
  assert.ok(cal.titles.includes('演示活动-A'));
  // 非文字型工具仍然业务失败返回失败
  const bad = await client.callTool('query-meals', { storeCode: '9000004', beType: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 600057);
});

// ---------------------------------------------------------------- 团餐「没有方案」的契约

/** 团餐门店查询返回空：模拟「该地址附近没有可配送团餐门店」。 */
class NoStoreMock extends MockClient {
  async callTool(name, args) {
    if (name === 'delivery-query-stores') {
      return { ok: true, json: { success: true, code: 200, data: [] }, text: '', code: 200, message: '', tool: name, isError: false };
    }
    return super.callTool(name, args);
  }
}

test('团餐: 没有可用方案时返回完整形状（回归：早先会抛 headline 的 TypeError）', async () => {
  const result = await optimize({
    client: new NoStoreMock(),
    people: 20,
    budgetPerPersonCents: 3500,
    addresses: [{ addressId: 'DEMO', fullAddress: '演示市演示路 1 号' }],
  });

  assert.equal(result.best, null);
  assert.deepEqual(result.plans, []);
  // 这几个字段曾经只在「有方案」时才有，导致报告渲染直接崩掉
  assert.deepEqual(result.splitPlans, [], 'splitPlans 必须存在');
  assert.equal(result.verdict, null, 'verdict 必须存在（可为 null）');
  assert.deepEqual(result.savings, { vsSameStoreWorstCents: 0, vsNextStoreCents: 0 }, 'savings 必须存在');
  assert.equal(result.callsUsed, 0);
  assert.ok(result.warnings.some((w) => /团餐门店|可用方案/.test(w)), '要给出人能看懂的原因');

  // 关键断言：报告必须渲染成一句人话，而不是抛异常
  const text = renderReport(result, { people: 20, budgetPerPersonCents: 3500 });
  assert.match(text, /没有可配送的团餐门店|没有算出任何可用方案/);
  assert.match(text, /拆单结论：本次没有可比价方案/);
  assert.ok(!text.includes('undefined'), '报告里不能出现 undefined');
  assert.ok(!text.includes('NaN'), '报告里不能出现 NaN');
});

test('团餐: 报告渲染对残缺结果也要有防御（这是用户最后看到的东西）', () => {
  const text = renderReport(
    { address: null, stores: [], plans: [], best: null, warnings: ['演示告警'] },
    { people: 10, budgetPerPersonCents: 3000 },
  );
  assert.match(text, /（未知地址）/);
  assert.match(text, /没有算出任何可用方案/);
  assert.match(text, /演示告警/);
  assert.match(text, /本次共调用官方 calculate-price 0 次/);
});

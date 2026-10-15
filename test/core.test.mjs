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
import { demoMenu, demoCalculatePrice, DEMO_STORES } from '../src/mock.mjs';

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

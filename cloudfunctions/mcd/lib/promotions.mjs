/**
 * 满折 / 满减规则的解析与判定。
 *
 * 官方 `query-promotions` 的规则结构（实测）：
 *   {
 *     promotionId, promotionType: "33"(订单折扣) | "31"(满额减),
 *     ruleCategory: 30(满折) | 40(满减),
 *     gmServiceCode: "GMS001" | "GMS002" | "GMS003",
 *     startTime, endTime,
 *     products: [ { type: "1"(仅这些) | "2"(除这些) | "3"(全部), productCode } ],
 *     ruleDetail: {
 *       orderDiscount: { discount: "26", startDiscountPoint: "500" }        // 满 ¥500 → 减 26%（7.4 折）
 *       orderReduce:   { reduceInfo: [ { startDiscountPoint, reduceAmount } ] } // 满减阶梯
 *     }
 *   }
 *
 * 关键口径（**用官方 calculate-price 反证过**，见 docs/LIFELINE.md）：
 *   1. 满折的折扣只作用在**可参与商品小计**上，配送费/打包费不参与打折；
 *   2. `discount` 是「让利百分比」：26 → 付 74%（7.4 折）；
 *   3. `startDiscountPoint` 与 `reduceAmount` 的单位是**元**，不是分；
 *   4. 同一 gmServiceCode 下多档规则取「门槛 ≤ 小计」中门槛最高的那一档；
 *   5. `products[].type = "2"`（不包含）意味着折扣覆盖全单，**但要先剔除**这些商品。
 */
import { yuanToCents } from './money.mjs';

export const RULE_CATEGORY = { DISCOUNT: 30, REDUCE: 40 };
export const PRODUCT_SCOPE = { INCLUDE: '1', EXCLUDE: '2', ALL: '3' };

/** 规则是否在有效期内。 */
export function isRuleActive(rule, at = new Date()) {
  const parse = (s) => {
    if (!s) return null;
    const t = Date.parse(String(s).replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  };
  const from = parse(rule.startTime);
  const to = parse(rule.endTime);
  const now = at.getTime();
  if (from !== null && now < from) return false;
  if (to !== null && now > to) return false;
  return true;
}

/** 把 ruleDetail 归一化成统一档位表：[{ thresholdCents, percentOff?, reduceCents? }]（档次升序）。 */
export function parseTiers(rule) {
  const detail = rule?.ruleDetail ?? {};
  if (detail.orderDiscount) {
    const d = detail.orderDiscount;
    const threshold = yuanToCents(d.startDiscountPoint);
    if (threshold <= 0) return [];
    return [{ thresholdCents: threshold, percentOff: Number(d.discount) || 0, kind: 'discount' }];
  }
  if (detail.orderReduce?.reduceInfo) {
    const rows = Array.isArray(detail.orderReduce.reduceInfo) ? detail.orderReduce.reduceInfo : [];
    return rows
      .map((x) => ({
        thresholdCents: yuanToCents(x.startDiscountPoint),
        reduceCents: yuanToCents(x.reduceAmount),
        kind: 'reduce',
      }))
      .filter((x) => x.thresholdCents > 0)
      .sort((a, b) => a.thresholdCents - b.thresholdCents);
  }
  return [];
}

/** 规则的商品范围。 */
export function productScope(rule) {
  const list = Array.isArray(rule?.products) ? rule.products : [];
  if (!list.length) return { mode: 'all', codes: new Set() };
  const types = new Set(list.map((p) => String(p.type)));
  const codes = new Set(list.map((p) => String(p.productCode)));
  if (types.has(PRODUCT_SCOPE.ALL) || types.size > 1) return { mode: 'all', codes: new Set() };
  if (types.has(PRODUCT_SCOPE.INCLUDE)) return { mode: 'include', codes };
  if (types.has(PRODUCT_SCOPE.EXCLUDE)) return { mode: 'exclude', codes };
  return { mode: 'all', codes: new Set() };
}

/** 单行商品是否参与该规则。 */
export function lineParticipates(rule, productCode) {
  const scope = productScope(rule);
  if (scope.mode === 'all') return true;
  if (scope.mode === 'include') return scope.codes.has(String(productCode));
  return !scope.codes.has(String(productCode));
}

/**
 * 规则下的「可参与小计」。
 * @param {object} rule
 * @param {Array<{productCode:string, quantity:number, unitPriceCents:number}>} lines
 */
export function eligibleSubtotalCents(rule, lines) {
  let total = 0;
  for (const line of lines) {
    if (!lineParticipates(rule, line.productCode)) continue;
    total += Math.round(line.unitPriceCents) * Math.round(line.quantity);
  }
  return total;
}

/** 在给定小计下命中哪一档；未达最低门槛返回 null。 */
export function hitTier(rule, subtotalCents) {
  const tiers = parseTiers(rule);
  let hit = null;
  for (const t of tiers) if (subtotalCents >= t.thresholdCents) hit = t;
  return hit;
}

/** 单条规则在给定商品行下的优惠金额（分）。 */
export function discountOfRule(rule, lines) {
  const sub = eligibleSubtotalCents(rule, lines);
  const tier = hitTier(rule, sub);
  if (!tier) return { cents: 0, subtotalCents: sub, tier: null };
  if (tier.kind === 'discount') {
    return { cents: Math.round((sub * tier.percentOff) / 100), subtotalCents: sub, tier };
  }
  return { cents: Math.min(tier.reduceCents, sub), subtotalCents: sub, tier };
}

/**
 * 在某个助餐档位（gmServiceCode）下，选出对给定商品行最有利的一条规则。
 * 返回 { cents, rule, tier }，无可用规则时 cents = 0。
 */
export function bestPromotionFor(promotions, { gmServiceCode, lines, at = new Date() } = {}) {
  let best = { cents: 0, rule: null, tier: null, subtotalCents: 0 };
  for (const rule of promotions) {
    if (gmServiceCode && rule.gmServiceCode && rule.gmServiceCode !== gmServiceCode) continue;
    if (!isRuleActive(rule, at)) continue;
    const res = discountOfRule(rule, lines);
    if (res.cents > best.cents) best = { cents: res.cents, rule, tier: res.tier, subtotalCents: res.subtotalCents };
  }
  return best;
}

/**
 * 把某门店的规则整理成「助餐档位 → 折扣阶梯」的可读结构，用于渲染。
 * @returns {Array<{gmServiceCode, tiers: Array<{thresholdCents, percentOff?, reduceCents?, kind, promotionId}>}>}
 */
export function summarizeLadders(promotions, { at = new Date() } = {}) {
  const byService = new Map();
  for (const rule of promotions) {
    if (!isRuleActive(rule, at)) continue;
    const key = rule.gmServiceCode || '(默认)';
    if (!byService.has(key)) byService.set(key, []);
    for (const t of parseTiers(rule)) {
      byService.get(key).push({ ...t, promotionId: rule.promotionId, ruleCategory: rule.ruleCategory });
    }
  }
  const out = [];
  for (const [gmServiceCode, tiers] of byService) {
    tiers.sort((a, b) => a.thresholdCents - b.thresholdCents);
    // 同一门槛只保留让利最大的那一档
    const dedup = [];
    for (const t of tiers) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.thresholdCents === t.thresholdCents) {
        const better =
          (t.percentOff ?? 0) > (prev.percentOff ?? 0) || (t.reduceCents ?? 0) > (prev.reduceCents ?? 0);
        if (better) dedup[dedup.length - 1] = t;
        continue;
      }
      dedup.push(t);
    }
    out.push({ gmServiceCode, tiers: dedup });
  }
  out.sort((a, b) => a.gmServiceCode.localeCompare(b.gmServiceCode));
  return out;
}

/**
 * 满折场景下「拆单不可能更省」的数学判据。
 *
 * 若所有可用规则都是**按比例**打折（满折），且档位让利率随门槛单调不减，
 * 那么对任意拆分有：Σ pᵢ·(1−rᵢ) ≥ P·(1−R)（R 为整体命中档位，R ≥ max rᵢ）。
 * 再叠加拆单要重复支付配送费、并可能失去免配送费资格，结论必然是「别拆」。
 *
 * @returns {boolean} true 表示该门店在当前助餐档位下只存在满折规则
 */
export function isDiscountOnly(promotions, gmServiceCode) {
  const usable = promotions.filter(
    (r) => isRuleActive(r) && (!gmServiceCode || !r.gmServiceCode || r.gmServiceCode === gmServiceCode),
  );
  if (!usable.length) return false;
  return usable.every((r) => parseTiers(r).every((t) => t.kind === 'discount'));
}

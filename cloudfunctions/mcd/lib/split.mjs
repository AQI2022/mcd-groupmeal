/**
 * 拆单枚举。
 *
 * 业务定义：把「N 人份」的同一套搭配拆成 k 个独立订单（k ≤ 3），
 * 每个订单独立计算满减/满折（官方规则按**单笔订单**门槛触发），
 * 然后逐个用官方 `calculate-price` 验价。
 *
 * 为什么默认 k ≤ 3：拆单要重复支付配送费、并可能失去免配送费资格，
 * 且订单越多履约越复杂；k > 3 在实践中几乎不会翻盘。这是**有意的收紧**，
 * 不是能力上限（`--max-orders` 可调）。
 *
 * 关于「拆单到底省不省」——本项目不做无脑承诺：
 *   · 满减（ruleCategory=40）：拆单**可能**真赚（满 100 减 20 ×2 > 满 200 减 20）；
 *   · 满折（ruleCategory=30）：拆单在数学上**不可能**更省，只会更贵。
 * 详见 promotions.isDiscountOnly 与 docs/LIFELINE.md 的实测反证。
 */

/** n 拆成恰好 k 个正整数之和的所有方案（无序，降序排列）。 */
export function partitionsOf(n, k, { limit = Infinity } = {}) {
  const out = [];
  if (k <= 0 || n < k) return out;
  const rec = (remaining, parts, min) => {
    if (out.length >= limit) return;
    if (parts.length === k) {
      if (remaining === 0) out.push([...parts]);
      return;
    }
    for (let v = Math.min(remaining, min); v >= 1; v--) {
      parts.push(v);
      rec(remaining - v, parts, v);
      parts.pop();
      if (out.length >= limit) return;
    }
  };
  rec(n, [], n);
  return out;
}

/**
 * 生成候选拆法。
 * k=2 全量枚举；k=3 按「均衡度」排序后**等距抽样**，既覆盖均分也覆盖极端偏斜。
 * @returns {Array<{orderCount:number, groups:number[], balance:number}>}
 */
export function candidateSplits(people, { maxOrders = 3, limitPerK = 12 } = {}) {
  const out = [];
  for (let k = 2; k <= Math.max(1, maxOrders); k++) {
    if (people < k) continue;
    let all = partitionsOf(people, k);
    if (!all.length) continue;
    all.sort((a, b) => a[0] - a[a.length - 1] - (b[0] - b[b.length - 1]));
    if (all.length > limitPerK) {
      const step = all.length / limitPerK;
      const sampled = [];
      for (let i = 0; i < limitPerK; i++) sampled.push(all[Math.floor(i * step)]);
      all = sampled;
    }
    for (const groups of all) {
      out.push({ orderCount: k, groups, balance: groups[0] - groups[groups.length - 1] });
    }
  }
  return out;
}

/** 按人数分组，把篮子的商品按比例分配到各订单（余数给人数最多的那组）。 */
export function splitItems(basketItems, groups) {
  const total = groups.reduce((a, b) => a + b, 0);
  const orders = groups.map(() => []);
  const sortedIdx = groups.map((g, i) => i).sort((a, b) => groups[b] - groups[a]);
  for (const item of basketItems) {
    let assigned = 0;
    for (let i = 0; i < groups.length; i++) {
      const exact = (item.quantity * groups[i]) / total;
      const qty = i === groups.length - 1 ? item.quantity - assigned : Math.floor(exact);
      assigned += qty;
      if (qty > 0) orders[i].push({ ...item, quantity: qty });
    }
    // 余数补给最大的那单，避免出现 0 件订单
    if (assigned < item.quantity) {
      const target = orders[sortedIdx[0]];
      const last = target.find((x) => x.productCode === item.productCode);
      if (last) last.quantity += item.quantity - assigned;
      else target.push({ ...item, quantity: item.quantity - assigned });
    }
  }
  return orders.filter((o) => o.length && o.every((i) => i.quantity > 0));
}

/**
 * 拆单结论（诚实口径）。
 * @param {number} singlePriceCents 不拆的官方实付
 * @param {number|null} bestSplitPriceCents 最优拆法的官方实付
 * @param {{discountOnly:boolean, savedBySplit?:number}} ctx
 */
export function splitVerdict(singlePriceCents, bestSplitPriceCents, { discountOnly = false, orderCount = 0 } = {}) {
  if (bestSplitPriceCents === null || bestSplitPriceCents === undefined) {
    return { shouldSplit: false, deltaCents: 0, headline: '不拆', reason: '该门店在当前助餐档位下没有可用的拆单候选（人数不足或规则缺失）。' };
  }
  const delta = singlePriceCents - bestSplitPriceCents; // >0 表示拆单更省
  if (delta <= 0) {
    const reason = discountOnly
      ? `满折场景下拆分只会降低折扣档位（整体命中档位 R ≥ 任意子单档位 rᵢ，故 Σpᵢ(1−rᵢ) ≥ P(1−R)），并且要重复支付配送费。`
      : `已穷举 1~${orderCount || 3} 单的全部候选拆分，没有一种比不拆更便宜：多出来的配送费吃掉了档位收益。`;
    return { shouldSplit: false, deltaCents: delta, headline: '别拆', reason };
  }
  return {
    shouldSplit: true,
    deltaCents: delta,
    headline: '建议拆单',
    reason: `拆单更省：最优拆法比不拆少付 ¥${(delta / 100).toFixed(2)}（已由官方 calculate-price 逐个验价确认）。`,
  };
}

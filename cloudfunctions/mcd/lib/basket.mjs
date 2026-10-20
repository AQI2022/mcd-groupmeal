/**
 * 候选篮子生成。
 *
 * 输入：门店实时菜单 + 人数 + 人均预算（+ 偏好）。
 * 输出：若干个「每人份搭配 × 人数」的候选篮子，满足官方分档约束。
 *
 * 策略（可解释、可复现）：
 *   1. 先按官方分档确定「每人必须有哪几类」；
 *   2. 每类取**最便宜**的餐品组成基线篮子；
 *   3. 在不超过人均预算的前提下，贪心升级更贵的同类餐品，得到「均衡」「顶格」变体；
 *   4. 用本地规则模型估算实付做**预筛**，只有入选的篮子才会去调官方 `calculate-price`。
 *
 * 重要：本模块只做**预筛**。所有最终数字一律以官方 `calculate-price` 为准。
 */
import { CATEGORY, classify, tierFor, cnName } from './tiers.mjs';
import { bestPromotionFor } from './promotions.mjs';

const CATEGORY_BY_CN = {
  汉堡: CATEGORY.BURGER,
  薯条: CATEGORY.FRIES,
  小食: CATEGORY.SNACK,
  饮料: CATEGORY.DRINK,
  甜品: CATEGORY.DESSERT,
};

/** 按品类分池，池内按价格升序、同名去重。 */
export function buildPools(menu) {
  const pools = {};
  for (const meal of Object.values(menu.meals ?? {})) {
    if (!meal?.code || !(meal.currentPrice > 0)) continue;
    for (const cat of classify(meal)) (pools[cat] ??= []).push(meal);
  }
  for (const cat of Object.keys(pools)) {
    pools[cat].sort((a, b) => a.currentPrice - b.currentPrice || String(a.code).localeCompare(String(b.code)));
    const seen = new Set();
    pools[cat] = pools[cat].filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)));
  }
  return pools;
}

/** 估算配送费（分）。真实值以官方算价为准，这里只用于预筛。 */
function estimateDeliveryCents(subtotalCents) {
  return subtotalCents >= 30000 ? 0 : 600;
}

/** 估算打包服务费（分）。 */
function estimatePackingCents(totalQuantity) {
  return Math.min(900, Math.max(160, totalQuantity * 30));
}

/** 用本地规则模型估算一个篮子的实付（分）。仅用于预筛。 */
export function estimateBasket(basket, { promotions = [], gmServiceCode } = {}) {
  const lines = basket.items.map((i) => ({ productCode: i.productCode, quantity: i.quantity, unitPriceCents: i.unitPriceCents }));
  const subtotalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const promo = bestPromotionFor(promotions, { gmServiceCode, lines });
  const deliveryCents = estimateDeliveryCents(subtotalCents);
  const packingCents = estimatePackingCents(lines.reduce((s, l) => s + l.quantity, 0));
  return {
    subtotalCents,
    discountCents: promo.cents,
    deliveryCents,
    packingCents,
    priceCents: subtotalCents - promo.cents + deliveryCents + packingCents,
  };
}

/**
 * 生成候选篮子。
 * @param {object} opts
 * @param {{meals:object}} opts.menu
 * @param {number} opts.people
 * @param {number} opts.budgetPerPersonCents
 * @param {string[]} [opts.prefer] 偏好：品类名（汉堡/薯条/小食/饮料/甜品）或餐品名关键词
 * @param {number} [opts.variants] 每个助餐档位保留的篮子数，默认 3
 */
export function buildBaskets({ menu, people, budgetPerPersonCents, prefer = [], variants = 3, promotions = [], gmServiceCode } = {}) {
  const pools = buildPools(menu);
  const tier = tierFor(budgetPerPersonCents);
  const notes = [];

  // ---- 1) 每人份需求：官方分档 + oneOf 组择优
  const need = { ...tier.perPerson };
  if (tier.oneOf?.length) {
    let bestGroup = null;
    let bestCost = Infinity;
    for (const group of tier.oneOf) {
      let cost = 0;
      let ok = true;
      for (const cat of group) {
        const cheapest = pools[cat]?.[0];
        if (!cheapest) { ok = false; break; }
        cost += cheapest.currentPrice;
      }
      if (ok && cost < bestCost) { bestCost = cost; bestGroup = group; }
    }
    if (!bestGroup) {
      notes.push(`官方分档要求的「${tier.oneOf.map((g) => g.map(cnName).join('/')).join(' 或 ')}」在该门店菜单里没有可选项，已放宽约束`);
    } else {
      for (const cat of bestGroup) need[cat] = (need[cat] ?? 0) + 1;
    }
  }

  // ---- 2) 用户偏好
  const preferKeywords = [];
  for (const p of prefer) {
    const asCat = Object.values(CATEGORY).includes(p) ? p : CATEGORY_BY_CN[p];
    if (asCat) need[asCat] = Math.max(need[asCat] ?? 0, 1);
    else preferKeywords.push(String(p));
  }

  // ---- 3) 组合表：cat -> [{productCode, quantity}]
  const composition = {};
  for (const [cat, count] of Object.entries(need)) {
    const pool = pools[cat];
    if (!pool?.length) {
      notes.push(`菜单里没有「${cnName(cat)}」类餐品，已从约束中移除`);
      continue;
    }
    composition[cat] = [{ productCode: pool[0].code, quantity: (count || 1) * people }];
  }

  for (const kw of preferKeywords) {
    const hit = Object.values(menu.meals ?? {}).find((m) => m?.name?.includes(kw) && m.currentPrice > 0);
    if (!hit) { notes.push(`偏好「${kw}」在菜单里没找到，已忽略`); continue; }
    const cat = [...classify(hit)][0] ?? CATEGORY.OTHER;
    if (composition[cat]) composition[cat] = [{ productCode: hit.code, quantity: composition[cat][0].quantity }];
    else composition[cat] = [{ productCode: hit.code, quantity: people }];
  }

  // > ¥50 档：优先不重复小食
  if (tier.minDistinctSnacks && (pools[CATEGORY.SNACK]?.length ?? 0) >= tier.minDistinctSnacks) {
    const picks = pools[CATEGORY.SNACK].slice(0, tier.minDistinctSnacks);
    const each = Math.floor(people / picks.length);
    const rows = picks.map((m, i) => ({
      productCode: m.code,
      quantity: i === picks.length - 1 ? people - each * (picks.length - 1) : each,
    }));
    composition[CATEGORY.SNACK] = rows.filter((r) => r.quantity > 0);
  }

  const buildItems = (comp) => {
    const items = [];
    for (const [cat, rows] of Object.entries(comp)) {
      for (const row of rows) {
        const meal = menu.meals[row.productCode];
        if (!meal) continue;
        items.push({ productCode: row.productCode, name: meal.name, quantity: row.quantity, unitPriceCents: meal.currentPrice, category: cat });
      }
    }
    return items;
  };

  const makeBasket = (id, label, comp) => {
    const items = buildItems(comp);
    const basket = { id, label, tierId: tier.id, tierLabel: tier.label, items, notes: [...notes] };
    Object.assign(basket, estimateBasket(basket, { promotions, gmServiceCode }));
    basket.perHeadCents = people > 0 ? Math.round(basket.priceCents / people) : 0;
    return basket;
  };

  const candidates = [makeBasket('base', `最省基线（${tier.label}）`, composition)];

  // ---- 4) 贪心升级：每次挑「每人成本增量最小」的一档升上去，超预算即停
  const upgraded = JSON.parse(JSON.stringify(composition));
  for (const stopAfter of [3, 8]) {
    let applied = 0;
    while (applied < 8) {
      let best = null;
      for (const [cat, rows] of Object.entries(upgraded)) {
        const pool = pools[cat];
        if (!pool) continue;
        rows.forEach((row, idx) => {
          const pos = pool.findIndex((m) => m.code === row.productCode);
          const next = pool[pos + 1];
          if (!next) return;
          const delta = (next.currentPrice - pool[pos].currentPrice) * row.quantity;
          if (delta <= 0) return;
          const perHead = delta / people;
          if (!best || perHead < best.perHead) best = { cat, idx, next, perHead };
        });
      }
      if (!best) break;
      upgraded[best.cat][best.idx] = { ...upgraded[best.cat][best.idx], productCode: best.next.code };
      const probe = makeBasket('probe', 'probe', upgraded);
      if (probe.perHeadCents > budgetPerPersonCents) {
        // 回滚这一次升级，并停止
        const pool = pools[best.cat];
        const rows = upgraded[best.cat];
        const cur = rows[best.idx].productCode;
        const pos = pool.findIndex((m) => m.code === cur);
        rows[best.idx] = { ...rows[best.idx], productCode: pool[pos - 1].code };
        break;
      }
      applied += 1;
      if (applied === stopAfter) break;
    }
    const b = makeBasket(`up${stopAfter}`, stopAfter === 3 ? '均衡升级' : '预算顶格', upgraded);
    if (b.priceCents !== candidates[candidates.length - 1].priceCents) candidates.push(b);
  }

  // ---- 5) 去重 + 预筛
  const signature = (b) => b.items.map((i) => `${i.productCode}x${i.quantity}`).sort().join('|');
  const seen = new Set();
  const unique = candidates.filter((b) => (seen.has(signature(b)) ? false : (seen.add(signature(b)), true)));
  const within = unique.filter((b) => b.perHeadCents <= budgetPerPersonCents);
  const pool2 = within.length ? within : [unique[0]];

  // 保留：最省 + 最贵（预算内）+ 中间，最多 variants 个
  pool2.sort((a, b) => a.priceCents - b.priceCents);
  const picked = [pool2[0]];
  if (variants >= 3 && pool2.length >= 3) picked.push(pool2[Math.floor((pool2.length - 1) / 2)]);
  if (variants >= 2 && pool2.length >= 2) picked.push(pool2[pool2.length - 1]);
  const final = [];
  const seen2 = new Set();
  for (const b of picked) {
    if (seen2.has(signature(b))) continue;
    seen2.add(signature(b));
    final.push(b);
  }
  final.sort((a, b) => a.priceCents - b.priceCents);
  return { tier, baskets: final, pools, notes };
}

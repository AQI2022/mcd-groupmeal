/**
 * 跨门店 × 助餐档位 × 候选篮子 × 拆单 的求解器。
 *
 * 求解流程（每一步的数字来源都写在返回结构里）：
 *   ① 地址 → `delivery-query-stores{beType:6}` 得到全部可配送团餐门店
 *   ② 每店 → `query-meals` / `query-meal-assistance` / `query-promotions`（带 TTL 缓存）
 *   ③ 每店 × 每个可用助餐档位 × 每个候选篮子 → `calculate-price` 单笔验价
 *   ④ 对单笔最优的若干组合 → 枚举 k ≤ 3 拆单 → 逐个 `calculate-price` 验价
 *   ⑤ 按「人均实付」排序，取全局最优；同时给出拆单结论与凑单提示
 *
 * 所有金额以「分」为单位，全部来自官方 `calculate-price`（候选篮子的本地估算只用于预筛）。
 */
import { calculatePrice, listAddresses, queryGroupMealStores, loadStoreProfile, resolveAddress, TtlCache } from './mcd.mjs';
import { buildBaskets } from './basket.mjs';
import { isDiscountOnly, summarizeLadders, bestPromotionFor } from './promotions.mjs';
import { candidateSplits, splitItems, splitVerdict } from './split.mjs';

class CallBudget {
  constructor(max) {
    this.max = max;
    this.used = 0;
    this.exhausted = false;
  }
  spend(n = 1) {
    if (this.used + n > this.max) {
      this.exhausted = true;
      return false;
    }
    this.used += n;
    return true;
  }
}

/**
 * 「这次没有可用方案」的统一返回形状。
 *
 * 为什么必须统一：`--json`、CLI 报告、手机端界面都按同一套字段读结果。
 * 早先的两个提前返回漏了 `verdict` / `splitPlans` / `savings` / `callsUsed`，
 * 报告渲染时会直接抛 `Cannot read properties of undefined (reading 'headline')`——
 * 用户在手机上看到的是「比价失败」，而不是「这个地址现在没有可配送的团餐门店」。
 */
function noPlanResult({ address, stores = [], storeReports = [], warnings = [], callsUsed = 0 }) {
  return {
    address,
    stores,
    storeReports,
    plans: [],
    splitPlans: [],
    best: null,
    bestSplit: null,
    overallCheapestSplit: null,
    split: null,
    verdict: null,
    savings: { vsSameStoreWorstCents: 0, vsNextStoreCents: 0 },
    callsUsed,
    warnings,
  };
}

function totalsOf(pricedOrders) {
  const t = {
    productOriginalPrice: 0,
    productPrice: 0,
    discount: 0,
    deliveryPrice: 0,
    packingPrice: 0,
    originalPrice: 0,
    price: 0,
  };
  for (const o of pricedOrders) {
    for (const k of Object.keys(t)) t[k] += Number(o.price?.[k] ?? 0);
  }
  return t;
}

function makePlan({ id, store, assistance, basket, orders, source = 'calculate-price', note }) {
  const totals = totalsOf(orders);
  return {
    id,
    store: { storeCode: store.storeCode, beCode: store.beCode, storeName: store.storeName },
    assistance: assistance ? { gmServiceCode: assistance.gmServiceCode, gmServiceName: assistance.gmServiceName, serviceItems: assistance.serviceItems } : null,
    basketLabel: basket?.label ?? null,
    basketTier: basket?.tierLabel ?? null,
    orders,
    orderCount: orders.length,
    totals,
    savedCents: Math.max(0, totals.productOriginalPrice - totals.price),
    source,
    note,
  };
}

/**
 * @param {object} opts
 * @param {import('./mcp-client.mjs').McpClient} opts.client
 * @param {number} opts.people
 * @param {number} opts.budgetPerPersonCents
 * @param {Array} [opts.addresses]    已取到的地址簿（省一次调用）；不传则内部拉取
 * @param {string} [opts.addressQuery] 地址匹配文本（城市名/写字楼/完整地址）
 * @param {string[]} [opts.prefer]
 * @param {number} [opts.maxOrders]   拆单上限，默认 3
 * @param {number} [opts.variants]    每店候选篮子数，默认 3
 * @param {number} [opts.maxCalls]    calculate-price 调用硬上限，默认 150
 * @param {number} [opts.splitTopN]   对前 N 个单笔方案做拆单枚举，默认 3
 */
export async function optimize({
  client,
  people,
  budgetPerPersonCents,
  addresses,
  addressQuery,
  prefer = [],
  maxOrders = 3,
  variants = 3,
  maxCalls = 150,
  splitTopN = 3,
  cache = new TtlCache(),
  reservationDate,
  assistCodes,
  logger = () => {},
} = {}) {
  const warnings = [];
  const budget = new CallBudget(maxCalls);

  const book = addresses ?? (await listAddresses(client));
  if (!book.length) {
    const err = new Error(
      '账号地址簿为空：delivery-query-stores 只接受 addressId，而 addressId 只能来自账号地址簿。' +
        '请先在麦当劳 App / 小程序「我的 → 收货地址」里保存至少一个地址。',
    );
    err.code = 'EMPTY_ADDRESS_BOOK';
    throw err;
  }
  const address = resolveAddress(book, addressQuery);
  if (!address) {
    const err = new Error(`地址簿里找不到匹配「${addressQuery}」的地址（当前共 ${book.length} 条）`);
    err.code = 'ADDRESS_NOT_FOUND';
    throw err;
  }

  const stores = await queryGroupMealStores(client, address.addressId);
  if (!stores.length) {
    return noPlanResult({ address, warnings: ['该地址附近没有可配送的团餐门店（beType=6）。'] });
  }

  const storeReports = [];
  const singlePlans = [];

  for (const store of stores) {
    const profile = await loadStoreProfile(client, store, { addressId: address.addressId, cache, reservationDate });
    for (const d of profile.degraded ?? []) {
      warnings.push(`${store.storeName}：${d.label} 调用失败（${d.error}），该店按「${d.kind === 'promo' ? '无可用促销规则' : d.kind === 'assist' ? '无助餐档位' : '无菜单'}」降级处理。`);
    }
    const ladders = summarizeLadders(profile.promotions);
    const enabledAssist = profile.assistance.filter((a) => a.enable !== false);
    const usableAssist = assistCodes?.length
      ? profile.assistance.filter((a) => assistCodes.includes(a.gmServiceCode))
      : enabledAssist.length
        ? enabledAssist
        : profile.assistance;

    if (!usableAssist.length) warnings.push(`${store.storeName}：没有任何可用助餐档位（gmServiceCode），无法算价。`);
    if (!ladders.length) warnings.push(`${store.storeName}：query-promotions 没有返回有效规则，本店无满折/满减可用。`);

    const report = {
      store: { storeCode: store.storeCode, beCode: store.beCode, storeName: store.storeName, reservation: store.reservation },
      menuSize: Object.keys(profile.menu.meals).length,
      assistance: profile.assistance,
      ladders,
      discountOnly: isDiscountOnly(profile.promotions, usableAssist[0]?.gmServiceCode),
      plans: [],
    };

    for (const assist of usableAssist) {
      const { tier, baskets, notes } = buildBaskets({
        menu: profile.menu,
        people,
        budgetPerPersonCents,
        prefer,
        variants,
        promotions: profile.promotions,
        gmServiceCode: assist.gmServiceCode,
      });
      report.tier = tier?.label;
      report.basketNotes = notes;

      for (const basket of baskets) {
        if (!budget.spend(1)) {
          warnings.push(`已达单次运行调用上限（${maxCalls} 次 calculate-price），剩余候选未验价。`);
          break;
        }
        let price;
        try {
          price = await calculatePrice(client, {
            storeCode: store.storeCode,
            beCode: store.beCode,
            gmServiceCode: assist.gmServiceCode,
            addressId: address.addressId,
            items: basket.items.map((i) => ({ productCode: i.productCode, quantity: i.quantity })),
            reservationDate,
          });
        } catch (e) {
          warnings.push(`${store.storeName} / ${assist.gmServiceName}：算价失败 ${e.message}`);
          continue;
        }
        const plan = makePlan({
          id: `${store.storeCode}:${assist.gmServiceCode}:${basket.id}`,
          store,
          assistance: assist,
          basket,
          orders: [{ items: basket.items, gmServiceCode: assist.gmServiceCode, price }],
        });
        plan.totals.perHeadCents = Math.round(plan.totals.price / people);
        plan.totals.budgetCents = budgetPerPersonCents;
        plan.totals.overBudget = plan.totals.perHeadCents > budgetPerPersonCents;
        plan.totals.enjoyable = price.enjoyable;
        singlePlans.push(plan);
        report.plans.push(plan);
      }
    }
    storeReports.push(report);
  }

  if (!singlePlans.length) {
    return noPlanResult({
      address,
      stores,
      storeReports,
      warnings: warnings.concat('没有产出任何可用方案（门店可能不在营业时间，或没有可用助餐档位）。'),
      callsUsed: budget.used,
    });
  }

  // 单笔排序：先排「未超预算」，再按人均实付升序
  const ranked = [...singlePlans].sort((a, b) => {
    if (a.totals.overBudget !== b.totals.overBudget) return a.totals.overBudget ? 1 : -1;
    return a.totals.perHeadCents - b.totals.perHeadCents || a.totals.price - b.totals.price;
  });

  // ---- 拆单枚举：只对单笔最优的前 N 个组合做（控制调用量）
  const seenKey = new Set();
  const targets = [];
  for (const p of ranked) {
    const key = `${p.store.storeCode}:${p.assistance.gmServiceCode}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    targets.push(p);
    if (targets.length >= splitTopN) break;
  }

  const splitPlans = [];
  // 拆单枚举是最贵的部分：给每个目标门店分配一份调用预算，用完即收敛（宁少不超）
  const perTargetAllowance = Math.max(0, Math.floor((maxCalls - budget.used) / Math.max(1, targets.length)));
  let splitTruncated = false;
  for (const base of targets) {
    const profile = storeReports.find((r) => r.store.storeCode === base.store.storeCode);
    const discountOnly = !!profile?.discountOnly;
    const splits = candidateSplits(people, { maxOrders, limitPerK: 6 });
    const targetStart = budget.used;
    for (const sp of splits) {
      if (budget.used - targetStart + sp.orderCount > perTargetAllowance) {
        splitTruncated = true;
        break;
      }
      if (!budget.spend(sp.orderCount)) {
        splitTruncated = true;
        break;
      }
      const groups = splitItems(base.orders[0].items, sp.groups);
      if (groups.length < 2) continue;
      const priced = [];
      let failed = false;
      for (const items of groups) {
        try {
          const price = await calculatePrice(client, {
            storeCode: base.store.storeCode,
            beCode: base.store.beCode,
            gmServiceCode: base.assistance.gmServiceCode,
            addressId: address.addressId,
            items: items.map((i) => ({ productCode: i.productCode, quantity: i.quantity })),
            reservationDate,
          });
          priced.push({ items, gmServiceCode: base.assistance.gmServiceCode, price });
        } catch (e) {
          failed = true;
          warnings.push(`${base.store.storeName} 拆 ${sp.orderCount} 单（${sp.groups.join('+')}）算价失败：${e.message}`);
          break;
        }
      }
      if (failed) continue;
      const plan = makePlan({
        id: `${base.store.storeCode}:${base.assistance.gmServiceCode}:split${sp.orderCount}:${sp.groups.join('+')}`,
        store: { ...base.store },
        assistance: base.assistance,
        basket: { label: `${sp.groups.join(' + ')} 人`, tierLabel: base.basketTier },
        orders: priced,
        note: `按人数拆成 ${sp.orderCount} 单：${sp.groups.join(' + ')}`,
      });
      plan.totals.perHeadCents = Math.round(plan.totals.price / people);
      plan.totals.budgetCents = budgetPerPersonCents;
      plan.totals.overBudget = plan.totals.perHeadCents > budgetPerPersonCents;
      plan.basePlanId = base.id;
      plan.discountOnly = discountOnly;
      plan.personGroups = sp.groups;
      splitPlans.push(plan);
    }
    if (budget.used - targetStart > perTargetAllowance) {
      logger(`拆单枚举达到本次预算分配（${budget.used - targetStart} 次），已提前收敛。`);
    }
  }

  if (splitTruncated && !budget.exhausted) {
    warnings.push(`拆单枚举受调用预算限制已抽样收敛（每个门店最多 ${Math.max(0, perTargetAllowance)} 次算价），未覆盖全部拆分。`);
  }
  if (budget.exhausted) {
    warnings.push(`已达单次运行调用上限（${maxCalls} 次 calculate-price），后续候选未验价。`);
  }

  const bestSplit = splitPlans.length ? splitPlans.reduce((a, b) => (b.totals.price < a.totals.price ? b : a)) : null;
  const best = ranked[0];
  const bestSplitForBest = bestSplit && bestSplit.basePlanId === best.id ? bestSplit : (splitPlans.filter((p) => p.basePlanId === best.id).sort((a, b) => a.totals.price - b.totals.price)[0] ?? null);
  const bestProfile = storeReports.find((r) => r.store.storeCode === best.store.storeCode);
  const verdict = splitVerdict(best.totals.price, bestSplitForBest ? bestSplitForBest.totals.price : null, {
    discountOnly: !!bestProfile?.discountOnly,
    orderCount: maxOrders,
  });

  // 节省额：相对「同门店最差可用助餐档位的等价方案」与「次优门店方案」
  const sameStore = ranked.filter((p) => p.store.storeCode === best.store.storeCode);
  const sameStoreWorst = sameStore.reduce((a, b) => (b.totals.price > a.totals.price ? b : a), sameStore[0]);
  const nextBest = ranked.find((p) => p.id !== best.id) ?? null;

  return {
    address,
    stores,
    storeReports,
    plans: ranked,
    splitPlans: splitPlans.sort((a, b) => a.totals.price - b.totals.price),
    best,
    bestSplit: bestSplitForBest,
    overallCheapestSplit: bestSplit,
    verdict,
    savings: {
      vsSameStoreWorstCents: sameStoreWorst ? Math.max(0, sameStoreWorst.totals.price - best.totals.price) : 0,
      vsNextStoreCents: nextBest && nextBest.store.storeCode !== best.store.storeCode ? Math.max(0, nextBest.totals.price - best.totals.price) : 0,
    },
    callsUsed: budget.used,
    warnings,
  };
}

/**
 * 官方算价主动给出的「凑单提示」：距下一档折扣还差多少。
 * @returns {null|{gapCents:number, nextRate:number, nextPriceCents:number}}
 */
export function nudgeFromPlan(plan) {
  const e = plan?.totals?.enjoyable;
  if (!e || !e.balance || !e.realDiscount) return null;
  return { gapCents: e.balance, nextRate: e.realDiscount, currentDiscountCents: plan.totals.discount };
}

export { bestPromotionFor };

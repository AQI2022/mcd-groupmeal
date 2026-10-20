/**
 * 结果裁剪：把引擎的完整结果压成「界面真正用得到的字段」。
 *
 * 为什么需要它：微信云函数一次调用（`wx.cloud.callFunction`）的返回值有 1MB 级的上限，
 * 而团餐结果的 `storeReports` / 每个方案的 `orders[].price` 原始回执占了绝大部分体积，
 * 界面上一个都用不到。裁剪后通常只剩几 KB ~ 几十 KB。
 *
 * 注意：文字版报告（renderReport / renderPhoneCard）必须在裁剪**之前**生成，
 * 因为它们要读完整数据。裁剪只影响回传给小程序的对象。
 */

const KEEP_TOTALS = [
  'productOriginalPrice',
  'productPrice',
  'discount',
  'deliveryPrice',
  'packingPrice',
  'originalPrice',
  'price',
  'perHeadCents',
  'budgetCents',
  'overBudget',
];

function slimTotals(totals) {
  const out = {};
  if (!totals) return out;
  for (const k of KEEP_TOTALS) {
    if (totals[k] !== undefined && totals[k] !== null) out[k] = totals[k];
  }
  // 凑单提示要用：距下一档还差多少 / 下一档折扣
  if (totals.enjoyable) {
    out.enjoyable = { balance: totals.enjoyable.balance ?? null, realDiscount: totals.enjoyable.realDiscount ?? null };
  }
  return out;
}

function slimPlan(p) {
  if (!p) return null;
  return {
    id: p.id,
    store: p.store,
    assistance: p.assistance || null,
    basketLabel: p.basketLabel ?? null,
    basketTier: p.basketTier ?? null,
    orderCount: p.orderCount || 1,
    totals: slimTotals(p.totals),
    savedCents: p.savedCents || 0,
    note: p.note ?? null,
  };
}

/** 团餐结果 → 小程序需要的字段（plans / best / 拆单结论 / 提示）。 */
export function slimGroupResult(result) {
  if (!result) return result;
  return {
    address: result.address ?? null,
    stores: (result.stores ?? []).map((s) => ({ storeCode: s.storeCode, beCode: s.beCode, storeName: s.storeName })),
    plans: (result.plans ?? []).map(slimPlan),
    best: slimPlan(result.best),
    bestSplit: slimPlan(result.bestSplit),
    overallCheapestSplit: slimPlan(result.overallCheapestSplit),
    verdict: result.verdict ?? null,
    savings: result.savings ?? { vsSameStoreWorstCents: 0, vsNextStoreCents: 0 },
    callsUsed: result.callsUsed || 0,
    warnings: result.warnings ?? [],
  };
}

function slimComparison(c) {
  if (!c) return null;
  const best = c.best || {};
  return {
    channel: c.channel,
    addressId: c.addressId ?? null,
    store: c.store,
    menuSize: c.menuSize || 0,
    couponCount: c.couponCount || 0,
    coupons: c.coupons ?? [],
    items: c.items ?? [],
    couponOnlyItems: c.couponOnlyItems ?? [],
    best: {
      label: best.label ?? '',
      couponTitles: best.couponTitles ?? [],
      complete: !!best.complete,
      priceCents: best.priceCents ?? 0,
      productOriginalCents: best.productOriginalCents ?? 0,
      productPriceCents: best.productPriceCents ?? 0,
      discountCents: best.discountCents ?? 0,
      deliveryCents: best.deliveryCents ?? 0,
      packingCents: best.packingCents ?? 0,
      originalCents: best.originalCents ?? 0,
      enjoyable: best.enjoyable ?? null,
      // productList / takeWayList 只有下单用得上；云函数不能下单（无持久会话），故丢弃
      items: (best.items ?? []).map((it) => ({
        productCode: it.productCode,
        quantity: it.quantity,
        name: it.name,
        couponId: it.couponId ?? '',
        couponCode: it.couponCode ?? '',
      })),
    },
    noCouponCents: c.noCouponCents ?? null,
    noCouponComplete: !!c.noCouponComplete,
    goodsSavingCents: c.goodsSavingCents ?? 0,
    couponSavingCents: c.couponSavingCents ?? 0,
    overBudget: !!c.overBudget,
    autoNotes: c.autoNotes ?? [],
    degraded: !!c.degraded,
  };
}

/** 手机点餐结果 → 小程序需要的字段。 */
export function slimPhoneResult(result) {
  if (!result) return result;
  return {
    channel: result.channel,
    address: result.address ?? null,
    query: result.query ?? {},
    stores: (result.stores ?? []).map((s) => ({
      storeCode: s.storeCode,
      storeName: s.storeName,
      beCode: s.beCode,
      distance: s.distance ?? null,
      distanceText: s.distanceText ?? '',
    })),
    closed: result.closed ?? [],
    comparisons: (result.comparisons ?? []).map(slimComparison),
    best: slimComparison(result.best),
    addOns: result.addOns ?? [],
    availableCoupons: result.availableCoupons ?? null,
    warnings: result.warnings ?? [],
    callsUsed: result.callsUsed || 0,
  };
}

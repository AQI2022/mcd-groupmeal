/**
 * 「服务端结果对象 → 页面视图模型」的纯函数层。
 *
 * 刻意不引用 wx.*：这样这一层可以在 Node 里直接跑单测（test/miniprogram.test.mjs），
 * 页面的 .js 只负责 setData 和事件。金额一律来自服务端返回的「分」，这里只做格式化。
 */
const { yuan, percent, rate } = require('./money.js');

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function stripBrand(name) {
  return String(name || '').replace(/^麦当劳/, '');
}

function distanceOf(store) {
  if (!store) return '';
  if (store.distance !== null && store.distance !== undefined && store.distance !== '') return store.distance + 'm';
  return store.distanceText || '';
}

/** 团餐：同一门店 + 同一助餐档位只留最便宜的一篮，避免比价矩阵被候选篮子刷屏。 */
function storeRowsFromPlans(plans) {
  const map = new Map();
  arr(plans).forEach((p) => {
    if (!p || !p.store) return;
    const key = p.store.storeCode + ':' + (p.assistance ? p.assistance.gmServiceCode : '');
    const prev = map.get(key);
    if (!prev || num(p.totals && p.totals.price) < num(prev.totals && prev.totals.price)) map.set(key, p);
  });
  return Array.from(map.values())
    .slice()
    .sort((a, b) => num(a.totals.perHeadCents) - num(b.totals.perHeadCents))
    .map((p, i) => ({
      key: p.id || p.store.storeCode + ':' + i,
      storeName: p.store.storeName,
      assistName: p.assistance ? p.assistance.gmServiceName : '',
      basketLabel: p.basketLabel || '',
      priceText: yuan(num(p.totals.price)),
      perHeadText: yuan(num(p.totals.perHeadCents)),
      discountText: num(p.totals.discount) > 0 ? '−' + yuan(num(p.totals.discount)).replace('−', '') : '',
      isBest: i === 0,
    }));
}

function emptyGroupHint(result, warnings) {
  const stores = arr(result && result.stores);
  if (!stores.length) return '这个收货地址附近没有可配送的团餐门店（beType=6）。团餐门店是「可配送」口径，和普通外送门店不是同一批。';
  if (arr(result && result.warnings).some((w) => String(w).indexOf('营业时间') >= 0)) {
    return '门店可能不在营业时间（打烊时菜单接口返回空），换个时间或换一家门店再试。';
  }
  if (warnings && warnings.length) return warnings[0];
  return '没有产出可用方案：可能门店当前不在营业时间，或没有可用助餐档位。';
}

/** 团餐比价结果 → 视图模型。 */
function groupVM(result, params) {
  const p = params || {};
  const warnings = arr(result && result.warnings).map(String);
  const callsUsed = num(result && result.callsUsed);
  const addressText = result && result.address ? result.address.fullAddress || '' : '';

  if (!result) {
    return { kind: 'group', noPlan: true, headline: '没有拿到结果', hint: '服务端没有返回结果，请重试一次。', addressText: '', warnings: warnings, callsUsed: callsUsed, stores: [], plansCount: 0, split: null, savings: null, best: null };
  }

  const best = result.best;
  if (!best) {
    return {
      kind: 'group',
      noPlan: true,
      headline: result.verdict && result.verdict.headline ? result.verdict.headline : '这次没有可用方案',
      hint: emptyGroupHint(result, warnings),
      addressText: addressText,
      warnings: warnings,
      callsUsed: callsUsed,
      stores: [],
      plansCount: 0,
      split: null,
      savings: null,
      best: null,
    };
  }

  const t = best.totals || {};
  const budgetCents = num(t.budgetCents) || num(p.budgetPerPersonCents);
  const perHead = num(t.perHeadCents);
  const nudge =
    t.enjoyable && num(t.enjoyable.balance) > 0
      ? '再加 ' + yuan(num(t.enjoyable.balance)) + ' 可升到 ' + rate(t.enjoyable.realDiscount) + '（官方算价给出的客观提示，不是建议加购）'
      : '';

  const verdict = result.verdict || null;
  const bestSplit = result.bestSplit || null;
  const savings = result.savings || {};

  return {
    kind: 'group',
    noPlan: false,
    addressText: addressText,
    headline: '人均 ' + yuan(perHead) + (budgetCents ? '（预算 ' + yuan(budgetCents) + '）' : ''),
    overBudget: !!t.overBudget,
    callsUsed: callsUsed,
    storesScanned: arr(result.stores).length,
    plansCount: arr(result.plans).length,
    best: {
      storeName: best.store.storeName,
      assistName: best.assistance ? best.assistance.gmServiceName : '',
      orderCount: num(best.orderCount) || 1,
      basketLabel: best.basketLabel || '',
      productOriginalText: yuan(num(t.productOriginalPrice)),
      discountText: num(t.discount) > 0 ? '−' + yuan(num(t.discount)).replace('−', '') : '',
      savedPct: num(t.discount) > 0 ? percent(num(t.discount), num(t.productOriginalPrice)) : '0',
      deliveryText: yuan(num(t.deliveryPrice)),
      packingText: yuan(num(t.packingPrice)),
      showExtraFees: num(t.deliveryPrice) > 0 || num(t.packingPrice) > 0,
      priceText: yuan(num(t.price)),
      perHeadText: yuan(perHead),
      budgetText: budgetCents ? yuan(budgetCents) : '',
      nudgeText: nudge,
    },
    stores: storeRowsFromPlans(result.plans),
    split: verdict
      ? {
          headline: verdict.headline || '',
          shouldSplit: !!verdict.shouldSplit,
          reason: verdict.reason || '',
          deltaText: num(verdict.deltaCents) > 0 ? '差额 ' + yuan(num(verdict.deltaCents)) : '',
          bestSplitText: bestSplit ? num(bestSplit.orderCount) + ' 单 · 实付 ' + yuan(num(bestSplit.totals && bestSplit.totals.price)) : '',
        }
      : null,
    savings:
      num(savings.vsSameStoreWorstCents) > 0 || num(savings.vsNextStoreCents) > 0
        ? {
            vsSameStoreWorstText: num(savings.vsSameStoreWorstCents) > 0 ? '比同店最差助餐档位省 ' + yuan(num(savings.vsSameStoreWorstCents)) : '',
            vsNextStoreText: num(savings.vsNextStoreCents) > 0 ? '比次优门店省 ' + yuan(num(savings.vsNextStoreCents)) : '',
          }
        : null,
    warnings: warnings,
  };
}

/** 麦当劳 App 里的操作步骤（到店 / 麦乐送各一套）。 */
function stepsFor(result, best) {
  const bb = best.best || {};
  const couponTitles = arr(bb.couponTitles);
  const steps =
    result.channel === 'delivery'
      ? ['麦当劳 App → 麦乐送', '选门店：' + best.store.storeName, '选地址（与上面一致）', '加入清单里的商品']
      : ['麦当劳 App → 到店取餐', '选门店：' + best.store.storeName, '加入清单里的商品'];
  steps.push(couponTitles.length ? '结算页勾选：' + couponTitles.join('、') : '结算页核对金额');
  steps.push('核对实付 = ' + yuan(num(bb.priceCents)) + ' 再付款');
  return steps;
}

/** 手机点餐结果 → 视图模型。 */
function phoneVM(result, params) {
  const p = params || {};
  const warnings = arr(result && result.warnings).map(String);
  const callsUsed = num(result && result.callsUsed);
  const channel = result && result.channel === 'delivery' ? 'delivery' : 'pickup';
  const channelText = channel === 'delivery' ? '麦乐送（外送）' : '到店自取';
  const addressText = result && result.address ? result.address.fullAddress || '' : '';
  const q = (result && result.query) || {};
  const locationText = [q.city, q.keyword].filter((x) => x && x !== true).join(' ');
  const storesCount = arr(result && result.stores).length;
  const closed = arr(result && result.closed).map((c) => ({ storeName: c.storeName, reason: c.reason || '' }));
  const availableCoupons =
    result && result.availableCoupons
      ? { count: num(result.availableCoupons.count), titles: arr(result.availableCoupons.titles).slice(0, 6) }
      : null;
  const addOns = arr(result && result.addOns)
    .slice(0, 4)
    .map((a) => ({
      productName: a.productName,
      listPriceText: yuan(num(a.listPriceCents)),
      couponPriceText: yuan(num(a.couponPriceCents)),
      couponTitle: a.couponTitle || '',
      storeName: stripBrand(a.storeName),
    }));

  if (!result) {
    return {
      kind: 'phone',
      noPlan: true,
      channelText: channelText,
      headline: '没有拿到结果',
      hint: '服务端没有返回结果，请重试一次。',
      addressText: addressText,
      locationText: locationText,
      storesCount: 0,
      closedCount: 0,
      callsUsed: callsUsed,
      best: null,
      comparisons: [],
      addOns: [],
      availableCoupons: null,
      steps: [],
      closed: [],
      warnings: warnings,
    };
  }

  const best = result.best;
  if (!best) {
    return {
      kind: 'phone',
      noPlan: true,
      channelText: channelText,
      headline: closed.length ? '门店都打烊了' : '这次没有可比价的门店',
      hint: closed.length
        ? '按顺序扫过的门店当前都不在营业时间（' + closed.length + ' 家已排除）。换个时间，或把渠道换成麦乐送再试。'
        : '没有可比价的门店：到店自取需要「城市 + 位置关键词」，麦乐送需要账号里有收货地址。',
      addressText: addressText,
      locationText: locationText,
      storesCount: storesCount,
      closedCount: closed.length,
      callsUsed: callsUsed,
      best: null,
      comparisons: [],
      addOns: addOns,
      availableCoupons: availableCoupons,
      steps: [],
      closed: closed.slice(0, 5),
      warnings: warnings,
    };
  }

  const bb = best.best || {};
  const couponTitles = arr(bb.couponTitles);
  const couponOnlyCount = arr(best.couponOnlyItems).length;
  const couponHint = couponTitles.length
    ? '结算页勾选：' + couponTitles.join(' + ')
    : couponOnlyCount
      ? '⚠️ 本单含券专属商品，但没有可用券，可能买不到'
      : num(bb.discountCents) > 0
        ? '本单没用券，但门店自动优惠已计入'
        : '本单无可匹配的券';
  const savingText =
    num(best.couponSavingCents) > 0
      ? best.noCouponComplete
        ? '比不用券省 ' + yuan(num(best.couponSavingCents))
        : '券在商品上省了 ' + yuan(num(best.couponSavingCents)) + '（含券专属商品，无「不用券」可比基线）'
      : '';

  return {
    kind: 'phone',
    noPlan: false,
    channelText: channelText,
    addressText: addressText,
    locationText: locationText,
    storesCount: storesCount,
    closedCount: closed.length,
    callsUsed: callsUsed,
    best: {
      storeName: best.store.storeName,
      distanceText: distanceOf(best.store),
      items: arr(bb.items).map((it) => ({ name: it.name, coupon: !!it.couponId })),
      itemsNote: couponOnlyCount ? '🎟️ = 券专属商品：菜单里搜不到，只有用券才买得到' : '',
      couponsText: couponTitles.join(' + '),
      couponHint: couponHint,
      originalText: yuan(num(bb.productOriginalCents)),
      discountText: num(bb.discountCents) > 0 ? '−' + yuan(num(bb.discountCents)).replace('−', '') : '',
      showExtraFees: num(bb.deliveryCents) > 0 || num(bb.packingCents) > 0,
      deliveryText: yuan(num(bb.deliveryCents)),
      packingText: yuan(num(bb.packingCents)),
      priceText: yuan(num(bb.priceCents)),
      savingText: savingText,
      enjoyText:
        bb.enjoyable && num(bb.enjoyable.balance) > 0
          ? '再加 ' + yuan(num(bb.enjoyable.balance)) + ' 升到 ' + rate(bb.enjoyable.realDiscount) + '（客观提示，不是建议加购）'
          : '',
      autoNote: arr(best.autoNotes).length ? arr(best.autoNotes).join('；') : '',
    },
    comparisons: arr(result.comparisons).map((c, i) => ({
      key: c.store.storeCode + ':' + i,
      storeName: stripBrand(c.store.storeName),
      distanceText: distanceOf(c.store),
      priceText: yuan(num(c.best && c.best.priceCents)),
      couponSavingText: num(c.couponSavingCents) > 0 ? '券省 ' + yuan(num(c.couponSavingCents)) : '',
      isBest: i === 0,
    })),
    addOns: addOns,
    availableCoupons: availableCoupons,
    steps: stepsFor(result, best),
    closed: closed.slice(0, 5),
    warnings: warnings,
  };
}

module.exports = { groupVM, phoneVM, storeRowsFromPlans, emptyGroupHint };

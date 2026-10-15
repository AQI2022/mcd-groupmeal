/**
 * 手机点餐（到店自取 / 麦乐送）求解器 —— 「我在手机上点，怎么点最省」。
 *
 * 与团餐 `optimizer.mjs` 的区别：
 *   · 团餐回答「一群人怎么点最省」（跨门店 × 助餐档位 × 拆单）；
 *   · 这里回答「我一个人/小单在手机上点，选哪家店、用哪张券、点哪些、实付多少」。
 *
 * 链路（每一步的数字来源都在返回结构里）：
 *   ① 门店：到店自取走 `query-nearby-stores`（城市+关键词，**不需要地址簿**）；
 *           麦乐送走 `delivery-query-addresses` → `delivery-query-stores{beType:2}`
 *   ② 每店 → `query-meals`（菜单与菜价）+ `query-store-coupons`（本账号在该店可用的券）
 *   ③ 想吃什么 → 在「菜单 ∪ 券商品」里匹配（券专属商品不在菜单里，必须从券里取）
 *   ④ 候选（无券 / 单券 / 全券）逐个 `calculate-price` 验价，取实付最低
 *   ⑤ 输出手机竖屏可读的「点餐卡」：门店 → 券 → 清单 → 实付 → App 里怎么点
 *
 * 所有金额以「分」为单位，且**全部来自官方 `calculate-price`**；本地只用菜价做匹配与预筛。
 */
import { yuanToCents, formatCents } from './money.mjs';
import {
  BE_TYPE,
  ORDER_TYPE,
  CLOSED_STORE_CODE,
  availableCoupons,
  calculatePrice,
  createOrder,
  isCouponActive,
  listAddresses,
  queryDeliveryStores,
  queryMealsWithStatus,
  queryNearbyStores,
  queryStoreCoupons,
  resolveAddress,
} from './mcd.mjs';

export const CHANNEL = {
  PICKUP: 'pickup', // 到店自取（beType=1，orderType=1，不传 beCode）
  DELIVERY: 'delivery', // 麦乐送（beType=2，orderType=2，必传 beCode）
};

/** 归一化文本：去空格、全角括号、大小写，便于中文菜名匹配。 */
export function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]·、,，.。!！?？"'“”‘’]/g, '')
    .replace(/™/g, '');
}

/**
 * 把「菜单」与「券里的商品」合成一个可点目录。
 *
 * ⚠️ 关键实测事实：券里的商品码**可能不在菜单里**（如「新人专享-中杯美式7折」的 9900000119 美式中杯），
 * 且不带券对它算价返回 0 —— 它是券专属商品。所以目录必须并上券商品，否则「美式中杯」永远匹配不到。
 */
export function buildCatalog(menu, coupons = []) {
  const entries = new Map();
  for (const m of Object.values(menu?.meals ?? {})) {
    entries.set(m.code, { code: m.code, name: m.name, priceCents: m.currentPrice ?? null, couponOnly: false, couponId: '', couponCode: '', couponTitle: '' });
  }
  for (const c of coupons) {
    for (const p of c.products ?? []) {
      if (!p.productCode) continue;
      if (entries.has(p.productCode)) continue;
      entries.set(p.productCode, {
        code: p.productCode,
        name: p.productName || '(券商品)',
        priceCents: null, // 菜单里没有 => 本地无价，必须靠 calculate-price
        couponOnly: true,
        couponId: c.couponId,
        couponCode: c.couponCode,
        couponTitle: c.title,
      });
    }
  }
  return [...entries.values()];
}

/**
 * 关键词 → 目录条目的匹配。
 * 打分：完全相等 1000 + 长度；包含 500 + 长度；否则逐字命中（>=2 字词才算）。
 * 返回 { picked:[{keyword,item}], missing:[{keyword,suggestions[]}] }
 */
export function matchKeywords(catalog, keywords = []) {
  const picked = [];
  const missing = [];
  for (const raw of keywords) {
    const q = normText(raw);
    if (!q) continue;
    let best = null;
    for (const item of catalog) {
      const name = normText(item.name);
      let score = 0;
      if (name === q) score = 1000 + q.length;
      else if (name.includes(q)) score = 500 + q.length;
      else if (String(item.code) === String(raw).trim()) score = 900;
      else {
        let hit = 0;
        for (const ch of q) if (name.includes(ch)) hit += 1;
        if (hit === q.length && q.length >= 2) score = 200 + hit;
      }
      if (!score) continue;
      // 同分优先「更便宜 / 名字更短」的常规商品，避免匹配到礼盒装
      const better = !best || score > best.score || (score === best.score && (item.priceCents ?? 1e9) < (best.item.priceCents ?? 1e9));
      if (better) best = { score, item };
    }
    if (best) picked.push({ keyword: raw, item: best.item });
    else missing.push({ keyword: raw, suggestions: suggestKeywords(catalog, q, 3) });
  }
  // 同一商品被多个关键词命中时只保留一次
  const seen = new Set();
  const dedup = [];
  for (const p of picked) {
    if (seen.has(p.item.code)) continue;
    seen.add(p.item.code);
    dedup.push(p);
  }
  return { picked: dedup, missing };
}

function suggestKeywords(catalog, q, limit) {
  const scored = catalog
    .map((item) => {
      const name = normText(item.name);
      let hit = 0;
      for (const ch of q) if (name.includes(ch)) hit += 1;
      return { item, hit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit);
  return scored.slice(0, limit).map((x) => x.item.name);
}

/** 自动配餐（用户没说要吃什么）：主食 + 小食 + 饮料，按预算从后往前砍。 */
export function autoPickCatalog(catalog, { budgetCents } = {}) {
  const inStock = catalog.filter((c) => !c.couponOnly && c.priceCents > 0);
  const pick = (re) => inStock.filter((c) => re.test(c.name)).sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
  /** 先按主口径挑，挑不到再放宽（避免把「鸡排」当主食、把「冰淇淋」当小食）。 */
  const tiered = (primary, fallback) => pick(primary) ?? (fallback ? pick(fallback) : null);
  const main = tiered(/汉堡|堡|卷|麦香|麦香鱼|饭/, /鸡腿|鸡排/);
  const side = tiered(/薯条|薯饼|鸡块|鸡翅|玉米|苹果|派/, /冰淇淋|新地|麦旋风|甜品/);
  const drink = tiered(/可乐|雪碧|橙汁|饮品|茶|水/, /咖啡|拿铁|美式|奶/);
  const items = [main, side, drink].filter(Boolean);
  const notes = [];
  const total = items.reduce((s, i) => s + (i.priceCents ?? 0), 0);
  if (budgetCents && total > budgetCents) {
    if (drink) {
      items.pop();
      notes.push(`按预算去掉饮料（${drink.name}）`);
    }
    const t2 = items.reduce((s, i) => s + (i.priceCents ?? 0), 0);
    if (budgetCents && t2 > budgetCents && side) {
      items.pop();
      notes.push(`仍超预算，再去掉小食（${side.name}）`);
    }
  }
  return { items, notes };
}

/** 目录条目 → calculate-price 的 items（券商品必须挂券）。 */
function toCartItems(picked) {
  return picked.map(({ item }) => {
    const row = { productCode: item.code, quantity: 1, name: item.name };
    if (item.couponOnly && item.couponId) {
      row.couponId = item.couponId;
      row.couponCode = item.couponCode;
      row.couponTitle = item.couponTitle;
    }
    return row;
  });
}

/**
 * 这份算价结果是否**真的买到了清单里的所有商品**。
 *
 * 为什么必须判：券专属商品（菜单里没有、不带券算价为 0 的商品）在「不用券」组合里会被官方
 * 直接丢弃 —— 于是「不用券」反而更便宜。若不做完整性校验，比价会得出
 * 「别用券更省」这种**假结论**（因为那份组合里少了一个商品）。
 */
export function priceCovers(price, requested) {
  const list = price?.productList ?? [];
  return requested.every((req) => {
    const hit = list.find((p) => String(p.productCode) === String(req.productCode));
    return !!hit && Number(hit.quantity ?? 0) >= Number(req.quantity ?? 1);
  });
}

/** 生成本次要试的用券组合：无券 / 单张券 / 全部可用券。 */
export function couponPlans(cartItems, coupons, { at = new Date() } = {}) {
  const strip = (it) => ({ ...it, couponId: undefined, couponCode: undefined });
  const attach = (it, c) => ({ ...strip(it), couponId: c.couponId, couponCode: c.couponCode });
  const active = coupons.filter((c) => isCouponActive(c, at) && c.couponId);
  const applicable = active.filter((c) => cartItems.some((it) => (c.products ?? []).some((p) => p.productCode === it.productCode)));
  const plans = [{ label: '不用券', couponTitles: [], items: cartItems.map(strip) }];
  // ⚠️ 单券组合必须**清掉其它券**：否则「只用 A 券」的组合里还挂着 B 券，
  // 会把 B 券的优惠算进 A 券头上，得出错误的「哪张券最值」结论。
  for (const c of applicable) {
    plans.push({
      label: c.title,
      couponTitles: [c.title],
      items: cartItems.map((it) => ((c.products ?? []).some((p) => p.productCode === it.productCode) ? attach(it, c) : strip(it))),
    });
  }
  if (applicable.length > 1) {
    plans.push({
      label: `全部 ${applicable.length} 张券一起用`,
      couponTitles: applicable.map((c) => c.title),
      items: cartItems.map((it) => {
        const hit = applicable.find((c) => (c.products ?? []).some((p) => p.productCode === it.productCode));
        return hit ? attach(it, hit) : strip(it);
      }),
    });
  }
  return plans;
}

/** 券专属商品（菜单里没有、只能用券买）单独试价，作为「可解锁商品」提示，不计入最优方案。 */
async function probeCouponOnlyAddOns({ client, store, coupons, cartCodes, orderType, beType, addressId, reservationDate, maxCalls, budget }) {
  const out = [];
  for (const c of coupons) {
    if (!isCouponActive(c) || !c.couponId) continue;
    for (const p of c.products ?? []) {
      if (!p.productCode || cartCodes.has(p.productCode)) continue;
      if (out.some((x) => x.productCode === p.productCode)) continue;
      if (out.length >= 4) return out;
      if (!budget.spend(1)) return out;
      try {
        const price = await calculatePrice(client, {
          storeCode: store.storeCode, beCode: store.beCode, gmServiceCode: undefined,
          addressId, orderType, beType, reservationDate,
          items: [{ productCode: p.productCode, quantity: 1, couponId: c.couponId, couponCode: c.couponCode }],
        });
        if (!price.productList.length || price.price <= 0) continue;
        out.push({
          storeName: store.storeName,
          couponTitle: c.title,
          productCode: p.productCode,
          productName: price.productList[0]?.productName || p.productName,
          listPriceCents: price.productOriginalPrice,
          // 只报**商品价**：配送费/打包费是整单口径，不能挂到单个商品上
          couponPriceCents: price.productPrice,
          savedCents: Math.max(0, price.productOriginalPrice - price.productPrice),
        });
      } catch {
        /* 单个商品试价失败不影响主流程 */
      }
    }
  }
  return out;
}

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
 * 手机点餐主求解器。
 *
 * @param {object} opts
 * @param {object} opts.client
 * @param {'pickup'|'delivery'} [opts.channel]
 * @param {string} [opts.addressQuery]  麦乐送：地址关键词（城市/写字楼）
 * @param {string} [opts.city]          到店：城市名
 * @param {string} [opts.keyword]       到店：位置关键词
 * @param {string[]} [opts.want]        想吃的关键词，如 ['巨无霸','中杯美式','薯条']
 * @param {number} [opts.budgetCents]   单人预算（分，可选；自动配餐时用于砍项）
 * @param {number} [opts.maxStores]
 * @param {number} [opts.maxCalls]
 * @param {boolean} [opts.couponFirst]  是否探测「券专属商品」（默认 true）
 * @param {boolean} [opts.includeClosed] 是否也尝试打烊门店（默认 false，打烊店会被跳过并列出）
 */
export async function solvePhoneOrder({
  client,
  channel = CHANNEL.PICKUP,
  addressQuery,
  city,
  keyword,
  want = [],
  budgetCents,
  maxStores = 5,
  maxCalls = 60,
  couponFirst = true,
  includeClosed = false,
  cache,
  reservationDate,
  logger = () => {},
} = {}) {
  const warnings = [];
  const budget = new CallBudget(maxCalls);
  const at = new Date();

  // ① 门店
  let address = null;
  let storeList = [];
  if (channel === CHANNEL.DELIVERY) {
    const book = await listAddresses(client);
    if (!book.length) {
      const err = new Error('账号地址簿为空：麦乐送查询只接受 addressId，请先在麦当劳 App 里保存地址。');
      err.code = 'EMPTY_ADDRESS_BOOK';
      throw err;
    }
    address = resolveAddress(book, addressQuery);
    if (!address) {
      const err = new Error(`地址簿里找不到匹配「${addressQuery}」的地址（共 ${book.length} 条）`);
      err.code = 'ADDRESS_NOT_FOUND';
      throw err;
    }
    storeList = await queryDeliveryStores(client, address.addressId, { beType: BE_TYPE.DELIVERY });
  } else {
    const nearby = await queryNearbyStores(client, { beType: BE_TYPE.PICKUP, city, keyword });
    storeList = nearby.stores;
    logger(`到店门店搜索：searchType=${nearby.searchType}，命中 ${storeList.length} 家`);
  }

  if (!storeList.length) {
    return {
      channel, address, query: { city, keyword, addressQuery }, stores: [], closed: [], comparisons: [], best: null, addOns: [],
      availableCoupons: null, warnings: ['没有找到可点餐的门店。到店自取需要同时给 --city 与 --keyword（例如 --city 西安市 --keyword 长安大厦）。'],
      callsUsed: 0,
    };
  }

  const candidates = storeList.slice(0, maxStores);
  const orderType = channel === CHANNEL.DELIVERY ? ORDER_TYPE.DELIVERY : ORDER_TYPE.IN_STORE;
  const beType = channel === CHANNEL.DELIVERY ? BE_TYPE.DELIVERY : BE_TYPE.PICKUP;

  const comparisons = [];
  const closed = [];
  const addOns = [];

  for (const store of candidates) {
    const mealsRes = await queryMealsWithStatus(client, { storeCode: store.storeCode, beCode: store.beCode, orderType, beType });
    const isClosed = !mealsRes.ok && mealsRes.code === CLOSED_STORE_CODE;
    if (!mealsRes.ok && !isClosed) {
      warnings.push(`${store.storeName}：菜单拉取失败 code=${mealsRes.code ?? '?'} ${mealsRes.message ?? ''}（该店跳过）`);
      continue;
    }
    if (isClosed && !includeClosed) {
      closed.push({ storeCode: store.storeCode, storeName: store.storeName, distance: store.distance ?? null, reason: mealsRes.message || '门店可能已关闭或不在营业时间' });
      continue;
    }

    const menu = mealsRes.menu;
    let coupons = [];
    try {
      coupons = await queryStoreCoupons(client, { storeCode: store.storeCode, beCode: store.beCode, orderType, beType, reservationDate });
    } catch (e) {
      warnings.push(`${store.storeName}：门店券查询失败（${e.message}），本店按「无可用券」处理。`);
    }
    const activeCoupons = coupons.filter((c) => isCouponActive(c, at));

    // ③ 想吃什么
    const catalog = buildCatalog(menu, activeCoupons);
    let picked;
    let autoNotes = [];
    if (want.length) {
      const m = matchKeywords(catalog, want);
      picked = m.picked;
      for (const miss of m.missing) {
        warnings.push(`${store.storeName}：没找到「${miss.keyword}」${miss.suggestions.length ? `（相近的有：${miss.suggestions.join('、')}）` : ''}`);
      }
    } else {
      const auto = autoPickCatalog(catalog, { budgetCents });
      picked = auto.items.map((item) => ({ keyword: '(自动配餐)', item }));
      autoNotes = auto.notes;
    }
    if (!picked.length) continue;

    const cart = toCartItems(picked);
    const requested = cart.map((c) => ({ productCode: c.productCode, quantity: c.quantity }));

    // ④ 逐个用券组合验价
    const plans = couponPlans(cart, activeCoupons, { at });
    const priced = [];
    for (const plan of plans) {
      if (!budget.spend(1)) {
        warnings.push(`已达调用上限（${maxCalls} 次算价），${store.storeName} 的部分用券组合未验价。`);
        break;
      }
      try {
        const price = await calculatePrice(client, {
          storeCode: store.storeCode,
          beCode: store.beCode,
          addressId: address?.addressId,
          orderType,
          beType,
          reservationDate,
          items: plan.items.map((it) => ({
            productCode: it.productCode, quantity: it.quantity, couponId: it.couponId, couponCode: it.couponCode,
          })),
        });
        priced.push({ label: plan.label, couponTitles: plan.couponTitles, items: plan.items, price, complete: priceCovers(price, requested) });
      } catch (e) {
        warnings.push(`${store.storeName}／${plan.label}：算价失败 ${e.message}`);
      }
    }
    if (!priced.length) continue;

    // 只在「真的买齐了清单」的组合里挑最省；否则退回全部组合并明确告警
    const complete = priced.filter((p) => p.complete);
    const pool = complete.length ? complete : priced;
    if (!complete.length) {
      warnings.push(`${store.storeName}：所有用券组合都没能买齐清单（可能缺货），下面的价格仅供参考。`);
    }
    const best = pool.reduce((a, b) => (b.price.price < a.price.price ? b : a));
    const noCoupon = priced.find((p) => p.label === '不用券') ?? null;
    const couponOnlyInCart = picked.filter((p) => p.item.couponOnly);
    const baselineCents = noCoupon && noCoupon.complete ? noCoupon.price.price : null;
    const goodsSavingCents = Math.max(0, best.price.productOriginalPrice - best.price.productPrice);
    comparisons.push({
      channel,
      addressId: address?.addressId ?? null,
      store: {
        storeCode: store.storeCode,
        beCode: store.beCode,
        storeName: store.storeName,
        address: store.address,
        distance: store.distance ?? null,
        distanceText: store.distanceText ?? '',
        businessStartTime: store.businessStartTime,
        businessEndTime: store.businessEndTime,
        reservation: !!store.reservation,
      },
      menuSize: Object.keys(menu.meals).length,
      couponCount: activeCoupons.length,
      coupons: activeCoupons.map((c) => ({ title: c.title, couponId: c.couponId, couponCode: c.couponCode, tradeDateTime: c.tradeDateTime })),
      items: picked.map((p) => ({
        keyword: p.keyword,
        productCode: p.item.code,
        productName: p.item.name,
        couponOnly: !!p.item.couponOnly,
        couponTitle: p.item.couponOnly ? p.item.couponTitle : '',
      })),
      couponOnlyItems: couponOnlyInCart.map((p) => ({ productCode: p.item.code, productName: p.item.name, couponTitle: p.item.couponTitle })),
      plans: priced.map((p) => ({
        label: p.label,
        couponTitles: p.couponTitles,
        complete: p.complete,
        priceCents: p.price.price,
        productPriceCents: p.price.productPrice,
        discountCents: p.price.discount,
        deliveryCents: p.price.deliveryPrice,
        packingCents: p.price.packingPrice,
        originalCents: p.price.originalPrice,
        enjoyed: p.price.discount > 0,
      })),
      best: {
        label: best.label,
        couponTitles: best.couponTitles,
        complete: best.complete,
        priceCents: best.price.price,
        productOriginalCents: best.price.productOriginalPrice,
        productPriceCents: best.price.productPrice,
        discountCents: best.price.discount,
        deliveryCents: best.price.deliveryPrice,
        packingCents: best.price.packingPrice,
        originalCents: best.price.originalPrice,
        takeWayList: best.price.takeWayList,
        productList: best.price.productList,
        enjoyable: best.price.enjoyable,
        items: best.items.map((it) => ({ productCode: it.productCode, quantity: it.quantity, name: it.name, couponId: it.couponId ?? '', couponCode: it.couponCode ?? '' })),
      },
      noCouponCents: noCoupon ? noCoupon.price.price : null,
      noCouponComplete: !!noCoupon?.complete,
      goodsSavingCents,
      couponSavingCents: baselineCents !== null ? Math.max(0, baselineCents - best.price.price) : goodsSavingCents,
      overBudget: budgetCents ? best.price.price > budgetCents : false,
      autoNotes,
      degraded: false,
    });

    // ⑤ 券专属商品（客观信息，不并入最优方案）
    if (couponFirst) {
      const cartCodes = new Set(cart.map((c) => c.productCode));
      const found = await probeCouponOnlyAddOns({
        client, store, coupons: activeCoupons, cartCodes, orderType, beType,
        addressId: address?.addressId, reservationDate, maxCalls, budget,
      });
      addOns.push(...found);
    }
  }

  const ranked = [...comparisons].sort((a, b) => {
    if (a.overBudget !== b.overBudget) return a.overBudget ? 1 : -1;
    return a.best.priceCents - b.best.priceCents;
  });
  const best = ranked[0] ?? null;
  if (budget.exhausted) warnings.push(`已达单次运行调用上限（${maxCalls} 次算价），部分门店/用券组合未验价。`);

  // 麦麦省「可领取」券（只读，不代领）：给用户一个「还能再省」的入口
  let avail = null;
  try {
    avail = await availableCoupons(client);
  } catch (e) {
    warnings.push(`麦麦省券列表查询失败：${e.message}`);
  }

  return {
    channel,
    address,
    query: { city, keyword, addressQuery },
    stores: candidates.map((s) => ({ storeCode: s.storeCode, storeName: s.storeName, beCode: s.beCode, distance: s.distance ?? null, distanceText: s.distanceText ?? '' })),
    closed,
    comparisons: ranked,
    best,
    addOns: dedupeAddOns(addOns),
    availableCoupons: avail?.ok ? { count: avail.titles.length, titles: avail.titles.slice(0, 12) } : null,
    warnings,
    callsUsed: budget.used,
  };
}

/** 同一张券的同一个商品在多店重复出现时只留最便宜的一条（并保留门店名）。 */
function dedupeAddOns(addOns) {
  const byKey = new Map();
  for (const a of addOns) {
    const key = `${a.productCode}:${a.couponTitle}`;
    const prev = byKey.get(key);
    if (!prev || a.couponPriceCents < prev.couponPriceCents) byKey.set(key, a);
  }
  return [...byKey.values()].sort((a, b) => b.savedCents - a.savedCents);
}

/**
 * 真正下单（**会创建真实未支付订单**，返回可付款的 H5 链接）。
 * 只应在用户明确确认后调用；本函数不支付。
 */
export async function placeOrder(client, comparison, { takeWayCode, remark, addressId } = {}) {
  const items = comparison.best.items.map((it) => ({
    productCode: it.productCode, quantity: it.quantity, couponId: it.couponId || undefined, couponCode: it.couponCode || undefined,
  }));
  const orderType = comparison.channel === CHANNEL.DELIVERY ? ORDER_TYPE.DELIVERY : ORDER_TYPE.IN_STORE;
  const beType = comparison.channel === CHANNEL.DELIVERY ? BE_TYPE.DELIVERY : BE_TYPE.PICKUP;
  let code = takeWayCode;
  if (orderType === ORDER_TYPE.IN_STORE && !code) {
    const list = comparison.best.takeWayList ?? [];
    code = list.find((t) => t.code === 'take-in-store')?.code ?? list[0]?.code ?? 'take-in-store';
  }
  return createOrder(client, {
    storeCode: comparison.store.storeCode,
    beCode: comparison.store.beCode,
    beType,
    orderType,
    addressId: orderType === ORDER_TYPE.DELIVERY ? (addressId ?? comparison.addressId) : undefined,
    takeWayCode: code,
    items,
    remark,
  });
}

/** 手机竖屏友好的点餐卡（窄列，直接可以在手机上读）。 */
export function renderPhoneCard(result) {
  const L = [];
  const ch = result.channel === CHANNEL.DELIVERY ? '麦乐送（外送）' : '到店自取';
  L.push('╭──────────────────────────────');
  L.push(`│ 🍟 手机点餐卡 · ${ch}`);
  if (result.address) L.push(`│ 📍 地址：${trim(result.address.fullAddress, 22)}`);
  const loc = [result.query?.city, result.query?.keyword].filter((x) => x && x !== true).join(' ');
  if (result.channel !== CHANNEL.DELIVERY && loc) L.push(`│ 🔎 ${loc}`);
  L.push(`│ 🏪 备选门店 ${result.stores.length} 家 · 已排除待营业 ${result.closed.length} 家`);
  L.push('╰──────────────────────────────');

  if (!result.comparisons.length) {
    L.push('');
    L.push('（没有可比价的门店：门店可能都不在营业时间）');
    for (const w of result.warnings) L.push(`⚠️ ${w}`);
    return L.join('\n');
  }

  L.push('');
  L.push('【同单跨门店比价】');
  for (const [i, c] of result.comparisons.entries()) {
    const star = i === 0 ? '★ ' : '  ';
    const d = c.store.distance ?? c.store.distanceText;
    L.push(`${star}${trim(c.store.storeName.replace(/^麦当劳/, ''), 20)}`);
    const couponBit = c.couponSavingCents > 0 ? `　券省 ${formatCents(c.couponSavingCents)}` : '';
    L.push(`   实付 ${formatCents(c.best.priceCents)}${couponBit}${d ? `　${typeof d === 'number' ? d + 'm' : d}` : ''}`);
  }

  const b = result.best;
  L.push('');
  L.push('【最优：这样点】');
  L.push(`🏪 ${b.store.storeName}`);
  for (const it of b.best.items) {
    const cp = it.couponId ? ' 🎟️' : '';
    L.push(`   · ${it.name}${cp}`);
  }
  if (b.couponOnlyItems?.length) {
    L.push('   （🎟️ = 券专属商品，菜单里没有，必须用券买）');
  }
  if (b.best.couponTitles.length) {
    L.push(`🎟️ 用券：${b.best.couponTitles.join(' + ')}`);
  } else if (b.couponOnlyItems?.length) {
    L.push('🎟️ ⚠️ 本单含券专属商品，但没有可用券，可能买不到');
  } else if (b.best.discountCents > 0) {
    L.push(`🎟️ 本单没用券，但门店自动优惠已计入（−${formatCents(b.best.discountCents).replace('−', '')}）`);
  } else {
    L.push('🎟️ 本单无可匹配的券');
  }
  L.push(`💰 商品小计 ${formatCents(b.best.productOriginalCents)} → 优惠 −${formatCents(b.best.discountCents).replace('−', '')}`);
  if (b.best.deliveryCents || b.best.packingCents) {
    L.push(`🛵 配送 ${formatCents(b.best.deliveryCents)} + 打包 ${formatCents(b.best.packingCents)}`);
  }
  L.push(`✅ 实付 ${formatCents(b.best.priceCents)}（官方算价口径）`);
  if (b.couponSavingCents > 0) {
    L.push(
      b.noCouponComplete
        ? `🎯 比不用券省 ${formatCents(b.couponSavingCents)}`
        : `🎯 券在商品上省了 ${formatCents(b.couponSavingCents)}（含券专属商品，无「不用券」可比基线）`,
    );
  }
  if (b.best.enjoyable?.balance) {
    L.push(`💡 再加 ${formatCents(b.best.enjoyable.balance)} 升到 ${Number(b.best.enjoyable.realDiscount.toFixed(2))} 折（客观提示，不是建议加购）`);
  }

  if (result.addOns.length) {
    L.push('');
    L.push('【券还能这样用（商品价，未含配送/打包）】');
    for (const a of result.addOns.slice(0, 4)) {
      L.push(`   · ${a.productName}：${formatCents(a.listPriceCents)} → 券后 ${formatCents(a.couponPriceCents)}`);
      L.push(`     （${a.couponTitle}｜${trim(a.storeName.replace(/^麦当劳/, ''), 16)}）`);
    }
  }

  if (result.availableCoupons?.count) {
    L.push('');
    L.push(`【麦麦省还有 ${result.availableCoupons.count} 张可领】`);
    for (const t of result.availableCoupons.titles.slice(0, 4)) L.push(`   · ${t}`);
    L.push('   （需先一键领取才会出现在门店券里；领取会写入你的券包）');
  }

  L.push('');
  L.push('【手机上这样操作】');
  const steps = result.channel === CHANNEL.DELIVERY
    ? [
        '麦当劳 App → 麦乐送',
        `选门店：${b.store.storeName}`,
        '选地址（与上面 📍 一致）',
        '加入清单里的商品',
      ]
    : [
        '麦当劳 App → 到店取餐',
        `选门店：${b.store.storeName}`,
        '加入清单里的商品',
      ];
  steps.push(b.best.couponTitles.length ? `结算页勾选：${b.best.couponTitles.join('、')}` : '结算页核对金额');
  steps.push(`核对实付 = ${formatCents(b.best.priceCents)} 再付款`);
  steps.forEach((s, i) => L.push(`   ${i + 1}. ${s}`));

  if (result.closed.length) {
    L.push('');
    L.push('【已排除（当前非营业时间）】');
    for (const c of result.closed.slice(0, 5)) L.push(`   · ${c.storeName}：${c.reason}`);
  }

  if (result.warnings.length) {
    L.push('');
    L.push('【提示】');
    for (const w of result.warnings.slice(0, 6)) L.push(`   ⚠️ ${w}`);
  }
  L.push('');
  L.push(`（本次共调用官方算价 ${result.callsUsed} 次；所有金额来自 calculate-price）`);
  return L.join('\n');
}

function trim(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

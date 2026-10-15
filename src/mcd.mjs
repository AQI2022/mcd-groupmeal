/**
 * 麦当劳 MCP 的领域封装层。
 *
 * 这一层只做两件事：
 *   1. 把 5 个团餐链路工具的**真实返回结构**归一化成业务对象；
 *   2. 把上游/下游的依赖关系（addressId → 门店 → 菜单/助餐/规则 → 算价）收拢成一个可缓存的 profile。
 *
 * 归一化依据全部来自 2026-10-15 对真实服务端的实测（见 docs/LIFELINE.md）：
 *   delivery-query-addresses  → data.addresses[]      { addressId, contactName, fullAddress, phone }
 *   delivery-query-stores     → data[]                { storeCode, beCode, storeName, reservation, reservationTimeOptions }
 *   query-meals               → data.categories[] + data.meals{code: {name, currentPrice, originalPrice, image}}
 *   query-meal-assistance     → data.mealAssistanceItems[] { gmServiceCode, gmServiceName, serviceItems[], enable, unusableReason }
 *   query-promotions          → data[]                { promotionId, promotionType, ruleCategory, gmServiceCode, products[], ruleDetail }
 *   calculate-price           → data                  { productOriginalPrice, productPrice, deliveryPrice, packingPrice, originalPrice, discount, price, productList[], enjoyable }
 *
 * 注意：金额单位不统一 —— `calculate-price` 原生就是**分**，其余工具是**元字符串**。
 * 本层出口统一为分（见 money.mjs）。
 */
import { yuanToCents } from './money.mjs';

export const BE_TYPE = { PICKUP: 1, DELIVERY: 2, DRIVE_THRU: 5, GROUP_MEAL: 6 };
export const ORDER_TYPE = { IN_STORE: 1, DELIVERY: 2 };

/** 业务错误码：门店打烊（实测由 query-meals / query-store-coupons 在非营业时间返回）。 */
export const CLOSED_STORE_CODE = 600057;
/** 业务错误码：收藏餐厅为空（query-nearby-stores searchType=1）。 */
export const NO_FAVORITE_STORE_CODE = 600050;

/** 极简 TTL 缓存。 */
export class TtlCache {
  constructor(ttlMs = 600000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value) {
    this.map.set(key, { at: this.now(), value });
    return value;
  }
  async wrap(key, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, await fn());
  }
  get size() {
    return this.map.size;
  }
}

const text = (v) => (v === null || v === undefined ? '' : String(v));

/** 账号地址簿。 */
export async function listAddresses(client) {
  const r = await client.callToolOrThrow('delivery-query-addresses', {});
  const rows = r.json?.data?.addresses ?? (Array.isArray(r.json?.data) ? r.json.data : []);
  return (Array.isArray(rows) ? rows : []).map((a) => ({
    addressId: a.addressId ?? a.id,
    contactName: text(a.contactName),
    fullAddress: text(a.fullAddress ?? a.address),
    phone: text(a.phone),
  }));
}

/**
 * 用一段文本在地址簿里找地址（城市名 / 写字楼名 / 完整地址都能命中）。
 * 打分规则：完整包含 > 城市命中 > 逐字命中数。
 */
export function resolveAddress(addresses, query) {
  if (!addresses.length) return null;
  if (!query) return addresses[0];
  const q = text(query).trim();
  let best = null;
  for (const a of addresses) {
    let score = 0;
    if (a.fullAddress.includes(q)) score = 1000 + q.length;
    else {
      for (const ch of q) if (a.fullAddress.includes(ch)) score += 1;
      if (score === q.length && q.length >= 2) score += 100;
    }
    if (!best || score > best.score) best = { address: a, score };
  }
  return best && best.score > 0 ? best.address : null;
}

/** 团餐可配送门店（beType=6，orderType=2）。 */
export async function queryGroupMealStores(client, addressId, { beType = BE_TYPE.GROUP_MEAL } = {}) {
  return queryDeliveryStores(client, addressId, { beType });
}

/**
 * 外送可配送门店（beType=2 麦乐送 / 6 团餐），统一返回带 `beCode` 的归一化门店。
 * `beCode` 是外送/团餐链路后续所有工具（query-meals / query-store-coupons / calculate-price）的必传参数。
 */
export async function queryDeliveryStores(client, addressId, { beType = BE_TYPE.DELIVERY } = {}) {
  const r = await client.callToolOrThrow('delivery-query-stores', { addressId, beType });
  const rows = r.json?.data;
  const arr = Array.isArray(rows) ? rows : Array.isArray(rows?.stores) ? rows.stores : [];
  return arr.map((s) => ({
    storeCode: text(s.storeCode ?? s.code),
    beCode: text(s.beCode),
    storeName: text(s.storeName ?? s.name),
    address: text(s.address),
    reservation: !!s.reservation,
    reservationTimeOptions: s.reservationTimeOptions ?? [],
    businessStatus: s.businessStatus ?? null,
    businessStartTime: text(s.businessStartTime),
    businessEndTime: text(s.businessEndTime),
  }));
}

/**
 * 到店门店（beType=1 到店自取 / 5 得来速）。
 *
 * 与 `delivery-query-stores` 的关键差异：
 *   · 走 `query-nearby-stores`，参数是「城市 + 位置关键词」，**不需要账号地址簿**；
 *   · beType=1 返回的门店**没有 beCode**，后续调用一律不传 beCode（传了会报错）；
 *   · beType=5 返回 beCode，后续必须传。
 *
 * searchType=1 是「收藏餐厅」，账号没有收藏时返回 code=600050；此时若给了 city+keyword，
 * 自动降级到 searchType=2（按位置搜索），而不是把「没收藏」当成「附近没店」。
 */
export async function queryNearbyStores(client, { beType = BE_TYPE.PICKUP, searchType, city, keyword } = {}) {
  const wantPosition = searchType === 2 || (searchType === undefined && !!(city && keyword));
  const attempt = async (st) => {
    const args = { beType, searchType: st };
    if (st === 2) {
      if (city) args.city = city;
      if (keyword) args.keyword = keyword;
    }
    const r = await client.callTool('query-nearby-stores', args);
    if (!r.ok && r.code === NO_FAVORITE_STORE_CODE && st === 1 && city && keyword) return null; // 触发降级
    if (!r.ok) {
      const err = new Error(`[query-nearby-stores] 业务失败 code=${r.code ?? '?'} ${r.message ?? ''}`);
      err.code = r.code ?? 'NEARBY_FAILED';
      throw err;
    }
    return r;
  };

  let r = null;
  let usedSearchType = wantPosition ? 2 : 1;
  if (wantPosition) {
    r = await attempt(2);
  } else {
    r = await attempt(1);
    if (r === null) {
      usedSearchType = 2;
      r = await attempt(2);
    } else if (!Array.isArray(r.json?.data) || r.json.data.length === 0) {
      // 收藏为空数组也算「没有可用的收藏」，同样降级（真实服务端两种都会出现）
      if (city && keyword) {
        usedSearchType = 2;
        r = await attempt(2);
      }
    }
  }
  const rows = r.json?.data;
  const arr = Array.isArray(rows) ? rows : [];
  return {
    searchType: usedSearchType,
    stores: arr.map((s) => ({
      storeCode: text(s.storeCode ?? s.code),
      beCode: text(s.beCode),
      storeName: text(s.storeName ?? s.name),
      shortName: text(s.shortName),
      address: text(s.address),
      distance: Number.isFinite(Number(s.distance)) ? Number(s.distance) : null,
      distanceText: text(s.distanceText),
      businessStatus: s.businessStatus ?? null,
      businessStartTime: text(s.businessStartTime),
      businessEndTime: text(s.businessEndTime),
      reservation: !!s.reservation,
      reservationTimeOptions: s.reservationTimeOptions ?? [],
    })),
  };
}

/**
 * 门店可用优惠券（本账号已领取的券）。
 *
 * 实测返回（2026-10-15，到店 orderType=1 / beType=1）：
 *   [{ title, couponId, couponCode, tradeDateTime, products:[{productCode, productName}], promotionId }]
 * `couponId` + `couponCode` 是 `calculate-price` / `create-order` 里挂券的唯一凭据。
 *
 * ⚠️ 券里的 `products[].productCode` **可能不在 query-meals 的菜单里**：
 * 实测「新人专享-中杯美式7折」的 9900000119（美式中杯）不在菜单中，
 * 且不带券算价返回 price=0（productList 为空）——它是**券专属商品**，只能用券买到。
 * 因此「券找货」必须从券的 products 取商品码，不能只在菜单里找。
 */
export async function queryStoreCoupons(client, { storeCode, beCode, orderType = ORDER_TYPE.IN_STORE, beType = BE_TYPE.PICKUP, reservationDate } = {}) {
  const args = { storeCode, orderType, beType };
  if (beCode) args.beCode = beCode;
  if (reservationDate) args.reservationDate = reservationDate;
  const r = await client.callToolOrThrow('query-store-coupons', args);
  const rows = r.json?.data;
  const arr = Array.isArray(rows) ? rows : Array.isArray(rows?.coupons) ? rows.coupons : [];
  return arr.map((c) => ({
    title: text(c.title),
    couponId: text(c.couponId),
    couponCode: text(c.couponCode),
    promotionId: text(c.promotionId),
    tradeDateTime: text(c.tradeDateTime),
    products: (Array.isArray(c.products) ? c.products : []).map((p) => ({
      productCode: text(p.productCode),
      productName: text(p.productName),
    })),
  }));
}

/** 券的有效期是否覆盖 `at`；`tradeDateTime` 形如 `2026-10-15 00:00:00-2026-11-13 23:59:59`。 */
export function isCouponActive(coupon, at = new Date()) {
  const raw = text(coupon?.tradeDateTime);
  if (!raw) return true;
  const [from, to] = raw.split('-').length > 2 ? splitCouponWindow(raw) : raw.split(/\s*~\s*|\s+-\s+/);
  const parse = (s) => {
    if (!s) return null;
    const t = Date.parse(String(s).trim().replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  };
  const a = parse(from);
  const b = parse(to);
  const now = at.getTime();
  if (a !== null && now < a) return false;
  if (b !== null && now > b) return false;
  return true;
}

/** `2026-10-15 00:00:00-2026-11-13 23:59:59` → ['2026-10-15 00:00:00','2026-11-13 23:59:59']（不能按 '-' 直接 split，日期里就有 '-'）。 */
function splitCouponWindow(raw) {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (m) return [m[1], m[2]];
  const parts = raw.split(/\s*~\s*/);
  return [parts[0], parts[1]];
}

/**
 * 麦麦省「可领取」券列表。
 *
 * 实测：该工具**只返回 Markdown 文本，没有 JSON**（`kind:'text'`），形如
 *   ### 麦麦省优惠券列表：
 *   - 优惠券标题：中薯条买一送一 \ 状态：可领取 \
 * 文本里**没有 couponId/couponCode** —— 想让它进入算价，必须先 `auto-bind-coupons` 一键领取，
 * 领取后才会出现在 `query-store-coupons` 里并带出券 ID。因此本函数只做「有多少张可领」的解析。
 */
export async function availableCoupons(client) {
  const r = await client.callTool('available-coupons', {});
  if (!r.ok) return { ok: false, kind: r.kind ?? 'json', code: r.code, titles: [], raw: r.text ?? '' };
  const titles = [];
  for (const line of String(r.text ?? '').split(/\r?\n/)) {
    const m = /优惠券标题[:：]\s*(.+?)\s*(?:\\|$)/.exec(line);
    if (m) titles.push(m[1].trim());
  }
  return { ok: true, kind: r.kind ?? 'text', code: r.code, titles: [...new Set(titles)], raw: r.text ?? '' };
}

/** 一键领取麦麦省全部可领券（**会改写账号券包**，仅在用户明确同意后调用）。 */
export async function autoBindCoupons(client) {
  const r = await client.callTool('auto-bind-coupons', {});
  return { ok: r.ok, code: r.code, message: r.message, json: r.json, text: r.text };
}

/** 当月营销活动日历（实测同 `available-coupons`：Markdown 文本，无 JSON）。 */
export async function campaignCalendar(client, { specifiedDate } = {}) {
  const args = specifiedDate ? { specifiedDate } : {};
  const r = await client.callTool('campaign-calendar', args);
  if (!r.ok) return { ok: false, kind: r.kind ?? 'json', code: r.code, titles: [], raw: r.text ?? '' };
  const titles = [];
  for (const line of String(r.text ?? '').split(/\r?\n/)) {
    const m = /\*\*活动标题\*\*[:：]\s*(.+)/.exec(line);
    if (m) titles.push(m[1].trim());
  }
  return { ok: true, kind: r.kind ?? 'text', code: r.code, titles: [...new Set(titles)], raw: r.text ?? '' };
}

/**
 * 创建订单（**会产生真实未支付订单**）。
 *
 * 官方口径：`orderType=1` 必须带 `takeWayCode`（来自 `calculate-price` 的 `takeWayList[].code`）；
 * `orderType=2` 必须带 `addressId`；团餐还必须带 `gmServiceCode`。
 * 返回 `payH5Url` —— 手机端可直接点开付款的 H5 链接，这是「手机上点餐」最省事的一环。
 * 本函数只创建订单，**不会支付**；调用方必须先取得用户明确确认。
 */
export async function createOrder(client, {
  storeCode, beCode, beType, orderType, items, addressId, takeWayCode, gmServiceCode, reservationDate, remark, needTableware,
} = {}) {
  const args = { storeCode, orderType, beType, items };
  if (beCode) args.beCode = beCode;
  if (addressId) args.addressId = addressId;
  if (takeWayCode) args.takeWayCode = takeWayCode;
  if (gmServiceCode) args.gmServiceCode = gmServiceCode;
  if (reservationDate) args.reservationDate = reservationDate;
  if (remark) args.remark = remark;
  if (needTableware !== undefined) args.needTableware = needTableware;
  const r = await client.callToolOrThrow('create-order', args);
  const d = r.json?.data ?? {};
  return {
    orderId: text(d.orderId),
    status: d.status ?? null,
    amount: text(d.amount),
    payH5Url: text(d.payH5Url ?? d.payUrl),
    point: d.point ?? null,
    coupons: Array.isArray(d.coupons) ? d.coupons : [],
    raw: d,
  };
}

/** 门店实时菜单。 */
export async function queryMeals(client, { storeCode, beCode, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL }) {
  const r = await queryMealsWithStatus(client, { storeCode, beCode, orderType, beType });
  if (!r.ok) {
    const hint = BUSINESS_HINTS[r.code];
    throw new Error(`[query-meals] 业务失败 code=${r.code ?? '?'} ${r.message ?? ''}${hint ? ` → ${hint}` : ''}`);
  }
  return r.menu;
}

const BUSINESS_HINTS = {
  [CLOSED_STORE_CODE]: '门店可能已关闭或不在营业时间（不是「这家店没有菜单」）',
};

/**
 * 门店菜单（**保留失败码**，供手机点餐链路区分「打烊」与「真的没菜单」）。
 *
 * 实测：门店打烊时 `query-meals` 返回 `code=600057 门店可能已关闭或不在营业时间`，
 * 菜单为空。如果把它当成「菜单 0 项」，会得出「这家店没有团餐」这种错误结论。
 */
export async function queryMealsWithStatus(client, { storeCode, beCode, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL }) {
  const args = { storeCode, orderType, beType };
  if (beCode) args.beCode = beCode;
  const r = await client.callTool('query-meals', args);
  if (!r.ok) return { ok: false, code: r.code, message: r.message, menu: { categories: [], meals: {} } };
  const data = r.json?.data ?? {};
  const raw = data.meals ?? {};
  const meals = {};
  for (const [code, m] of Object.entries(raw)) {
    meals[code] = {
      code,
      name: text(m?.name),
      currentPrice: yuanToCents(m?.currentPrice),
      originalPrice: yuanToCents(m?.originalPrice ?? m?.currentPrice),
      image: text(m?.image),
    };
  }
  return { ok: true, code: r.code, message: r.message, menu: { categories: Array.isArray(data.categories) ? data.categories : [], meals } };
}

/** 团餐助餐服务档位（gmServiceCode 的唯一来源）。 */
export async function queryMealAssistance(client, { storeCode, beCode, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL, reservationDate }) {
  const args = { storeCode, beCode, orderType, beType };
  if (reservationDate) args.reservationDate = reservationDate;
  const r = await client.callToolOrThrow('query-meal-assistance', args);
  const items = r.json?.data?.mealAssistanceItems ?? r.json?.data ?? [];
  return (Array.isArray(items) ? items : []).map((x) => ({
    gmServiceCode: text(x.gmServiceCode),
    gmServiceName: text(x.gmServiceName),
    serviceItems: Array.isArray(x.serviceItems) ? x.serviceItems : [],
    selected: !!x.selected,
    enable: x.enable !== false,
    unusableReason: text(x.unusableReason),
  }));
}

/** 门店团餐促销规则（满折 / 满减）。 */
export async function queryPromotions(client, { storeCode, beCode, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL, reservationDate }) {
  const args = { storeCode, beCode, orderType, beType };
  if (reservationDate) args.reservationDate = reservationDate;
  const r = await client.callToolOrThrow('query-promotions', args);
  const rows = r.json?.data ?? [];
  return (Array.isArray(rows) ? rows : []).map((x) => ({
    promotionId: text(x.promotionId),
    promotionType: text(x.promotionType), // 31 满额减 / 33 订单折扣
    ruleCategory: Number(x.ruleCategory), // 30 满折 / 40 满减
    beTypes: (x.beTypes ?? []).map(text),
    startTime: text(x.startTime),
    endTime: text(x.endTime),
    gmServiceCode: text(x.gmServiceCode),
    products: (Array.isArray(x.products) ? x.products : []).map((p) => ({ type: text(p.type), productCode: text(p.productCode) })),
    ruleDetail: x.ruleDetail ?? null,
  }));
}

/** 官方算价（唯一权威口径）。 */
export async function calculatePrice(client, { storeCode, beCode, gmServiceCode, addressId, items, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL, reservationDate, needTableware }) {
  const args = { storeCode, beType, orderType, items };
  if (beCode) args.beCode = beCode;
  if (gmServiceCode) args.gmServiceCode = gmServiceCode;
  if (addressId) args.addressId = addressId;
  if (reservationDate) args.reservationDate = reservationDate;
  if (needTableware !== undefined) args.needTableware = needTableware;
  const r = await client.callToolOrThrow('calculate-price', args);
  const d = r.json?.data ?? {};
  return {
    raw: d,
    productOriginalPrice: Number(d.productOriginalPrice ?? 0),
    productPrice: Number(d.productPrice ?? 0),
    deliveryOriginalPrice: Number(d.deliveryOriginalPrice ?? 0),
    deliveryPrice: Number(d.deliveryPrice ?? 0),
    packingOriginalPrice: Number(d.packingOriginalPrice ?? 0),
    packingPrice: Number(d.packingPrice ?? 0),
    originalPrice: Number(d.originalPrice ?? 0),
    discount: Number(d.discount ?? 0),
    price: Number(d.price ?? 0),
    productList: Array.isArray(d.productList) ? d.productList : [],
    mealAssistanceList: Array.isArray(d.mealAssistanceList) ? d.mealAssistanceList : [],
    /** 官方主动给出的「距下一档优惠还差多少」：{ amountType, realDiscount, balance }（分）。 */
    enjoyable: d.enjoyable
      ? { amountType: text(d.enjoyable.amountType), realDiscount: Number(d.enjoyable.realDiscount), balance: Number(d.enjoyable.balance ?? 0) }
      : null,
  };
}

/**
 * 拉取（并缓存）一个门店的完整团餐画像：菜单 + 助餐档位 + 促销规则。
 * 这是本层最有价值的组合：把 3 次调用收敛成 1 个可复用的对象。
 *
 * 容错：真实服务端会偶发 `code=500 服务器发生了未知的问题`（实测在 `query-promotions` 上遇到过）。
 * 单店、单接口失败不应该让整次比价崩掉，因此这里逐个接口降级：
 * 失败的接口返回空集合并把原因写进 `degraded[]`，由上层决定怎么呈现。
 */
export async function loadStoreProfile(client, store, { addressId, cache, reservationDate, strict = false } = {}) {
  const base = { storeCode: store.storeCode, beCode: store.beCode, reservationDate };
  const key = (kind) => `${kind}:${store.storeCode}:${store.beCode}:${reservationDate ?? ''}`;
  const degraded = [];

  const guarded = async (kind, label, fallback, fn) => {
    const run = async () => {
      try {
        return await fn();
      } catch (e) {
        if (strict) throw e;
        degraded.push({ kind, label, error: e?.message ?? String(e), code: e?.code ?? null });
        return fallback;
      }
    };
    const value = cache ? await cache.wrap(key(kind), run) : await run();
    return value;
  };

  const [menu, assistance, promotions] = await Promise.all([
    guarded('menu', 'query-meals', { categories: [], meals: {} }, () => queryMeals(client, base)),
    guarded('assist', 'query-meal-assistance', [], () => queryMealAssistance(client, base)),
    guarded('promo', 'query-promotions', [], () => queryPromotions(client, base)),
  ]);

  return { ...store, addressId, menu, assistance, promotions, degraded };
}

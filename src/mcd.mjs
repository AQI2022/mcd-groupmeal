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

/** 门店实时菜单。 */
export async function queryMeals(client, { storeCode, beCode, orderType = ORDER_TYPE.DELIVERY, beType = BE_TYPE.GROUP_MEAL }) {
  const r = await client.callToolOrThrow('query-meals', { storeCode, beCode, orderType, beType });
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
  return { categories: Array.isArray(data.categories) ? data.categories : [], meals };
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

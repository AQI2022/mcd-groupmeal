/**
 * 离线演示后端（**演示数据**）。
 *
 * 用途：没有 MCP Token、或不想发真实请求时，跑通「门店 → 菜单 → 助餐 → 满折规则 → 算价 → 比价 → 拆单」
 * 的完整链路，用于演示、测试与 CI。
 *
 * ⚠️ 声明：
 *   · 门店名、餐品名、价格均为**构造的演示数据**，不是任何真实门店的真实报价；
 *   · 规则的**形状**（满折档位 300/500/1000/2000、三个助餐档位让利率不同、
 *     `products[].type="2"` 排除清单、`enjoyable.balance` 凑单提示）取自
 *     2026-10-15 对真实服务端的实测结构，以便离线后端与线上行为一致；
 *   · 任何对外材料引用本文件的数据时必须标注「演示数据」。
 */
import { bestPromotionFor, parseTiers, isRuleActive } from './promotions.mjs';
import { yuanToCents } from './money.mjs';

const ASSISTANCE = [
  { gmServiceCode: 'GMS001', gmServiceName: '保鲜速达', serviceItems: ['准时送达&餐品保温'], selected: true, enable: true, unusableReason: '' },
  { gmServiceCode: 'GMS002', gmServiceName: '专人分餐', serviceItems: ['准时送达&餐品保温', '送餐到桌/到人'], selected: false, enable: true, unusableReason: '' },
  { gmServiceCode: 'GMS003', gmServiceName: '专人摆台', serviceItems: ['准时送达&餐品保温', '餐品摆台', '专人服务'], selected: false, enable: true, unusableReason: '' },
];

const MENU_ROWS = [
  ['1001', '巨无霸', 24.0, 'burger'],
  ['1002', '板烧鸡腿堡', 22.5, 'burger'],
  ['1003', '麦辣鸡腿堡', 21.0, 'burger'],
  ['1004', '双层吉士汉堡', 18.5, 'burger'],
  ['1005', '麦香鸡', 15.0, 'burger'],
  ['2001', '中薯条', 15.0, 'fries'],
  ['2002', '大薯条', 17.0, 'fries'],
  ['3001', '麦乐鸡（5块）', 13.5, 'snack'],
  ['3002', '麦辣鸡翅（2块）', 12.5, 'snack'],
  ['3003', '那么大鸡排', 16.0, 'snack'],
  ['3004', '玉米杯', 9.5, 'snack'],
  ['3005', '苹果片', 6.0, 'snack'],
  ['4001', '可口可乐（中）', 10.0, 'drink'],
  ['4002', '雪碧（中）', 10.0, 'drink'],
  ['4003', '麦咖啡奶铁', 21.0, 'drink'],
  ['4004', '阳光橙汁', 14.0, 'drink'],
  ['5001', '原味甜筒', 4.0, 'dessert'],
  ['5002', '奥利奥麦旋风', 12.0, 'dessert'],
  ['9900', '限定礼盒（不参与优惠）', 68.0, 'other'],
];

/** 三个演示门店：菜单相同，但助餐档位让利率不同（模拟真实差异）。 */
export const DEMO_STORES = [
  {
    storeCode: '9000001',
    beCode: '900000181',
    storeName: '麦当劳演示一店（A 商圈）',
    address: '演示市演示区演示路 1 号',
    reservation: true,
    rateProfile: { GMS001: [22, 26, 30, 34], GMS002: [12, 16, 20, 24], GMS003: [7, 11, 15, 19] },
  },
  {
    storeCode: '9000002',
    beCode: '900000281',
    storeName: '麦当劳演示二店（B 商圈）',
    address: '演示市演示区演示路 2 号',
    reservation: true,
    rateProfile: { GMS001: [18, 22, 26, 30], GMS002: [10, 14, 18, 22], GMS003: [6, 9, 12, 16] },
  },
  {
    storeCode: '9000003',
    beCode: '900000381',
    storeName: '麦当劳演示三店（C 商圈）',
    address: '演示市演示区演示路 3 号',
    reservation: false,
    rateProfile: { GMS001: [25, 28, 32, 36], GMS002: [14, 18, 22, 26], GMS003: [8, 12, 16, 20] },
  },
];

const THRESHOLDS_YUAN = [300, 500, 1000, 2000];
const EXCLUDED = ['9900'];

export function demoMenu() {
  const meals = {};
  for (const [code, name, price, kind] of MENU_ROWS) {
    meals[code] = { code, name, currentPrice: yuanToCents(price), originalPrice: yuanToCents(price), image: '', kind };
  }
  return { categories: [], meals };
}

export function demoPromotions(store) {
  const rows = [];
  let i = 0;
  for (const [gmServiceCode, rates] of Object.entries(store.rateProfile)) {
    rates.forEach((percentOff, idx) => {
      i += 1;
      rows.push({
        promotionId: `${store.storeCode}${String(i).padStart(3, '0')}`,
        promotionType: '33',
        ruleCategory: 30,
        beTypes: ['6'],
        startTime: '2025-03-01 00:00:00',
        endTime: '2030-12-31 23:59:59',
        gmServiceCode,
        products: EXCLUDED.map((c) => ({ type: '2', productCode: c })),
        ruleDetail: { orderDiscount: { discount: String(percentOff), startDiscountPoint: String(THRESHOLDS_YUAN[idx]) } },
      });
    });
  }
  return rows;
}

export function demoAddresses() {
  return [
    {
      addressId: 'DEMO-ADDR-0001',
      contactName: '演示用户',
      fullAddress: '演示市演示区演示路 1 号 演示大厦 21 楼',
      phone: '138****8000',
    },
  ];
}

/** 到店场景的演示门店（beType=1：**返回没有 beCode**，与真实服务端一致）。 */
export const DEMO_PICKUP_STORES = [
  { storeCode: '9000001', storeName: '麦当劳演示一店（A 商圈）', address: '演示市演示路 1 号', distance: 320, distanceText: '320m', businessStatus: true, businessStartTime: '06:30', businessEndTime: '23:00', reservation: false, reservationTimeOptions: [] },
  { storeCode: '9000002', storeName: '麦当劳演示二店（B 商圈）', address: '演示市演示路 2 号', distance: 780, distanceText: '780m', businessStatus: true, businessStartTime: '07:00', businessEndTime: '23:59', reservation: true, reservationTimeOptions: [] },
  { storeCode: '9000004', storeName: '麦当劳演示四店（打烊中）', address: '演示市演示路 4 号', distance: 1500, distanceText: '1.5km', businessStatus: false, businessStartTime: '07:00', businessEndTime: '22:00', reservation: false, reservationTimeOptions: [] },
];

/** 券专属商品（菜单里没有，不带券算价为 0）——真实服务端 9900000119 美式中杯的离线对应物。 */
export const DEMO_COUPON_ONLY_CODE = '9001';

/** 演示券包（结构照抄真实 `query-store-coupons` 的返回字段）。 */
export function demoCoupons() {
  const window = '2025-01-01 00:00:00-2030-12-31 23:59:59';
  return [
    { title: '演示券-巨无霸7折', couponId: 'DEMO-C1', couponCode: 'DEMOCODE1', promotionId: 'DEMO-P1', tradeDateTime: window, products: [{ productCode: '1001', productName: '巨无霸' }] },
    { title: '演示券-中杯美式5折（券商品，菜单里没有）', couponId: 'DEMO-C2', couponCode: 'DEMOCODE2', promotionId: 'DEMO-P2', tradeDateTime: window, products: [{ productCode: DEMO_COUPON_ONLY_CODE, productName: '美式中杯' }] },
  ];
}

/** 演示券的让利率（分档硬编码，仅演示）。 */
const DEMO_COUPON_RATE = { 'DEMO-C1': 0.3, 'DEMO-C2': 0.5 };

/**
 * 免配送费门槛（分）。用 2026-10-15 的真实回执校准：
 * ¥300 小计仍收 ¥6 配送费、¥510 小计已免，因此取 ¥500 为模型门槛。
 */
const FREE_DELIVERY_THRESHOLD_CENTS = 50000;

/** 打包服务费（分）：¥0.30/件，下限 ¥1.60、上限 ¥9.00（与真实回执一致）。 */
function packingCents(totalQuantity) {
  return Math.min(900, Math.max(160, totalQuantity * 30));
}

/** 与官方 `calculate-price` 语义一致的离线定价器（口径来自真实反证，见 docs/LIFELINE.md）。 */
export function demoCalculatePrice({ store, gmServiceCode, items, beType }) {
  const menu = demoMenu().meals;
  const isPickup = Number(beType) === 1;
  const promotions = demoPromotions(store);

  // 券专属商品：不带券时官方返回 price=0 且 productList 为空（实测 9900000119 美式中杯）
  const priced = [];
  let couponDiscount = 0;
  for (const it of items ?? []) {
    const code = String(it.productCode);
    if (code === DEMO_COUPON_ONLY_CODE && !it.couponId) continue;
    const unit = code === DEMO_COUPON_ONLY_CODE ? 1900 : (menu[code]?.currentPrice ?? 0);
    const name = code === DEMO_COUPON_ONLY_CODE ? '美式中杯' : (menu[code]?.name ?? '');
    const qty = Math.max(1, Number(it.quantity) || 1);
    const original = unit * qty;
    let subtotal = original;
    const rate = it.couponId ? (DEMO_COUPON_RATE[it.couponId] ?? 0) : 0;
    if (rate > 0) {
      subtotal = original - Math.round(original * rate);
      couponDiscount += original - subtotal;
    }
    priced.push({ productCode: code, productName: name, quantity: qty, originalSubtotal: original, subtotal });
  }

  const lines = priced.map((p) => ({ productCode: p.productCode, quantity: p.quantity, unitPriceCents: p.originalSubtotal / p.quantity }));
  const productOriginalPrice = priced.reduce((s, p) => s + p.originalSubtotal, 0);
  const productPrice = priced.reduce((s, p) => s + p.subtotal, 0);
  const promo = bestPromotionFor(promotions, { gmServiceCode, lines });
  const totalQuantity = priced.reduce((s, p) => s + p.quantity, 0);
  // 到店自取：无配送费、无打包费；外送/团餐：沿用实测过的配送+打包口径
  const deliveryOriginalPrice = isPickup ? 0 : 600;
  const deliveryPrice = isPickup ? 0 : productOriginalPrice >= FREE_DELIVERY_THRESHOLD_CENTS ? 0 : 600;
  const packingOriginalPrice = isPickup ? 0 : packingCents(totalQuantity);
  const packingPrice = packingOriginalPrice;
  const originalPrice = productOriginalPrice + deliveryOriginalPrice + packingOriginalPrice;
  const price = Math.max(0, productPrice + deliveryPrice + packingPrice - promo.cents);

  // enjoyable：官方会告诉你「距下一档还差多少」
  const usable = promotions.filter((r) => isRuleActive(r) && r.gmServiceCode === gmServiceCode);
  const allTiers = usable.flatMap((r) => parseTiers(r)).sort((a, b) => a.thresholdCents - b.thresholdCents);
  const next = allTiers.find((t) => t.thresholdCents > productOriginalPrice);
  const enjoyable = next
    ? { amountType: '2', realDiscount: (100 - next.percentOff) / 10, balance: next.thresholdCents - productOriginalPrice }
    : null;

  return {
    raw: {},
    productOriginalPrice,
    productPrice,
    deliveryOriginalPrice,
    deliveryPrice,
    packingOriginalPrice,
    packingPrice,
    originalPrice,
    discount: Math.max(0, originalPrice - price),
    price,
    productList: priced,
    mealAssistanceList: gmServiceCode ? [{ code: gmServiceCode, name: '' }] : [],
    takeWayList: isPickup
      ? [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'take-in-store', title: '外带', subtitle: '店内自提' }]
      : [],
    enjoyable,
  };
}

export { ASSISTANCE as DEMO_ASSISTANCE };

/**
 * 离线客户端：实现 `McpClient` 中被 `mcd.mjs` 用到的那部分接口。
 * 这样 `optimize()` 在演示模式下走的是**和真实模式完全相同的代码路径**，
 * 唯一被替换的是最底层的网络调用。
 */
export class MockClient {
  constructor({ stores = DEMO_STORES } = {}) {
    this.stores = stores;
    this.mode = 'demo';
    this.toolCalls = 0;
    this.tools = [
      'delivery-query-addresses',
      'delivery-query-stores',
      'query-nearby-stores',
      'query-store-coupons',
      'available-coupons',
      'campaign-calendar',
      'create-order',
      'query-meals',
      'query-meal-assistance',
      'query-promotions',
      'calculate-price',
    ].map((name) => ({ name }));
  }

  findTool(name) {
    return this.tools.some((t) => t.name === name) ? name : null;
  }

  /** 只返回 Markdown、没有 JSON 的工具（真实服务端行为）。 */
  textTool(name, text) {
    return { ok: true, json: null, text, code: null, message: null, tool: name, isError: false, kind: 'text' };
  }

  async callTool(name, args = {}) {
    this.toolCalls += 1;
    const respond = (data) => ({ ok: true, json: { success: true, code: 200, message: '演示数据', data }, text: JSON.stringify({ success: true, code: 200, data }), code: 200, message: '演示数据', tool: name, isError: false });
    const bizError = (code, message) => ({ ok: false, json: { success: false, code, message, data: null }, text: JSON.stringify({ success: false, code, message }), code, message, tool: name, isError: false });
    switch (name) {
      case 'delivery-query-addresses':
        return respond({ addresses: demoAddresses() });
      case 'delivery-query-stores':
        return respond(this.stores);
      case 'query-nearby-stores':
        return respond(DEMO_PICKUP_STORES.map((s) => ({ ...s })));
      case 'query-store-coupons':
        return respond(demoCoupons());
      case 'available-coupons':
        return this.textTool(name, '### 麦麦省优惠券列表：\n- 优惠券标题：演示券-中薯条买一送一 \\\n  状态：可领取 \\\n- 优惠券标题：演示券-免费脆薯饼 \\\n  状态：可领取 \\\n');
      case 'campaign-calendar':
        return this.textTool(name, '### 当前时间：2030-01-01 12:00:00\n\n### 活动列表：\n\n#### 2030年01月01日 今日\n\n-   **活动标题**：演示活动-A\n    **活动内容介绍**：演示\n');
      case 'create-order':
        return respond({ orderId: 'DEMO-ORDER-0001', status: 1, amount: '13.30', payH5Url: 'https://pay.demo.invalid/DEMO-ORDER-0001', point: 0, coupons: [] });
      case 'query-meals': {
        const code = String(args.storeCode);
        // 打烊门店：真实服务端返回 code=600057
        if (DEMO_PICKUP_STORES.some((s) => s.storeCode === code && s.businessStatus === false) && Number(args.beType) === 1) {
          return bizError(600057, '门店可能已关闭或不在营业时间');
        }
        return respond(demoMenu());
      }
      case 'query-meal-assistance':
        return respond({ mealAssistanceItems: ASSISTANCE });
      case 'query-promotions': {
        const store = this.stores.find((s) => s.storeCode === args.storeCode) ?? this.stores[0];
        return respond(demoPromotions(store));
      }
      case 'calculate-price': {
        const store = this.stores.find((s) => s.storeCode === args.storeCode) ?? this.stores[0];
        return respond(demoCalculatePrice({ store, gmServiceCode: args.gmServiceCode, items: args.items ?? [], beType: args.beType }));
      }
      default:
        return { ok: false, json: { success: false, code: 404, message: `演示后端不支持的接口：${name}` }, text: '', code: 404, message: 'not supported', tool: name, isError: true };
    }
  }

  async callToolOrThrow(name, args = {}) {
    const r = await this.callTool(name, args);
    if (!r.ok) throw new Error(`[${name}] ${r.message}`);
    return r;
  }
}


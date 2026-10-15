/**
 * 金额工具：业务层统一用「分」（integer cents），展示层统一 `¥xx.xx`。
 * 全程整数加总，禁止浮点累加（`0.1+0.2` 类误差在比价场景会被用户当场发现）。
 */

/** 元字符串/数字 → 分（四舍五入到整数分）。 */
export function yuanToCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 分 → 元（number，仅用于展示/比较，不参与累加）。 */
export function centsToYuan(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

/** 分 → `¥12.34`。 */
export function formatCents(cents, { sign = false } = {}) {
  const n = Math.round(Number(cents) || 0);
  const body = `¥${(Math.abs(n) / 100).toFixed(2)}`;
  if (n < 0) return `−${body}`;
  return sign && n > 0 ? `+${body}` : body;
}

/** 分 → `7.4折` 形式（传入折扣率百分比，如 26 → 7.4折）。 */
export function formatDiscountRate(percentOff) {
  const rate = (100 - (Number(percentOff) || 0)) / 10;
  return `${Number(rate.toFixed(2))}折`;
}

/** 求和，输入是分数数组。 */
export function sumCents(list) {
  let total = 0;
  for (const v of list) total += Math.round(Number(v) || 0);
  return total;
}

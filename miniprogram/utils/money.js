/**
 * 金额格式化（只做展示，绝不重算金额）。
 *
 * 服务端返回的所有金额都是「分」，且来自官方 `calculate-price`；
 * 小程序这一层只负责把它们变成 `¥12.34` 这种字符串。
 */
function yuan(cents) {
  const n = Number(cents);
  if (!isFinite(n)) return '¥—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Math.round(n));
  return sign + '¥' + (abs / 100).toFixed(2);
}

/** 不带 ¥ 的数字，用于「优惠 −20.00」这类拼接。 */
function plain(cents) {
  const n = Number(cents);
  if (!isFinite(n)) return '—';
  return (Math.round(n) / 100).toFixed(2);
}

/** 优惠占商品小计的百分比，例如 31.2。 */
function percent(partCents, totalCents) {
  const total = Number(totalCents);
  if (!total || !isFinite(total)) return '0';
  return ((Number(partCents) / total) * 100).toFixed(1);
}

/**
 * 折扣文案。注意单位：官方 `calculate-price` 的 `enjoyable.realDiscount`
 * 直接是**折数**（实测 7.8 表示 7.8 折，balance 单位是分）。
 * 早先按 0~1 的小数处理，会打印出「70 折」这种错话——真实链路实测抓到的。
 */
function rate(discountZhe) {
  const n = Number(discountZhe);
  if (!isFinite(n) || n <= 0) return '';
  return (Math.round(n * 10) / 10) + ' 折';
}

module.exports = { yuan, plain, percent, rate };

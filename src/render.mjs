/**
 * 终端 / Markdown 渲染。
 * 表格用「显示宽度」对齐（CJK 字符按 2 列计），否则中文列会歪。
 */
import { formatCents, formatDiscountRate } from './money.mjs';
import { cnName } from './tiers.mjs';

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 字符串显示宽度（CJK 全角按 2 计）。 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

export function padEndWide(s, width) {
  const str = String(s ?? '');
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}

export function padStartWide(s, width) {
  const str = String(s ?? '');
  return ' '.repeat(Math.max(0, width - displayWidth(str))) + str;
}

/** 渲染一个等宽表格。 */
export function renderTable(headers, rows, { align = [] } = {}) {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const line = (cells, padder = padEndWide) => '│ ' + cells.map((c, i) => padder(c ?? '', widths[i])).join(' │ ') + ' │';
  const sep = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const bottom = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const body = rows.map((r) => line(r.map((c, i) => (align[i] === 'right' ? padStartWide(c ?? '', 0) : c))));
  return [top, line(headers), sep, ...body, bottom].join('\n');
}

/** 门店 × 方案 比价矩阵。 */
export function renderComparison(plans) {
  const headers = ['门店', '助餐', '商品小计', '满折/满减', '配送+打包', '实付', '人均', '超出预算'];
  const rows = plans.map((p, idx) => [
    (idx === 0 ? '★ ' : '  ') + p.store.storeName,
    p.assistance?.gmServiceName ?? '—',
    formatCents(p.totals.productOriginalPrice),
    `−${formatCents(p.totals.discount).replace('−', '')}`,
    formatCents(p.totals.deliveryPrice + p.totals.packingPrice),
    formatCents(p.totals.price),
    formatCents(p.totals.perHeadCents),
    p.totals.overBudget ? '是' : '否',
  ]);
  return renderTable(headers, rows, { align: [, , 'right', 'right', 'right', 'right', 'right', 'right'] });
}

/** 拆单对比表。 */
export function renderSplitTable(singlePlan, splitPlans) {
  const headers = ['拆法（人数分配）', '订单数', '商品小计', '优惠', '配送+打包', '实付', '相对不拆'];
  const sameTarget = splitPlans.filter((p) => !singlePlan?.id || p.basePlanId === singlePlan.id);
  const rows = [
    ['不拆', '1', formatCents(singlePlan.totals.productOriginalPrice), `−${formatCents(singlePlan.totals.discount).replace('−', '')}`, formatCents(singlePlan.totals.deliveryPrice + singlePlan.totals.packingPrice), formatCents(singlePlan.totals.price), '基线'],
    ...sameTarget.slice(0, 5).map((p) => {
      const delta = p.totals.price - singlePlan.totals.price;
      return [
        p.personGroups?.length ? `${p.personGroups.join(' + ')} 人` : p.basketLabel ?? '—',
        String(p.orderCount),
        formatCents(p.totals.productOriginalPrice),
        `−${formatCents(p.totals.discount).replace('−', '')}`,
        formatCents(p.totals.deliveryPrice + p.totals.packingPrice),
        formatCents(p.totals.price),
        `${delta > 0 ? '贵' : '省'} ${formatCents(Math.abs(delta))}`,
      ];
    }),
  ];
  return renderTable(headers, rows, { align: ['', 'right', 'right', 'right', 'right', 'right', 'right'] });
}

/** 完整的人类可读报告（终端用）。 */
export function renderReport(result, { people, budgetPerPersonCents } = {}) {
  const out = [];
  const { best, address, storeReports, verdict } = result;
  out.push(`📍 地址：${address.fullAddress}`);
  out.push(`👥 ${people} 人 · 人均预算 ${formatCents(budgetPerPersonCents)} · 总预算 ${formatCents(budgetPerPersonCents * people)}`);
  out.push(`🏪 可配送团餐门店：${result.stores.length} 家`);
  out.push('');

  const enabled = storeReports.map((r) => `${r.store.storeName.split('麦当劳')[1] ?? r.store.storeName}(菜单 ${r.menuSize} 项 / 助餐 ${r.assistance.length} 档 / 规则 ${r.ladders.reduce((s, l) => s + l.tiers.length, 0)} 档)`);
  out.push(`   门店情报：${enabled.join('；')}`);
  out.push('');

  out.push('╭─ 跨门店比价矩阵（全部数字来自官方 calculate-price）');
  out.push(renderComparison(result.plans));
  out.push('');

  if (best) {
    out.push(`🏆 最优方案：${best.store.storeName}（${best.assistance?.gmServiceName ?? '默认助餐'}）`);
    out.push(`   实付 ${formatCents(best.totals.price)} · 人均 ${formatCents(best.totals.perHeadCents)} · 总优惠 ${formatCents(best.totals.discount)}（${best.totals.productOriginalPrice ? ((best.totals.discount / best.totals.productOriginalPrice) * 100).toFixed(1) : '0'}%）`);
    if (result.savings.vsSameStoreWorstCents > 0) out.push(`   同店最差助餐档位要多付 ${formatCents(result.savings.vsSameStoreWorstCents)}`);
    if (result.savings.vsNextStoreCents > 0) out.push(`   比次优门店省 ${formatCents(result.savings.vsNextStoreCents)}`);
    out.push('');

    const storeReport = storeReports.find((r) => r.store.storeCode === best.store.storeCode);
    if (storeReport) {
      out.push(`   折扣阶梯（本店 ${storeReport.store.storeName}）：`);
      for (const l of storeReport.ladders) {
        const tiers = l.tiers.map((t) => (t.kind === 'discount' ? `满¥${t.thresholdCents / 100}→${formatDiscountRate(t.percentOff)}` : `满¥${t.thresholdCents / 100}减¥${t.reduceCents / 100}`)).join('，');
        out.push(`     · ${l.gmServiceCode}：${tiers}`);
      }
      out.push('');
      out.push(`   本单商品构成：${best.orders[0].items.map((i) => `${i.name}×${i.quantity}`).join(' + ')}`);
      out.push('');
    }
  }

  out.push(`🔀 拆单结论：**${verdict.headline}**。${verdict.reason}`);
  if (result.splitPlans.length) {
    out.push(renderSplitTable(best, result.splitPlans));
  }
  out.push('');

  const nudge = best?.totals?.enjoyable;
  if (nudge?.balance) {
    out.push(`💡 凑单提示：官方算价回执显示，商品小计再增加 ${formatCents(nudge.balance)} 即可升到 ${Number(nudge.realDiscount.toFixed(2))} 折。`);
    out.push('   ——这只是「距下一档还差多少」的客观信息，**不代表建议加购**。');
  }

  if (result.warnings.length) {
    out.push('');
    out.push('⚠️ 告警：');
    for (const w of result.warnings) out.push(`   · ${w}`);
  }
  out.push('');
  out.push(`（本次共调用官方 calculate-price ${result.callsUsed} 次）`);
  return out.join('\n');
}

/** 人类可读的「门店情报」单独视图。 */
export function renderStores(result) {
  const lines = [];
  lines.push(`📍 ${result.address.fullAddress}`);
  lines.push('');
  for (const r of result.storeReports) {
    lines.push(`🏪 ${r.store.storeName}  (storeCode=${r.store.storeCode} beCode=${r.store.beCode} 预约=${r.store.reservation ? '支持' : '不支持'})`);
    lines.push(`   菜单 ${r.menuSize} 项 · 助餐档位 ${r.assistance.length} 个 · 促销规则档 ${r.ladders.reduce((s, l) => s + l.tiers.length, 0)} 档 · 仅满折=${r.discountOnly}`);
    for (const a of r.assistance) {
      lines.push(`   · ${a.gmServiceCode} ${a.gmServiceName}${a.enable ? '' : '（不可用：' + a.unusableReason + '）'}`);
    }
    for (const l of r.ladders) {
      const tiers = l.tiers.map((t) => (t.kind === 'discount' ? `满¥${t.thresholdCents / 100}→${formatDiscountRate(t.percentOff)}` : `满¥${t.thresholdCents / 100}减¥${t.reduceCents / 100}`)).join('，');
      lines.push(`   · 规则 ${l.gmServiceCode}：${tiers}`);
    }
    lines.push('');
  }
  if (result.warnings?.length) lines.push(...result.warnings.map((w) => `⚠️ ${w}`));
  return lines.join('\n');
}

export { cnName };

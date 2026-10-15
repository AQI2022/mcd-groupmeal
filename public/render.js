/**
 * 麦麦省 · 纯渲染层（可以在 Node 里直接测，不碰 DOM）
 *
 * 为什么单独拆出来：这个项目没有构建步骤，前端唯一的「编译期」就是测试。
 * 把「把结果对象变成 HTML」这部分做成**纯函数**，就能在 Node 里用真实/演示数据
 * 跑一遍，确认界面上真的出现了门店名、券、实付金额——而不是等到手机上才发现白屏。
 *
 * 约定：
 *   · 只依赖入参，不读全局、不碰 document；
 *   · 所有金额直接来自服务端返回的「分」，这里只做展示格式化，绝不重算；
 *   · 一切来自接口的字符串都要过 `plain()`，避免把数据当 HTML 解析。
 */

export const yuan = (cents) => `¥${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;

export const plain = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function row(k, v, cls = '') {
  return `<div class="row ${cls}"><span class="k">${plain(k)}</span><span class="v ${cls === 'minus' ? 'minus' : ''}">${plain(v)}</span></div>`;
}

export function warnBox(list) {
  return `<div class="warnbox"><b>提示</b><ul>${list.slice(0, 8).map((w) => `<li>${plain(w)}</li>`).join('')}</ul></div>`;
}

export function closedBox(list) {
  return `<div class="card"><h3>已排除（当前非营业时间）</h3><ul class="itemlist">${list
    .slice(0, 6)
    .map((c) => `<li><span>${plain(c.storeName)}</span><span class="qty">${plain(c.reason)}</span></li>`)
    .join('')}</ul>
    <p class="hint">打烊门店的菜单为空，不是「这家店没有菜单」。</p></div>`;
}

/** 手机点餐结果 → HTML（不绑定任何事件）。 */
export function renderPhone(payload) {
  const r = payload?.result;
  if (!r) return '<div class="errbox">没有拿到结果</div>';
  const parts = [];

  if (payload.demo) parts.push('<div class="warnbox">演示数据：门店名、券与价格都是构造的，不是真实门店报价。</div>');

  if (!r.best) {
    parts.push('<div class="errbox"><b>没有可比价的门店</b></div>');
    if (r.warnings?.length) parts.push(warnBox(r.warnings));
    if (r.closed?.length) parts.push(closedBox(r.closed));
    return parts.join('');
  }

  const b = r.best;
  const sub = [];
  if (b.couponSavingCents > 0) sub.push(b.noCouponComplete ? `比不用券省 ${yuan(b.couponSavingCents)}` : `券在商品上省了 ${yuan(b.couponSavingCents)}`);
  if (b.store.distanceText) sub.push(b.store.distanceText);
  if (r.channel === 'delivery') sub.push('麦乐送');

  parts.push(`
    <div class="hero">
      <div class="label">${r.channel === 'delivery' ? '最优 · 麦乐送到这个地址' : '最优 · 到店自取'}</div>
      <div class="store">${plain(b.store.storeName)}</div>
      <div class="price">${yuan(b.best.priceCents)}</div>
      <div class="sub">${sub.map((s) => `<span class="badge">${plain(s)}</span>`).join('')}</div>
    </div>`);

  // 明细
  const rows = [];
  rows.push(row('商品小计', yuan(b.best.productOriginalCents)));
  if (b.best.discountCents > 0) rows.push(row('优惠', `−${yuan(b.best.discountCents)}`, 'minus'));
  if (b.best.deliveryCents) rows.push(row('配送费', yuan(b.best.deliveryCents)));
  if (b.best.packingCents) rows.push(row('打包费', yuan(b.best.packingCents)));
  rows.push(row('实付（官方算价）', yuan(b.best.priceCents), 'total'));
  if (b.best.enjoyable?.balance) {
    rows.push(row(`再凑 ${yuan(b.best.enjoyable.balance)}`, `升到 ${Number(b.best.enjoyable.realDiscount.toFixed(2))} 折`));
  }
  parts.push(`<div class="card"><h3>金额怎么来的</h3><div class="rows">${rows.join('')}</div>
    <p class="hint">所有金额都来自麦当劳官方 <code>calculate-price</code>，不是本地估算。</p></div>`);

  // 清单
  const items = (b.best.items ?? [])
    .map((it) => `<li><span>${plain(it.name)}${it.couponId ? ' <span class="tag ok">券</span>' : ''}</span><span class="qty">×${it.quantity}</span></li>`)
    .join('');
  const couponLine = b.best.couponTitles?.length
    ? `<div class="row"><span class="k">用券</span><span class="v">${plain(b.best.couponTitles.join(' + '))}</span></div>`
    : b.best.discountCents > 0
      ? '<div class="row"><span class="k">优惠来源</span><span class="v">门店自动优惠（没用券）</span></div>'
      : '';
  parts.push(`<div class="card"><h3>这样点</h3><ul class="itemlist">${items}</ul><div class="rows">${couponLine}</div>
    ${b.couponOnlyItems?.length ? '<p class="hint">标「券」的是券专属商品：菜单里搜不到，必须挂券才买得到。</p>' : ''}</div>`);

  // 操作步骤
  const steps =
    r.channel === 'delivery'
      ? ['麦当劳 App → 麦乐送', `选门店：${b.store.storeName}`, '选地址（与上面一致）', '加入清单里的商品']
      : ['麦当劳 App → 到店取餐', `选门店：${b.store.storeName}`, '加入清单里的商品'];
  steps.push(b.best.couponTitles?.length ? `结算页勾选：${b.best.couponTitles.join('、')}` : '结算页核对金额');
  steps.push(`核对实付 = ${yuan(b.best.priceCents)} 再付款`);
  parts.push(`<div class="card"><h3>手机上这样操作</h3><ol class="steps">${steps.map((s) => `<li>${plain(s)}</li>`).join('')}</ol></div>`);

  // 跨门店比价
  if (r.comparisons.length > 1) {
    const cmp = r.comparisons
      .map(
        (c, i) => `
      <div class="cmp ${i === 0 ? 'best' : ''}">
        <span class="name">${i === 0 ? '★ ' : ''}${plain(c.store.storeName.replace(/^麦当劳/, ''))}${c.store.distanceText ? ` · ${plain(c.store.distanceText)}` : ''}</span>
        <span class="num">${yuan(c.best.priceCents)}</span>
      </div>`,
      )
      .join('');
    const spread = Math.max(...r.comparisons.map((c) => c.best.priceCents)) - Math.min(...r.comparisons.map((c) => c.best.priceCents));
    parts.push(`<div class="card"><h3>同单跨门店比价（${r.comparisons.length} 家）</h3>${cmp}
      <p class="hint">同一样东西，换个门店最多差 ${yuan(spread)}</p></div>`);
  }

  // 券专属加购
  if (r.addOns?.length) {
    const list = r.addOns
      .slice(0, 4)
      .map(
        (a) => `
      <div class="row"><span class="k">${plain(a.productName)}　<span class="muted">${plain(String(a.couponTitle).slice(0, 14))}</span></span>
      <span class="v">${yuan(a.listPriceCents)} → ${yuan(a.couponPriceCents)}</span></div>`,
      )
      .join('');
    parts.push(`<div class="card"><h3>券还能这样用</h3><div class="rows">${list}</div>
      <p class="hint">只报商品价，未含配送/打包。</p></div>`);
  }

  // 麦麦省可领券
  if (r.availableCoupons?.count) {
    parts.push(`<div class="card"><h3>麦麦省还有 ${r.availableCoupons.count} 张可领</h3>
      <ul class="itemlist">${r.availableCoupons.titles.slice(0, 6).map((t) => `<li><span>${plain(t)}</span></li>`).join('')}</ul>
      <p class="hint">这些券要先在麦当劳 App「麦麦省」里领取，才会出现在门店券里。</p></div>`);
  }

  if (r.closed?.length) parts.push(closedBox(r.closed));
  if (r.warnings?.length) parts.push(warnBox(r.warnings));

  // 操作按钮
  const actions = ['<button class="btn" id="act-copy">复制点餐卡</button>'];
  if (payload.canOrder) actions.push('<button class="btn" id="act-order">生成付款链接</button>');
  parts.push(`<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap">${actions.join('')}</div>
    <p class="hint">${payload.canOrder ? '「生成付款链接」会创建一张<b>真实未支付订单</b>，付款必须你自己在麦当劳页面完成。' : '演示模式不提供下单入口。'}</p>
    <p class="hint">本次共调用官方算价 ${r.callsUsed} 次。</p></div>`);

  // 原始报告
  parts.push(`<details class="more"><summary>查看原始点餐卡（纯文本）</summary><pre class="raw">${plain(payload.text || '')}</pre></details>`);

  return parts.join('');
}

/** 团餐结果 → HTML（不绑定任何事件）。 */
export function renderGroup(payload) {
  const r = payload?.result;
  if (!r) return '<div class="errbox">没有拿到结果</div>';
  const parts = [];
  if (payload.demo) parts.push('<div class="warnbox">演示数据：门店名、餐品与价格都是构造的，不是真实门店报价。</div>');

  if (!r.best) {
    parts.push('<div class="errbox"><b>没有可用方案</b></div>');
    if (r.warnings?.length) parts.push(warnBox(r.warnings));
    return parts.join('');
  }

  const b = r.best;
  parts.push(`
    <div class="hero">
      <div class="label">最优方案 · ${plain(b.store.storeName)}</div>
      <div class="price">${yuan(b.totals.price)}</div>
      <div class="sub">
        <span class="badge">人均 ${yuan(b.totals.perHeadCents)}</span>
        <span class="badge">省 ${yuan(b.savedCents)}</span>
        ${b.orderCount > 1 ? `<span class="badge">拆 ${b.orderCount} 单</span>` : '<span class="badge">1 单搞定</span>'}
      </div>
    </div>`);

  const rows = [
    row('助餐档位', b.assistance?.gmServiceName || b.assistance?.gmServiceCode || '—'),
    row('商品小计', yuan(b.totals.productOriginalPrice)),
    row('优惠', `−${yuan(b.totals.discount)}`, 'minus'),
  ];
  if (b.totals.deliveryPrice) rows.push(row('配送费', yuan(b.totals.deliveryPrice)));
  if (b.totals.packingPrice) rows.push(row('打包费', yuan(b.totals.packingPrice)));
  rows.push(row(`实付（${b.orderCount} 单合计）`, yuan(b.totals.price), 'total'));
  rows.push(row('人均', yuan(b.totals.perHeadCents)));
  parts.push(`<div class="card"><h3>金额怎么来的</h3><div class="rows">${rows.join('')}</div>
    ${b.basketLabel ? `<p class="hint">篮子：${plain(b.basketLabel)}${b.basketTier ? ` · ${plain(b.basketTier)}` : ''}</p>` : ''}</div>`);

  if (r.verdict) {
    const v = typeof r.verdict === 'string' ? r.verdict : r.verdict.headline || r.verdict.text || r.verdict.reason || JSON.stringify(r.verdict);
    parts.push(`<div class="card"><h3>拆单结论</h3><p>${plain(v)}</p>
      ${r.bestSplit && r.bestSplit.totals.price < b.totals.price ? `<p class="hint">拆单更省：${yuan(r.bestSplit.totals.price)}（省 ${yuan(b.totals.price - r.bestSplit.totals.price)}）</p>` : ''}
      </div>`);
  }

  const others = (r.plans ?? []).slice(1, 6);
  if (others.length) {
    const cmp = others
      .map(
        (p) => `<div class="cmp"><span class="name">${plain(p.store.storeName.replace(/^麦当劳/, ''))}</span>
      <span class="num">${yuan(p.totals.price)}<span class="muted" style="font-weight:400"> /人均${yuan(p.totals.perHeadCents)}</span></span></div>`,
      )
      .join('');
    parts.push(`<div class="card"><h3>其它门店方案</h3>${cmp}
      <p class="hint">同门店换个助餐档位，最差与最好差 ${yuan(r.savings?.vsSameStoreWorstCents ?? 0)}</p></div>`);
  }

  if (r.warnings?.length) parts.push(warnBox(r.warnings));
  parts.push(`<div class="card"><button class="btn" id="g-copy">复制完整报告</button>
    <p class="hint">本次共调用官方算价 ${r.callsUsed} 次。</p></div>`);
  parts.push(`<details class="more"><summary>查看完整报告（纯文本）</summary><pre class="raw">${plain(payload.text || '')}</pre></details>`);

  return parts.join('');
}

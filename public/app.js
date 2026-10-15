/**
 * 麦麦省 · 手机端前端（零依赖、无构建步骤）。
 *
 * 设计要点：
 *  1. 访问码从 URL 的 ?k= 取一次 → 存 localStorage → 从地址栏抹掉，之后短地址即可用；
 *  2. 比价走「建任务 + SSE 拿进度」，真实链路要跑几十次官方算价，没有进度会像卡死；
 *  3. 所有金额都直接来自服务端返回的「分」，前端只做展示格式化，不重算。
 *
 * 「结果对象 → HTML」的部分拆在 ./render.js，因为那是纯函数、可以在 Node 里跑测试
 * （本项目没有构建步骤，测试就是它的编译期）。这里只负责 DOM、事件与网络。
 */

import { renderPhone, renderGroup, yuan, plain } from './render.js';

// ───────────────────────────────────────── 基础工具

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function showSheet(title, text) {
  $('#sheet-title').textContent = title;
  $('#sheet-text').value = text;
  $('#sheet').classList.remove('hidden');
  const ta = $('#sheet-text');
  ta.focus();
  ta.setSelectionRange(0, 0);
}

async function copyText(text, label = '已复制') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(label);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  // http:// 局域网页面没有 clipboard API：给一个可长按复制的文本框
  showSheet('长按选中复制（或按 Ctrl/Cmd+C）', text);
  return false;
}

// ───────────────────────────────────────── 访问码

const KEY_STORE = 'mcd.accessKey';
let accessKey = '';

function initKey() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('k');
  if (fromUrl) {
    accessKey = fromUrl.trim().toUpperCase();
    try { localStorage.setItem(KEY_STORE, accessKey); } catch { /* 隐私模式 */ }
    url.searchParams.delete('k');
    history.replaceState(null, '', url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash);
  } else {
    try { accessKey = (localStorage.getItem(KEY_STORE) || '').trim(); } catch { accessKey = ''; }
  }
}

function askForKey(message) {
  $('#gate').classList.remove('hidden');
  $('#gate-msg').textContent = message || '';
  $('#gate-input').value = '';
  setTimeout(() => $('#gate-input').focus(), 60);
}

$('#gate-btn')?.addEventListener('click', async () => {
  const v = $('#gate-input').value.trim().toUpperCase();
  if (v.length < 4) return;
  accessKey = v;
  const res = await api('/api/ping', { silent: true });
  if (res?.ok) {
    try { localStorage.setItem(KEY_STORE, accessKey); } catch { /* ignore */ }
    $('#gate').classList.add('hidden');
    boot();
  } else {
    $('#gate-msg').textContent = '访问码不对，请核对电脑上打印的那一串（仅本次运行有效）';
  }
});
$('#gate-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-btn').click(); });

// ───────────────────────────────────────── API

async function api(path, { method = 'GET', body, silent = false } = {}) {
  const headers = {};
  if (accessKey) headers['X-Mcd-Key'] = accessKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    if (!silent) toast('连不上服务：手机和电脑是不是同一个 Wi-Fi？');
    return null;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 || data?.code === 'BAD_KEY') {
    if (!silent) askForKey();
    return data ?? { ok: false, code: 'BAD_KEY' };
  }
  return data;
}

// ───────────────────────────────────────── 标签页

function showTab(name) {
  for (const p of $$('.tab-panel')) p.classList.toggle('hidden', p.id !== `tab-${name}`);
  for (const t of $$('.tab-item')) t.classList.toggle('active', t.dataset.tab === name);
  window.scrollTo({ top: 0 });
}

for (const t of $$('.tab-item')) t.addEventListener('click', () => showTab(t.dataset.tab));

// ───────────────────────────────────────── 通用：任务 + 进度

/**
 * 跑一个任务并把日志实时写进 <pre>，返回最终 payload。
 * 优先用 SSE；不支持或中途断开时退化为轮询。
 */
function runJob({ kind, params, logEl, titleEl, boxEl, onDone }) {
  return api('/api/jobs', { method: 'POST', body: { kind, params } }).then((created) => {
    if (!created?.jobId) {
      boxEl.classList.add('hidden');
      toast(created?.error || '创建任务失败');
      return null;
    }
    boxEl.classList.remove('hidden');
    if (titleEl) titleEl.textContent = '正在比价…';
    logEl.textContent = '';
    const append = (line) => {
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (payload, error) => {
        if (settled) return;
        settled = true;
        boxEl.classList.add('hidden');
        if (error) {
          toast('比价失败：' + String(error.message || error).slice(0, 40));
          onDone(null, error);
        } else {
          onDone(payload, null);
        }
        resolve(payload ?? null);
      };

      function poll() {
        const timer = setInterval(async () => {
          const r = await api(`/api/jobs/${created.jobId}`, { silent: true });
          if (!r?.job) return;
          const j = r.job;
          if (logEl.textContent.split('\n').length - 1 < j.logs.length) {
            logEl.textContent = j.logs.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
          }
          if (j.status !== 'running') {
            clearInterval(timer);
            finish(j.status === 'done' ? j.result : null, j.status === 'done' ? null : j.error);
          }
        }, 1500);
      }

      if (!window.EventSource) return poll();

      const es = new EventSource(`/api/jobs/${created.jobId}/stream${accessKey ? `?k=${encodeURIComponent(accessKey)}` : ''}`);
      es.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === 'snapshot') {
          for (const l of d.logs ?? []) append(l);
          // 连上来的时候任务可能已经结束了（演示模式几乎必然如此），必须就地收尾，否则界面一直转圈
          if (d.status && d.status !== 'running') {
            es.close();
            finish(d.status === 'done' ? (d.payload ?? null) : null, d.status === 'done' ? null : d.error);
          }
        } else if (d.type === 'log') {
          append(d.line);
        } else if (d.type === 'done') {
          es.close();
          finish(d.status === 'done' ? (d.payload ?? null) : null, d.status === 'done' ? null : d.error);
        }
      };
      es.onerror = () => {
        // SSE 断了不一定代表任务失败：退回轮询确认
        if (!settled) {
          es.close();
          poll();
        }
      };
    });
  });
}

// ───────────────────────────────────────── 表单：点餐

const CHIPS = ['巨无霸', '麦辣鸡腿堡', '板烧鸡腿堡', '薯条', '中杯美式', '中杯可乐', '麦乐鸡', '双层吉士汉堡', '香芋派', '脆薯饼'];

function buildChips() {
  const box = $('#want-chips');
  box.innerHTML = '';
  for (const c of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = c;
    b.addEventListener('click', () => {
      const input = $('#p-want');
      const parts = input.value.split(/[,，\s]+/).filter(Boolean);
      if (parts.includes(c)) input.value = parts.filter((p) => p !== c).join(',');
      else input.value = [...parts, c].join(',');
    });
    box.appendChild(b);
  }
}

let channel = 'pickup';
for (const b of $$('#channel-seg .seg-item')) {
  b.addEventListener('click', () => {
    channel = b.dataset.channel;
    for (const x of $$('#channel-seg .seg-item')) x.classList.toggle('active', x === b);
    $('#pickup-fields').classList.toggle('hidden', channel !== 'pickup');
    $('#delivery-fields').classList.toggle('hidden', channel !== 'delivery');
    if (channel === 'delivery') loadAddresses();
  });
}

async function loadAddresses() {
  const r = await api('/api/addresses', { silent: true });
  const list = r?.addresses ?? [];
  for (const sel of ['#p-address', '#g-address']) {
    const el = $(sel);
    if (!el) continue;
    el.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = r?.error?.message ? `读不到地址簿：${String(r.error.message).slice(0, 30)}` : '（地址簿为空，请先在麦当劳 App 保存地址）';
      el.appendChild(o);
      continue;
    }
    for (const a of list) {
      const o = document.createElement('option');
      o.value = a.addressId;
      o.dataset.text = a.fullAddress;
      o.textContent = `${a.fullAddress}${a.contactName ? `（${a.contactName}）` : ''}`;
      el.appendChild(o);
    }
  }
}

$('#p-run')?.addEventListener('click', () => {
  const params = {
    channel,
    city: $('#p-city').value.trim(),
    keyword: $('#p-keyword').value.trim(),
    want: $('#p-want').value.trim(),
    budget: $('#p-budget').value.trim(),
    stores: $('#p-stores').value.trim(),
    couponScan: $('#p-couponscan').checked,
    includeClosed: $('#p-closed').checked,
  };
  if (channel === 'delivery') {
    const sel = $('#p-address');
    params.addressQuery = sel.selectedOptions[0]?.dataset.text || '';
    if (!sel.value) return toast('请先选择一个收货地址');
  } else if (!params.city) {
    return toast('到店自取需要填「城市」，如 西安市');
  }
  $('#p-result').innerHTML = '';
  runJob({
    kind: 'phone',
    params,
    logEl: $('#p-log'),
    titleEl: $('#p-progress-title'),
    boxEl: $('#p-progress'),
    onDone: (payload, error) => {
      if (error) {
        $('#p-result').innerHTML = `<div class="errbox"><b>比价失败</b><br>${plain(error.message)}</div>`;
        return;
      }
      paintPhone(payload);
    },
  });
});

/** 把渲染结果贴进页面，并绑定结果里的按钮（渲染本身是纯函数，见 render.js）。 */
function paintPhone(payload) {
  const box = $('#p-result');
  box.innerHTML = renderPhone(payload);
  const b = payload?.result?.best;
  if (!b) return;

  $('#act-copy')?.addEventListener('click', () => copyText(payload.text || '', '点餐卡已复制'));
  $('#act-order')?.addEventListener('click', async (e) => {
    const ok = confirm(
      `将创建一张真实订单（未支付）：\n\n门店：${b.store.storeName}\n实付：${yuan(b.best.priceCents)}\n\n` +
        '只创建订单、不自动付款；付款链接会返回给你自己确认。继续？',
    );
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '正在创建…';
    const res = await api(`/api/jobs/${payload.jobId ?? ''}/order`, { method: 'POST', body: { confirm: true, addressId: b.addressId } });
    if (res?.ok) {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `<h3>订单已创建（未支付）</h3>
        <div class="rows"><div class="row"><span class="k">订单号</span><span class="v">${plain(res.order.orderId)}</span></div>
        <div class="row total"><span class="k">应付</span><span class="v">¥${plain(res.order.amount)}</span></div></div>
        <p class="hint">在手机上直接打开下面的链接付款（请自己核对金额与门店）：</p>
        <p style="word-break:break-all"><a href="${plain(res.order.payH5Url)}">${plain(res.order.payH5Url)}</a></p>`;
      box.insertBefore(el, box.firstChild);
      toast('订单已创建，请自行核对后付款');
    } else {
      toast(res?.error?.message || res?.error || '下单失败');
    }
    btn.disabled = false;
    btn.textContent = '生成付款链接';
  });
}

// ───────────────────────────────────────── 表单：团餐

$('#g-run')?.addEventListener('click', () => {
  const params = {
    people: $('#g-people').value.trim(),
    budget: $('#g-budget').value.trim(),
    prefer: $('#g-prefer').value.trim(),
    addressQuery: $('#g-address').selectedOptions[0]?.dataset.text || '',
  };
  if (!params.people || !params.budget) return toast('请填「人数」和「人均预算」');
  $('#g-result').innerHTML = '';
  runJob({
    kind: 'optimize',
    params,
    logEl: $('#g-log'),
    titleEl: $('#g-progress-title'),
    boxEl: $('#g-progress'),
    onDone: (payload, error) => {
      if (error) {
        $('#g-result').innerHTML = `<div class="errbox"><b>比价失败</b><br>${plain(error.message)}</div>`;
        return;
      }
      const box = $('#g-result');
      box.innerHTML = renderGroup(payload);
      $('#g-copy')?.addEventListener('click', () => copyText(payload.text || '', '报告已复制'));
    },
  });
});

// ───────────────────────────────────────── 我的

$('#m-doctor')?.addEventListener('click', async (e) => {
  const box = $('#m-doctor-out');
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '检查中…';
  const r = await api('/api/health?deep=1');
  btn.disabled = false;
  btn.textContent = '运行自检';
  if (!r) return;

  const line = (k, v) => `<div class="row"><span class="k">${plain(k)}</span><span class="v">${plain(v)}</span></div>`;
  const rows = [line('模式', r.demo ? '离线演示' : '真实 MCP'), line('Token 来源', r.from || '—'), line('Node', `${r.node} · ${r.platform}`)];
  if (r.ok) {
    rows.push(line('握手', r.handshake?.server?.name ? `✅ ${r.handshake.server.name} v${r.handshake.server.version}` : '✅'));
    rows.push(line('工具数', String(r.tools?.count ?? '—')));
    for (const t of r.tools?.key ?? []) rows.push(line(`　${t.name}`, t.found ? '✅' : '❌'));
    rows.push(line('地址簿', `${r.addresses?.count ?? 0} 条${r.addresses?.count ? '' : ' ⚠️ 没有地址就查不到外送/团餐门店'}`));
    rows.push(line('本次请求数', String(r.callsUsed ?? '—')));
  } else {
    rows.push(line('结果', '❌ 失败'));
  }
  box.innerHTML = `<div class="rows">${rows.join('')}</div>${r.error ? `<div class="errbox" style="margin-top:10px">${plain(r.error.message)}</div>` : ''}`;
  if (r.addresses?.items?.length) {
    box.insertAdjacentHTML('beforeend', `<ul class="itemlist" style="margin-top:8px">${r.addresses.items.map((a) => `<li><span>${plain(a.fullAddress)}</span></li>`).join('')}</ul>`);
  }
});

$('#m-addr')?.addEventListener('click', async () => {
  const box = $('#m-addr-out');
  box.innerHTML = '<p class="hint">读取中…</p>';
  const r = await api('/api/addresses');
  if (!r?.addresses?.length) {
    box.innerHTML = `<div class="errbox">${plain(r?.error?.message || '地址簿为空')}</div>`;
    return;
  }
  box.innerHTML = `<ul class="itemlist">${r.addresses.map((a) => `<li><span>${plain(a.fullAddress)}</span><span class="qty">${plain(a.contactName || '')}</span></li>`).join('')}</ul>`;
});

$('#sheet-close')?.addEventListener('click', () => $('#sheet').classList.add('hidden'));
$('#sheet')?.addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').classList.add('hidden'); });

// ───────────────────────────────────────── 启动

async function boot() {
  const ping = await api('/api/ping', { silent: true });
  if (!ping?.ok) {
    if (ping?.code === 'BAD_KEY' || !accessKey) return askForKey();
    $('#mode-pill').textContent = '连不上服务';
    $('#mode-pill').className = 'pill err';
    return;
  }
  if (ping.needKey && !accessKey) return askForKey();

  const pill = $('#mode-pill');
  if (ping.demo) {
    pill.textContent = '离线演示';
    pill.className = 'pill demo';
  } else {
    pill.textContent = '真实 MCP';
    pill.className = 'pill live';
  }
  $('#m-about').innerHTML =
    `mcd-groupmeal 手机端 v${plain(ping.version)}<br>服务运行在 ${plain(ping.platform)} · Node ${plain(ping.node)}<br>` +
    'Token 只保存在服务端，浏览器拿不到。<br>' +
    '本项目只做「算钱」：帮你决定去哪家店、点哪些、勾哪张券、实付多少；下单与付款始终由你自己在麦当劳 App/网页完成。';

  buildChips();
  loadAddresses();
  if (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker?.register('/sw.js').catch(() => {});
  }
}

initKey();
boot();

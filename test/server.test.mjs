/**
 * 手机端服务单测（`node --test test/`）。
 *
 * 覆盖三块：
 *   ① 纯函数：访问码、局域网地址识别、任务仓库的清理策略；
 *   ② HTTP 行为：静态资源、路径穿越防护、访问码鉴权、错误码；
 *   ③ 端到端：离线演示模式下真的跑完一次「手机点餐比价」与一次「团餐比价」，
 *      并验证 SSE 进度流能拿到最终结果（这是手机端「不卡死」的关键路径）。
 *
 * 全部在 demo 模式跑：不联网、不需要 Token，可以在任何机器上重现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, listenWithFallback, lanAddresses, makeAccessKey, JobStore } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);

// ───────────────────────────────────────── ① 纯函数

test('makeAccessKey：长度正确、只用无歧义字符', () => {
  const key = makeAccessKey();
  assert.equal(key.length, 6);
  assert.match(key, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.doesNotMatch(key, /[01OIL]/, '不能出现 0/O/1/I/L 这类容易看错的字符');
  // 多次调用应当不同（64 字符表 6 位，碰撞概率可忽略）
  const keys = new Set(Array.from({ length: 50 }, () => makeAccessKey()));
  assert.equal(keys.size, 50);
});

test('lanAddresses：过滤回环，虚拟网卡排在后面', () => {
  const fake = {
    'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.23' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    'Ethernet': [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
  };
  const list = lanAddresses(fake);
  assert.deepEqual(list.map((x) => x.address), ['192.168.1.23', '10.0.0.5', '172.20.0.1']);
  assert.ok(!list.some((x) => x.address === '127.0.0.1'), '回环地址不能出现在「手机上打开」里');
  assert.ok(!list.some((x) => x.address === 'fe80::1'), '只取 IPv4');
});

test('JobStore：容量上限与过期清理', () => {
  const store = new JobStore({ max: 3, ttlMs: 1000 });
  const ids = [store.create('phone').id, store.create('phone').id, store.create('phone').id, store.create('phone').id];
  assert.equal(store.map.size, 3, '超过上限要淘汰最旧的');
  assert.equal(store.get(ids[0]), null);

  const job = store.create('phone');
  job.startedAt = Date.now();
  job.finish({ ok: true });
  assert.ok(store.get(job.id), '刚结束的任务应当还能读到');
  job.endedAt = Date.now() - 5000; // 假装已经过了 TTL
  assert.equal(store.get(job.id), null, '超过 TTL 的任务应当被清掉');
});

// ───────────────────────────────────────── 测试脚手架

const KEY = 'ABC234';

async function withServer(fn, { demo = true, accessKey = KEY } = {}) {
  const server = createServer({ demo, accessKey, jobs: new JobStore(), tokenFrom: 'test', explicitToken: undefined });
  const addr = await listenWithFallback(server, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const H = { 'X-Mcd-Key': KEY };

/** 读一条 SSE，直到收到 done（或超时）。 */
async function readSSE(url, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          events.push(JSON.parse(line.slice(5).trim()));
        }
      }
      if (events.some((e) => e.type === 'done')) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ───────────────────────────────────────── ② HTTP 行为

test('静态资源：首页 / CSS / manifest 都能取到，且带正确 Content-Type', async () => {
  await withServer(async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.match(html, /麦麦省/);
    assert.match(html, /\/app\.js/, '首页必须引用前端脚本');

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const man = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(man.status, 200);
    assert.match(man.headers.get('content-type'), /manifest\+json/);
    assert.equal((await man.json()).short_name, '麦麦省');
  });
});

test('路径穿越：不能读到 public 之外的文件', async () => {
  await withServer(async (base) => {
    // mcp-config.json 里有真 Token，是这条防线最该保护的目标
    for (const p of ['/../mcp-config.json', '/..%2Fmcp-config.json', '/%2e%2e/package.json', '/../../Windows/win.ini']) {
      const res = await fetch(base + p);
      assert.ok([403, 404].includes(res.status), `${p} 应当被拒绝，实际 ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('Authorization'), `${p} 不能泄露配置内容`);
    }
  });
});

test('访问码：/api/ping 免鉴权，其余 /api/* 必须带码', async () => {
  await withServer(async (base) => {
    const ping = await fetch(`${base}/api/ping`);
    assert.equal(ping.status, 200);
    const info = await ping.json();
    assert.equal(info.ok, true);
    assert.equal(info.needKey, true);
    assert.equal(info.demo, true);

    const noKey = await fetch(`${base}/api/health`);
    assert.equal(noKey.status, 401);
    assert.equal((await noKey.json()).code, 'BAD_KEY');

    const badKey = await fetch(`${base}/api/health`, { headers: { 'X-Mcd-Key': 'WRONG1' } });
    assert.equal(badKey.status, 401);

    const good = await fetch(`${base}/api/health`, { headers: H });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);

    // 也支持 ?k= 形式（手机第一次打开的链接就是这个形状）
    const viaQuery = await fetch(`${base}/api/health?k=${KEY}`);
    assert.equal(viaQuery.status, 200);
  });
});

test('关闭访问码时（--no-key）任意请求可通过', async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
    },
    { accessKey: '' },
  );
});

test('地址簿（演示数据）可读，且不含 Token 字段', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/addresses`, { headers: H });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.addresses.length, 1);
    assert.match(body.addresses[0].fullAddress, /演示市/);
    assert.ok(!/token|Authorization/i.test(JSON.stringify(body)), '响应里不能出现 Token');
  });
});

test('建任务：kind 不合法要 400，未知任务 id 要 404', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'nope' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'BAD_KIND');

    const missing = await fetch(`${base}/api/jobs/0123456789abcdef`, { headers: H });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'NO_JOB');
  });
});

// ───────────────────────────────────────── 前端静态一致性

test('前端一致性：app.js 里引用的每个 DOM id 都存在于 index.html', async () => {
  const html = readFileSync(PUBLIC('index.html'), 'utf8');
  // 界面拆成两块：app.js 管 DOM/事件，render.js 管「结果 → HTML」的纯渲染
  const appJs = readFileSync(PUBLIC('app.js'), 'utf8');
  const renderJs = readFileSync(PUBLIC('render.js'), 'utf8');
  const js = `${appJs}\n${renderJs}`;

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 渲染层自己也会产出带 id 的片段（结果卡片里的按钮），一并算作「存在」
  for (const m of js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) ids.add(m[1]);
  const referenced = new Set();
  // $('...') / $$('...') 里出现的 #id（含后代选择器，只取第一段 id）
  for (const m of appJs.matchAll(/\$\$?\(\s*'([^']+)'/g)) {
    const hit = /#([A-Za-z0-9_-]+)/.exec(m[1]);
    if (hit) referenced.add(hit[1]);
  }
  const missing = [...referenced].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js 引用了 index.html 里不存在的 id：${missing.join(', ')}`);
  assert.ok(referenced.size > 15, '应当真的扫到一批 id（防止正则失效变成空跑）');

  // 反过来：标签页按钮的 data-tab 必须和面板 id 对得上
  const tabs = [...html.matchAll(/class="tab-item[^"]*" data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['phone', 'group', 'me']);
  for (const t of tabs) assert.ok(ids.has(`tab-${t}`), `缺少面板 tab-${t}`);

  // 前端引用的静态资源必须真的存在（没有构建步骤，漏文件就是白屏）
  for (const asset of ['app.js', 'render.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'sw.js']) {
    assert.ok(`${html}\n${js}`.match(new RegExp(`\\.?/${asset.replace('.', '\\.')}\\b`)), `没有地方引用 ${asset}`);
    assert.ok(statSync(PUBLIC(asset)).isFile(), `public/ 里缺少 ${asset}`);
  }
});

// ───────────────────────────────────────── ③ 端到端（demo 模式）

test('端到端：手机点餐比价跑通，SSE 能拿到进度与最终结果', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'phone', params: { channel: 'pickup', city: '演示市', keyword: '演示路', want: '巨无霸,中杯美式' } }),
    });
    assert.equal(created.status, 202);
    const { jobId } = await created.json();
    assert.match(jobId, /^[0-9a-f]{16}$/);

    const events = await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`);
    assert.ok(events.length >= 2, '至少要有快照 + 结果两类事件');
    assert.equal(events[0].type, 'snapshot');
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.status, 'done', `任务应当成功，实际 ${JSON.stringify(done.error)}`);

    const payload = done.payload;
    assert.equal(payload.kind, 'phone');
    assert.equal(payload.demo, true);
    assert.equal(payload.canOrder, false, '演示模式不能提供下单入口');
    assert.ok(payload.result.comparisons.length >= 1, '演示数据里应当有可比价的门店');
    assert.ok(payload.result.best.best.priceCents > 0, '实付必须大于 0，且来自 calculate-price');
    assert.ok(typeof payload.text === 'string' && payload.text.includes('手机点餐卡'));
    // 「券找货」：券专属商品应当被识别出来（演示数据 9001 美式中杯）
    const hasCouponOnly = payload.result.comparisons.some((c) => c.couponOnlyItems.length > 0);
    assert.ok(hasCouponOnly, '应当识别出「菜单里没有、只有券才能买」的商品');
  });
});

test('端到端：打烊门店被排除而不是被当成「没有菜单」', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'phone', params: { channel: 'pickup', city: '演示市', keyword: '演示路', want: '巨无霸' } }),
    });
    const { jobId } = await created.json();
    const done = (await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`)).at(-1);
    assert.equal(done.status, 'done');
    assert.ok(done.payload.result.closed.length >= 1, '演示数据里有一家打烊门店');
    assert.match(done.payload.result.closed[0].reason, /营业|关闭/);
  });
});

test('端到端：团餐比价跑通并带拆单结论', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'optimize', params: { people: 20, budget: 35 } }),
    });
    assert.equal(created.status, 202);
    const { jobId } = await created.json();
    const done = (await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`)).at(-1);
    assert.equal(done.status, 'done', `团餐比价应当成功，实际 ${JSON.stringify(done.error)}`);
    const { result, text } = done.payload;
    assert.ok(result.best, '应当有最优方案');
    assert.ok(result.best.totals.price > 0);
    assert.equal(result.best.totals.perHeadCents, Math.round(result.best.totals.price / 20));
    assert.equal(done.payload.jobId, jobId, 'payload 必须带 jobId，手机端下单要用它');
    assert.ok(text.length > 100, '应当附带纯文本报告');
  });
});

test('参数缺失：团餐不给人数/预算要如实失败并说明原因', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'optimize', params: { people: 0 } }),
    });
    const { jobId } = await created.json();
    const done = (await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`)).at(-1);
    assert.equal(done.status, 'failed');
    assert.equal(done.error.code, 'BAD_PARAMS');
    assert.match(done.error.message, /人数|预算/);
  });
});

test('下单接口：演示模式必须拒绝，且要求 confirm=true', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'phone', params: { channel: 'pickup', city: '演示市', keyword: '演示路', want: '巨无霸' } }),
    });
    const { jobId } = await created.json();
    await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`);

    const res = await fetch(`${base}/api/jobs/${jobId}/order`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'DEMO_MODE', '演示模式绝不能创建真实订单');
  });
});

test('轮询接口：任务结束后 GET /api/jobs/:id 能拿到同样的结果', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'phone', params: { channel: 'pickup', city: '演示市', keyword: '演示路', want: '巨无霸' } }),
    });
    const { jobId } = await created.json();
    await readSSE(`${base}/api/jobs/${jobId}/stream?k=${KEY}`);
    const poll = await fetch(`${base}/api/jobs/${jobId}`, { headers: H });
    assert.equal(poll.status, 200);
    const { job } = await poll.json();
    assert.equal(job.status, 'done');
    assert.ok(job.result.result.best, 'SSE 断了也要能用轮询拿到结果');
    assert.ok(job.logs.length > 0, '进度日志要保留下来');
    assert.equal(job.client, undefined, '内部 MCP 会话不能被序列化出去');
  });
});

test('端口占用时自动顺延，不影响启动', async () => {
  const a = createServer({ demo: true, accessKey: '', jobs: new JobStore() });
  const first = await listenWithFallback(a, { port: 0, host: '127.0.0.1' });
  const b = createServer({ demo: true, accessKey: '', jobs: new JobStore() });
  const second = await listenWithFallback(b, { port: first.port, host: '127.0.0.1', maxTries: 5 });
  try {
    assert.notEqual(second.port, first.port);
    assert.ok(second.port > first.port, '被占用的端口之后顺延');
    const ping = await fetch(`http://127.0.0.1:${second.port}/api/ping`);
    assert.equal(ping.status, 200);
  } finally {
    await new Promise((r) => a.close(r));
    await new Promise((r) => b.close(r));
  }
});

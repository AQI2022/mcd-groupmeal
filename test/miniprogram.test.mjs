/**
 * 微信小程序端单测（`node --test test/`）。
 *
 * 微信开发者工具不能在这里跑，所以覆盖策略是「把能在 Node 里验证的部分全部验证掉」：
 *   ① 工程完整性：app.json 的页面都有四件套；wxml 里绑的事件在页面 js 里都实现了；
 *   ② 纯函数：金额格式化 + 「结果对象 → 视图模型」（真实实测快照与离线引擎结果都过一遍）；
 *   ③ API 层端到端：用假 wx 把 miniprogram/utils/api.js 打到真实的 src/server.mjs（demo 模式），
 *      走完「ping → 地址簿 → 建任务 → 增量轮询 → 结果」这条小程序真实路径；
 *   ④ 云函数端到端：直接把 cloudfunctions/mcd/index.js 当本地函数调用（demo 模式），
 *      验证云开发通道的入参/出参契约，以及云函数 lib 与 src 的同步没漂移；
 *   ⑤ 安全：仓库与小程序包里不能出现真实 Token。
 *
 * 全部离线，不需要 Token、不发真实网络请求（除非本机有 mcp-config.json 用来做泄露检查）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createServer, listenWithFallback, JobStore } from '../src/server.mjs';
import { MockClient } from '../src/mock.mjs';
import { solvePhoneOrder, CHANNEL } from '../src/phone.mjs';
import { optimize } from '../src/optimizer.mjs';
import { slimGroupResult, slimPhoneResult } from '../src/slim.mjs';
import { httpFetch } from '../src/http-fetch.mjs';
import { syncCloudLib, CLOUD_FILES } from '../tools/build-mp-cloud.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const require = createRequire(import.meta.url);

const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

/**
 * 小程序代码是 CommonJS（`require` / `module.exports`，微信官方文档保证的模块化写法）。
 * 但仓库根 `package.json` 是 `"type": "module"`，Node 直接 require 会把它们当 ESM。
 * 所以这里用 20 行加载器按 CJS 语义求值——顺带把「小程序里不许依赖 npm 包」也变成断言。
 */
function loadMiniprogramModule(entry) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const dir = path.dirname(file);
    const localRequire = (spec) => {
      if (!spec.startsWith('.')) throw new Error('小程序代码不允许依赖 npm 包：' + spec);
      let target = path.resolve(dir, spec);
      if (!target.endsWith('.js')) target += '.js';
      return load(target);
    };
    const source = read(file);
    new Function('exports', 'require', 'module', '__filename', '__dirname', source)(module.exports, localRequire, module, file, dir);
    return module.exports;
  }
  return load(entry);
}

const view = loadMiniprogramModule(path.join(MP, 'utils', 'view.js'));
const money = loadMiniprogramModule(path.join(MP, 'utils', 'money.js'));
const api = loadMiniprogramModule(path.join(MP, 'utils', 'api.js'));

// ───────────────────────────────────────── ① 工程完整性

test('小程序工程：app.json 里的每个页面都有 js/wxml/wxss/json 四件套', () => {
  const app = readJson(path.join(MP, 'app.json'));
  assert.ok(Array.isArray(app.pages) && app.pages.length >= 3, '至少要有首页/结果/设置三个页面');
  for (const page of app.pages) {
    for (const ext of ['js', 'wxml', 'wxss', 'json']) {
      const file = path.join(MP, `${page}.${ext}`);
      assert.ok(fs.existsSync(file), `缺少文件：${page}.${ext}`);
    }
  }
  assert.ok(fs.existsSync(path.join(MP, app.sitemapLocation)), 'sitemap.json 必须存在');
});

test('小程序工程：所有 .json 都能解析，project.config.json 指向真实目录', () => {
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.json')) files.push(full);
    }
  })(MP);
  assert.ok(files.length >= 5, '小程序目录下的 json 文件太少了');
  for (const f of files) assert.doesNotThrow(() => readJson(f), `JSON 解析失败：${path.relative(ROOT, f)}`);

  const cfg = readJson(path.join(ROOT, 'project.config.json'));
  assert.equal(cfg.miniprogramRoot, 'miniprogram/', 'project.config.json 要指向 miniprogram/');
  assert.equal(cfg.cloudfunctionRoot, 'cloudfunctions/', '云函数目录要指向 cloudfunctions/');
  assert.ok(fs.existsSync(path.join(ROOT, cfg.miniprogramRoot, 'app.json')));
  assert.ok(fs.existsSync(path.join(ROOT, cfg.cloudfunctionRoot, 'mcd', 'index.js')));
  // 开发者工具里「不校验合法域名」的等价开关：真机预览靠它连局域网 HTTP 服务
  assert.equal(cfg.setting.urlCheck, false);
});

test('小程序工程：wxml 里绑定的事件都在页面 js 里实现了', () => {
  const app = readJson(path.join(MP, 'app.json'));
  const problems = [];
  for (const page of app.pages) {
    const wxml = read(path.join(MP, `${page}.wxml`));
    const js = read(path.join(MP, `${page}.js`));
    const handlers = new Set();
    const re = /(?:bind|catch):?([a-z]+)="([A-Za-z_$][\w$]*)"/g;
    let m;
    while ((m = re.exec(wxml))) handlers.add(m[2]);
    for (const h of handlers) {
      // 页面 js 里必须有同名方法：`h(` 或 `h:` 或 `h =`
      const has = new RegExp(`(^|[\\s,{])${h}\\s*[:(=]`, 'm').test(js);
      if (!has) problems.push(`${page}.wxml → ${h}() 未在 ${page}.js 中实现`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('小程序工程：不依赖任何 npm 包，也不引入外部组件', () => {
  const app = readJson(path.join(MP, 'app.json'));
  assert.equal(app.usingComponents, undefined, '全局不要引外部组件');
  for (const page of app.pages) {
    assert.deepEqual(readJson(path.join(MP, `${page}.json`)).usingComponents, {});
  }
  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.deepEqual(pkg.dependencies, {}, '本项目保持零运行时依赖');
});

test('小程序工程：统一用 CommonJS（require / module.exports），不赌 ESM 工具链', () => {
  const offenders = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.js')) continue;
      const src = read(full);
      if (/^\s*import\s.+from\s+['"]/m.test(src)) offenders.push(`${path.relative(MP, full)}：用了 import`);
      if (/^\s*export\s+(default|function|const|class)/m.test(src)) offenders.push(`${path.relative(MP, full)}：用了 export`);
      const requires = src.match(/require\(['"]([^'"]+)['"]\)/g) || [];
      for (const r of requires) {
        if (/require\(['"][^.'"]/.test(r)) offenders.push(`${path.relative(MP, full)}：require 了 npm 包 ${r}`);
      }
    }
  })(MP);
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// ───────────────────────────────────────── ② 纯函数：金额 + 视图模型

test('money.js：分转元、百分比、折扣文案（折数是「7.8 折」不是 0.78）', () => {
  assert.equal(money.yuan(3980), '¥39.80');
  assert.equal(money.yuan(-570), '−¥5.70');
  assert.equal(money.yuan(0), '¥0.00');
  assert.equal(money.plain(5255), '52.55');
  assert.equal(money.percent(20920, 67000), '31.2');
  // 官方 calculate-price 的 enjoyable.realDiscount 单位是「折」：实测 7.8 / 7
  assert.equal(money.rate(7.8), '7.8 折');
  assert.equal(money.rate(7), '7 折');
  assert.equal(money.rate(6.6), '6.6 折');
  assert.equal(money.rate(0), '');
});

test('view.groupVM：离线引擎结果 → 页面模型（含比价矩阵 / 拆单结论 / 凑单提示）', async () => {
  const result = await optimize({
    client: new MockClient(),
    people: 20,
    budgetPerPersonCents: 3500,
    maxCalls: 60,
    variants: 2,
    maxOrders: 2,
  });
  const vm = view.groupVM(result, { people: 20, budgetPerPersonCents: 3500 });
  assert.equal(vm.kind, 'group');
  assert.equal(vm.noPlan, false);
  assert.match(vm.best.priceText, /^¥\d+\.\d{2}$/);
  assert.match(vm.best.perHeadText, /^¥\d+\.\d{2}$/);
  assert.ok(vm.stores.length >= 1, '至少一行比价矩阵');
  assert.equal(vm.stores[0].isBest, true, '第一行必须是最优');
  assert.ok(vm.split && vm.split.headline, '拆单结论不能为空');
  assert.equal(typeof vm.callsUsed, 'number');
  // 金额必须与服务端返回的「分」严格对应，不能在前端重算
  assert.equal(vm.best.priceText, money.yuan(result.best.totals.price));
});

test('view.groupVM：裁剪后的结果（云函数通道）渲染结论完全一致', async () => {
  const result = await optimize({
    client: new MockClient(),
    people: 12,
    budgetPerPersonCents: 4000,
    maxCalls: 45,
    variants: 2,
    maxOrders: 2,
  });
  const full = view.groupVM(result, { people: 12, budgetPerPersonCents: 4000 });
  const slim = view.groupVM(slimGroupResult(result), { people: 12, budgetPerPersonCents: 4000 });
  assert.equal(slim.best.priceText, full.best.priceText);
  assert.equal(slim.best.perHeadText, full.best.perHeadText);
  assert.equal(slim.stores.length, full.stores.length);
  assert.equal(slim.split.headline, full.split.headline);
  assert.equal(slim.overBudget, full.overBudget);
  const before = JSON.stringify(result).length;
  const after = JSON.stringify(slimGroupResult(result)).length;
  assert.ok(after < before, '裁剪后必须更小（否则云函数 1MB 上限没有意义）');
  assert.ok(after < 200 * 1024, `裁剪后仍然太大：${Math.round(after / 1024)}KB`);
});

test('view.phoneVM：离线引擎结果 → 手机点餐卡模型', async () => {
  const result = await solvePhoneOrder({
    client: new MockClient(),
    channel: CHANNEL.PICKUP,
    city: '西安市',
    keyword: '长安大厦',
    want: ['巨无霸'],
    maxStores: 2,
    maxCalls: 10,
  });
  const vm = view.phoneVM(result, { channel: 'pickup' });
  assert.equal(vm.noPlan, false);
  assert.ok(vm.best.items.length >= 1);
  assert.match(vm.best.priceText, /^¥\d+\.\d{2}$/);
  assert.ok(vm.steps.length >= 3, '必须给出「手机上这样操作」的步骤');
  assert.ok(vm.comparisons.length >= 1);
  assert.equal(vm.best.priceText, money.yuan(result.best.best.priceCents));
  // 裁剪后一致
  const slim = view.phoneVM(slimPhoneResult(result), { channel: 'pickup' });
  assert.equal(slim.best.priceText, vm.best.priceText);
  assert.equal(slim.comparisons.length, vm.comparisons.length);
});

test('view.phoneVM：真实「全部门店打烊」快照 → 明确告知原因，而不是空白页', () => {
  const payload = readJson(path.join(ROOT, 'test', 'fixtures', 'real-phone-allclosed.json'));
  const vm = view.phoneVM(payload.result, { channel: 'pickup' });
  assert.equal(vm.noPlan, true);
  assert.ok(vm.closedCount > 0, '快照里应记录了被打烊排除的门店');
  assert.match(vm.headline + vm.hint, /营业时间|打烊/);
  assert.equal(vm.closed.length > 0, true);
});

test('view：纯粹是纯函数，没有 wx 依赖（无 wx 环境下也能跑）', () => {
  const prev = globalThis.wx;
  delete globalThis.wx;
  try {
    const vm = view.groupVM(null, {});
    assert.equal(vm.kind, 'group');
    assert.equal(vm.noPlan, true);
    assert.equal(view.phoneVM(null, {}).noPlan, true);
    assert.deepEqual(view.storeRowsFromPlans([]), []);
  } finally {
    globalThis.wx = prev;
  }
});

// ───────────────────────────────────────── ③ API 层端到端（假 wx → 真服务）

const KEY = 'ABC234';
const CONFIG_STORE = 'mcd.config.v1';

function makeFakeWx() {
  const storage = new Map();
  const calls = [];
  const fake = {
    storage,
    calls,
    getStorageSync(k) {
      return storage.has(k) ? storage.get(k) : '';
    },
    setStorageSync(k, v) {
      storage.set(k, v);
    },
    request(opts) {
      calls.push({ url: opts.url, method: opts.method || 'GET', header: opts.header });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
      const body = opts.data === undefined ? undefined : typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data);
      fetch(opts.url, { method: opts.method || 'GET', headers: opts.header, body, signal: ctrl.signal })
        .then(async (res) => {
          clearTimeout(timer);
          const text = await res.text();
          let data = text;
          try {
            data = JSON.parse(text);
          } catch {
            /* 非 JSON 原样返回 */
          }
          if (opts.success) opts.success({ statusCode: res.status, data });
        })
        .catch((e) => {
          clearTimeout(timer);
          if (opts.fail) opts.fail({ errMsg: `request:fail ${e.name === 'AbortError' ? 'timeout' : e.message}` });
        });
    },
    showToast() {},
    pageScrollTo() {},
    navigateTo() {},
    reLaunch() {},
    showModal() {},
    setClipboardData(o) {
      if (o && o.success) o.success();
    },
    getSystemInfoSync() {
      return { system: 'test-os', SDKVersion: '3.0.0' };
    },
    cloud: undefined,
  };
  return fake;
}

async function withDemoServer(fn) {
  const server = createServer({ demo: true, accessKey: KEY, jobs: new JobStore(), tokenFrom: 'test', explicitToken: undefined });
  const addr = await listenWithFallback(server, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('api.js（HTTP 通道）：ping → 地址簿 → 建任务 → 增量轮询 → 结果', async () => {
  await withDemoServer(async (base) => {
    globalThis.wx = makeFakeWx();
    globalThis.wx.setStorageSync(CONFIG_STORE, { transport: 'http', serverUrl: base, accessKey: KEY });

    const ping = await api.ping();
    assert.equal(ping.ok, true);
    assert.equal(ping.app, 'mcd-groupmeal');
    assert.equal(ping.needKey, true);

    const book = await api.addresses();
    assert.equal(book.ok, true);
    assert.ok(book.addresses.length >= 1, '演示模式也要有地址簿，否则选择器是空的');

    const started = await api.startTask('phone', {
      channel: 'pickup',
      city: '西安市',
      keyword: '长安大厦',
      want: ['巨无霸'],
      stores: 2,
      maxCalls: 10,
    });
    assert.equal(started.transport, 'http');
    assert.match(started.jobId, /^[0-9a-f]{16}$/);

    // 轮询：必须只回增量日志，且在 running 阶段绝不带 result（否则每秒几百 KB）
    let job = null;
    let from = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await api.job(started.jobId, from);
      assert.equal(res.ok, true);
      job = res.job;
      assert.equal(typeof job.logTotal, 'number');
      assert.ok(Array.isArray(job.logs));
      from = job.logTotal;
      if (job.status === 'running') assert.equal(job.result, undefined, 'running 阶段不应回传 result');
      if (job.status !== 'running') break;
    }
    assert.equal(job.status, 'done');
    assert.ok(job.result && job.result.result && job.result.result.best, '必须拿到可用方案');

    const vm = view.phoneVM(job.result.result, { channel: 'pickup' });
    assert.equal(vm.noPlan, false);
    assert.match(vm.best.priceText, /^¥\d+\.\d{2}$/);

    // 游标已消费：再拉应该 0 条新日志
    const again = await api.job(started.jobId, from);
    assert.equal(again.job.logs.length, 0, '增量轮询必须只回新日志');
    assert.equal(again.job.status, 'done');
    assert.ok(again.job.result, '任务结束后必须能拿到结果');

    // 下单：演示模式必须被明确拒绝，不能假装成功
    await assert.rejects(() => api.order(started.jobId, { confirm: true }), (e) => {
      assert.equal(e.code, 'DEMO_MODE');
      return true;
    });
  });
});

test('api.js（HTTP 通道）：访问码错误 → BAD_KEY（ping 不需要访问码，地址簿才校验）', async () => {
  await withDemoServer(async (base) => {
    globalThis.wx = makeFakeWx();
    globalThis.wx.setStorageSync(CONFIG_STORE, { transport: 'http', serverUrl: base, accessKey: 'WRONG1' });
    // /api/ping 故意不校验访问码：手机要靠它判断「是不是同一台服务」
    const ping = await api.ping();
    assert.equal(ping.ok, true);
    // 真正取数据时才校验
    await assert.rejects(() => api.addresses(), (e) => {
      assert.equal(e.code, 'BAD_KEY');
      assert.match(e.message, /访问码/);
      return true;
    });
  });
});

test('api.js（HTTP 通道）：服务没起 → NETWORK 且提示里带排查步骤', async () => {
  globalThis.wx = makeFakeWx();
  globalThis.wx.setStorageSync(CONFIG_STORE, { transport: 'http', serverUrl: 'http://127.0.0.1:1', accessKey: '' });
  await assert.rejects(() => api.ping(), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.match(e.message, /node src\/server\.mjs/);
    return true;
  });
});

// ───────────────────────────────────────── ④ 云函数

const cloudMain = require(path.join(ROOT, 'cloudfunctions', 'mcd', 'index.js')).main;

test('云函数：demo 模式跑通 phone（入参/出参契约）', async () => {
  const out = await cloudMain({
    kind: 'phone',
    demo: true,
    params: { channel: 'pickup', city: '西安市', keyword: '长安大厦', want: ['巨无霸', '中杯美式'] },
  });
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'phone');
  assert.equal(out.demo, true);
  assert.equal(out.canOrder, false, '云函数模式没有持久 MCP 会话，不能下单');
  assert.ok(out.result && out.result.best, '必须返回可用方案');
  assert.match(out.text, /手机点餐卡/);
  assert.ok(Array.isArray(out.logs) && out.logs.length > 0, '云函数模式也要有日志给前端展示');
  assert.ok(JSON.stringify(out).length < 1024 * 1024, '返回值必须小于云函数 1MB 上限');

  const vm = view.phoneVM(out.result, { channel: 'pickup' });
  assert.equal(vm.noPlan, false, '裁剪后的结果必须还能渲染');
});

test('云函数：demo 模式跑通 optimize（含文字版报告）', async () => {
  const out = await cloudMain({ kind: 'optimize', demo: true, params: { people: 20, budget: 35 } });
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'optimize');
  assert.ok(out.result.best, '必须返回可用方案');
  assert.ok(out.text.length > 100, '文字版报告要在裁剪前生成');
  assert.ok(JSON.stringify(out).length < 1024 * 1024);
  const vm = view.groupVM(out.result, { people: 20, budgetPerPersonCents: 3500 });
  assert.equal(vm.noPlan, false);
  assert.match(vm.best.priceText, /^¥\d+\.\d{2}$/);
});

test('云函数：参数缺失 / 未知 kind / 调用口令都有明确错误码', async () => {
  const badKind = await cloudMain({ kind: 'nope' });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error.code, 'BAD_KIND');

  const noParams = await cloudMain({ kind: 'optimize', demo: true, params: {} });
  assert.equal(noParams.ok, false);
  assert.equal(noParams.error.code, 'BAD_PARAMS');

  const prev = process.env.MP_ACCESS_KEY;
  process.env.MP_ACCESS_KEY = 'SECRET1';
  try {
    const denied = await cloudMain({ kind: 'ping', demo: true, key: 'wrong' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'BAD_KEY');

    const allowed = await cloudMain({ kind: 'ping', demo: true, key: 'SECRET1' });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.kind, 'ping');
  } finally {
    if (prev === undefined) delete process.env.MP_ACCESS_KEY;
    else process.env.MP_ACCESS_KEY = prev;
  }
});

test('云函数：没有 Token 时不假装成功，而是给出可操作的错误', async () => {
  const prev = process.env.MCD_MCP_TOKEN;
  delete process.env.MCD_MCP_TOKEN;
  try {
    const ping = await cloudMain({ kind: 'ping' });
    assert.equal(ping.ok, true);
    assert.equal(ping.token, false, '没有 Token 时 ping 要如实报告');

    const real = await cloudMain({ kind: 'phone', params: { channel: 'pickup', city: '西安市', keyword: 'x' } });
    assert.equal(real.ok, false);
    assert.equal(real.error.code, 'NO_TOKEN');
    assert.match(real.error.message, /MCD_MCP_TOKEN/);
  } finally {
    if (prev === undefined) delete process.env.MCD_MCP_TOKEN;
    else process.env.MCD_MCP_TOKEN = prev;
  }
});

test('api.js（云函数通道）：startTask / testConnection 走 wx.cloud.callFunction', async () => {
  const wx = makeFakeWx();
  const cloudCalls = [];
  wx.cloud = {
    init() {},
    callFunction(opts) {
      cloudCalls.push({ name: opts.name, data: opts.data });
      cloudMain(opts.data)
        .then((result) => opts.success({ result }))
        .catch((e) => opts.fail({ errMsg: e.message }));
    },
  };
  globalThis.wx = wx;
  wx.setStorageSync(CONFIG_STORE, { transport: 'cloud', cloudEnv: 'test-env', cloudFn: 'mcd', cloudKey: '' });

  const started = await api.startTask('phone', { channel: 'pickup', city: '西安市', keyword: '长安大厦', want: ['巨无霸'] }, { demo: true });
  assert.equal(started.transport, 'cloud');
  assert.equal(started.payload.ok, true);
  assert.equal(cloudCalls.length, 1);
  assert.equal(cloudCalls[0].name, 'mcd');
  assert.equal(cloudCalls[0].data.demo, true);

  const conn = await api.testConnection();
  assert.equal(conn.ok, true);
  assert.equal(conn.mode, '云函数');

  // 云函数报错要变成可读的 Error
  wx.cloud.callFunction = (opts) => {
    opts.success({ result: { ok: false, error: { message: '算价超时', code: 'TIMEOUT' } } });
  };
  await assert.rejects(() => api.startTask('optimize', { people: 1, budget: 1 }, { demo: true }), (e) => {
    assert.equal(e.code, 'TIMEOUT');
    return true;
  });
});

// ───────────────────────────────────────── ⑤ 云函数 lib 同步 + 安全

test('云函数 lib 与 src/ 同步（防止有人只改了 src 或只改了云函数副本）', () => {
  const result = syncCloudLib({ write: false });
  const drift = result.files.filter((f) => f.status !== 'same');
  assert.deepEqual(drift, [], '运行 node tools/build-mp-cloud.mjs 重新同步');
  assert.equal(CLOUD_FILES.length, Object.keys(result.manifest.files).length);
});

test('安全：仓库与小程序包里不能出现真实 MCP Token', () => {
  const cfgPath = path.join(ROOT, 'mcp-config.json');
  if (!fs.existsSync(cfgPath)) return; // CI 里没有 Token，跳过
  const cfg = readJson(cfgPath);
  const token = String((cfg.token || (cfg.headers && cfg.headers.Authorization) || '').replace(/^Bearer\s+/i, '')).trim();
  if (token.length < 16) return;

  const suspects = [
    path.join(MP),
    path.join(ROOT, 'cloudfunctions'),
    path.join(ROOT, 'src'),
    path.join(ROOT, 'tools'),
    path.join(ROOT, 'docs'),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'project.config.json'),
    path.join(ROOT, 'package.json'),
  ];
  const hits = [];
  (function walk(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    if (!/\.(js|mjs|json|wxml|wxss|md|cmd|sh|yml|yaml|txt)$/.test(p)) return;
    if (p === cfgPath) return;
    if (read(p).includes(token)) hits.push(path.relative(ROOT, p));
  })(ROOT);
  assert.deepEqual(hits, [], `这些文件里有真实 Token：${hits.join(', ')}`);
});

// ───────────────────────────────────────── ⑥ http-fetch 兜底（云函数 Node 16 场景）

test('httpFetch：POST JSON、读 header、跟随 302、AbortSignal 取消', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/json' });
      return res.end();
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const text = JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null, path: req.url });
      res.writeHead(req.url === '/fail' ? 500 : 200, { 'Content-Type': 'application/json', 'X-Echo': 'yes' });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await httpFetch(`${base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: '世界' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('x-echo'), 'yes');
    const json = await res.json();
    assert.equal(json.method, 'POST');
    assert.deepEqual(json.body, { hello: '世界' });

    const redirected = await httpFetch(`${base}/redirect`, { method: 'GET' });
    assert.equal(redirected.status, 200);
    assert.equal((await redirected.json()).path, '/json');

    const failed = await httpFetch(`${base}/fail`, { method: 'GET' });
    assert.equal(failed.status, 500);
    assert.equal(failed.ok, false, 'httpFetch 必须像 fetch 一样如实报告 500，不能抛错');

    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(() => httpFetch(`${base}/json`, { signal: ctrl.signal }), (e) => e.name === 'AbortError');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('McpClient：没有全局 fetch 时自动退到内置 httpFetch（Node 16 云函数场景）', async () => {
  const { McpClient } = await import('../src/mcp-client.mjs');
  const prev = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const client = new McpClient({ token: 'test-token' });
    assert.equal(typeof client.fetchImpl, 'function', '必须能拿到可用的 fetch 实现');
    assert.equal(client.fetchImpl, httpFetch);
  } finally {
    globalThis.fetch = prev;
  }
});

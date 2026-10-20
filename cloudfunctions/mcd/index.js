/**
 * 微信云开发云函数 · mcd
 * ============================================================
 * 作用：在小程序「没有域名、没有备案、没有公网服务器」的前提下，把麦当劳 MCP 代理起来。
 *
 *   小程序 ──wx.cloud.callFunction──▶ 本云函数 ──HTTPS──▶ mcp.mcd.cn
 *                                        │
 *                                        └── 唯一持有 MCP Token 的地方（环境变量）
 *
 * 为什么不能把 Token 放进小程序：小程序包可以被反编译，Token 是账号凭证。
 * 为什么需要一层代理：`mcp.mcd.cn` 不返回 CORS 头，且 MCP 是服务端到服务端协议。
 *
 * 环境变量（云开发控制台 → 云函数 → mcd → 配置）：
 *   MCD_MCP_TOKEN   必填（真实模式下）  MCP Token，不带 "Bearer " 前缀
 *   MCD_MCP_URL     选填，默认 https://mcp.mcd.cn
 *   MP_ACCESS_KEY   选填，设置后小程序必须带同样的「调用口令」才能用
 *   MP_DEMO         选填，设为 0 可关闭演示数据模式
 *
 * 入参：{ kind: 'optimize' | 'phone' | 'ping', params: {...}, demo?: boolean, key?: string }
 * 出参：{ ok, kind, demo, result, text, callsUsed, logs, elapsedMs } 或 { ok:false, error:{message, code} }
 *
 * ⚠️ 超时：云函数默认 3 秒，必须去控制台把它改成 60 秒；小程序端默认开「快速模式」把调用量压到 40~60 次。
 */
'use strict';

const DEFAULT_URL = 'https://mcp.mcd.cn';

// 引擎按需动态加载：冷启动时只加载用到的模块；lib/ 里的文件由 tools/build-mp-cloud.mjs 从 src/ 同步
let enginePromise = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = Promise.all([
      import('./lib/money.mjs'),
      import('./lib/optimizer.mjs'),
      import('./lib/phone.mjs'),
      import('./lib/mcp-client.mjs'),
      import('./lib/mock.mjs'),
      import('./lib/render.mjs'),
      import('./lib/slim.mjs'),
    ]).then(([money, optimizer, phone, mcp, mock, render, slim]) => ({
      yuanToCents: money.yuanToCents,
      optimize: optimizer.optimize,
      solvePhoneOrder: phone.solvePhoneOrder,
      renderPhoneCard: phone.renderPhoneCard,
      CHANNEL: phone.CHANNEL,
      McpClient: mcp.McpClient,
      MockClient: mock.MockClient,
      renderReport: render.renderReport,
      slimGroupResult: slim.slimGroupResult,
      slimPhoneResult: slim.slimPhoneResult,
    }));
  }
  return enginePromise;
}

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function readToken() {
  return env('MCD_MCP_TOKEN').replace(/^Bearer\s+/i, '');
}

function readUrl() {
  return env('MCD_MCP_URL') || DEFAULT_URL;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v == null ? '' : v)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 与 src/server.mjs 的 normalizeOptimizeParams 保持同一口径，但默认值更省调用（云函数有 60 秒上限）。 */
function normalizeOptimizeParams(p, yuanToCents) {
  const o = p || {};
  return {
    people: Math.max(1, Number(o.people) || 0),
    budgetPerPersonCents: yuanToCents(o.budget),
    addressQuery: o.addressQuery ? String(o.addressQuery).trim() : undefined,
    prefer: splitList(o.prefer),
    maxCalls: clamp(Number(o.maxCalls) || 45, 15, 80),
    variants: clamp(Number(o.variants) || 2, 1, 4),
    maxOrders: clamp(Number(o.maxOrders) || 2, 1, 3),
    reservationDate: o.reservation ? String(o.reservation) : undefined,
  };
}

/** 与 src/server.mjs 的 normalizePhoneParams 同一口径。 */
function normalizePhoneParams(p, yuanToCents, CHANNEL) {
  const o = p || {};
  return {
    channel: o.channel === 'delivery' ? CHANNEL.DELIVERY : CHANNEL.PICKUP,
    city: o.city ? String(o.city).trim() : undefined,
    keyword: o.keyword ? String(o.keyword).trim() : undefined,
    addressQuery: o.addressQuery ? String(o.addressQuery).trim() : undefined,
    want: splitList(o.want),
    budgetCents: yuanToCents(o.budget) || undefined,
    maxStores: clamp(Number(o.stores) || 4, 1, 10),
    maxCalls: clamp(Number(o.maxCalls) || 36, 10, 80),
    couponFirst: o.couponScan !== false,
    includeClosed: o.includeClosed === true,
    reservationDate: o.reservation ? String(o.reservation) : undefined,
  };
}

function jsonBytes(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj));
  } catch (e) {
    return -1;
  }
}

exports.main = async function main(event) {
  const startedAt = Date.now();
  const logs = [];
  const logger = (m) => {
    logs.push(String(m));
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  };
  const done = (obj) => {
    const out = Object.assign({ logs: logs, elapsedMs: Date.now() - startedAt }, obj);
    const size = jsonBytes(out);
    if (size > 800 * 1024) {
      logger('⚠️ 返回体积 ' + Math.round(size / 1024) + 'KB，接近云函数 1MB 上限；请减小 stores / variants');
    }
    out.logs = logs;
    return out;
  };

  const e = event || {};

  // 可选调用口令：防止别人拿到你的小程序 AppID 就白用你的 Token
  const needKey = env('MP_ACCESS_KEY');
  if (needKey && String(e.key || '').trim() !== needKey) {
    return done({ ok: false, error: { message: '调用口令不正确：请在小程序「设置 → 调用口令」填云函数环境变量 MP_ACCESS_KEY 的值', code: 'BAD_KEY' } });
  }

  const kind = e.kind === 'optimize' ? 'optimize' : e.kind === 'phone' ? 'phone' : e.kind === 'ping' ? 'ping' : null;
  if (!kind) return done({ ok: false, error: { message: 'kind 必须是 optimize / phone / ping', code: 'BAD_KIND' } });

  const demoAllowed = env('MP_DEMO') !== '0';
  const demo = e.demo === true && demoAllowed;

  try {
    const engine = await loadEngine();

    if (kind === 'ping') {
      if (!readToken()) {
        logger('没有配置 MCD_MCP_TOKEN：只能跑演示数据');
        return done({ ok: true, kind: 'ping', demoPossible: demoAllowed, token: false, server: '' });
      }
      const client = new engine.McpClient({ token: readToken(), url: readUrl() });
      const info = await client.initialize();
      const name = info && info.name ? String(info.name) : '';
      const version = info && info.version ? String(info.version) : '';
      return done({ ok: true, kind: 'ping', demoPossible: demoAllowed, token: true, server: (name + ' ' + version).trim() });
    }

    if (!demo && !readToken()) {
      return done({
        ok: false,
        error: {
          message: '云函数没有配置 MCP Token：云开发控制台 → 云函数 → mcd → 配置 → 环境变量 → 新增 MCD_MCP_TOKEN',
          code: 'NO_TOKEN',
        },
      });
    }

    const client = demo ? new engine.MockClient() : new engine.McpClient({ token: readToken(), url: readUrl() });
    logger('模式：' + (demo ? '离线演示' : '真实 MCP') + '｜Token 来源：' + (demo ? '内置演示数据' : '环境变量 MCD_MCP_TOKEN'));

    if (kind === 'optimize') {
      const params = normalizeOptimizeParams(e.params, engine.yuanToCents);
      if (!params.people || !params.budgetPerPersonCents) {
        return done({ ok: false, error: { message: '团餐比价需要「人数」和「人均预算」两个参数', code: 'BAD_PARAMS' } });
      }
      logger('人数 ' + params.people + ' 人｜人均预算 ¥' + (params.budgetPerPersonCents / 100).toFixed(2) + '｜算价上限 ' + params.maxCalls);
      const result = await engine.optimize({
        client: client,
        people: params.people,
        budgetPerPersonCents: params.budgetPerPersonCents,
        addressQuery: params.addressQuery,
        prefer: params.prefer,
        maxOrders: params.maxOrders,
        variants: params.variants,
        maxCalls: params.maxCalls,
        reservationDate: params.reservationDate,
        logger: logger,
      });
      logger('完成：比价 ' + (result.plans ? result.plans.length : 0) + ' 个方案，共 ' + result.callsUsed + ' 次官方算价');
      // 文字版必须在裁剪前生成（要读完整数据）
      const text = engine.renderReport(result, { people: params.people, budgetPerPersonCents: params.budgetPerPersonCents });
      return done({
        ok: true,
        kind: 'optimize',
        demo: demo,
        from: demo ? '演示数据' : '环境变量 MCD_MCP_TOKEN',
        result: engine.slimGroupResult(result),
        text: text,
        canOrder: false,
        callsUsed: result.callsUsed || 0,
      });
    }

    const params = normalizePhoneParams(e.params, engine.yuanToCents, engine.CHANNEL);
    if (!demo && params.channel === engine.CHANNEL.PICKUP && !params.city) {
      return done({ ok: false, error: { message: '到店自取需要「城市」，例如 西安市；也可以改成麦乐送并选择一个收货地址', code: 'NEED_CITY' } });
    }
    logger('渠道：' + (params.channel === engine.CHANNEL.DELIVERY ? '麦乐送（外送）' : '到店自取') + '｜门店数上限 ' + params.maxStores + '｜算价上限 ' + params.maxCalls);
    const result = await engine.solvePhoneOrder({
      client: client,
      channel: params.channel,
      city: params.city,
      keyword: params.keyword,
      addressQuery: params.addressQuery,
      want: params.want,
      budgetCents: params.budgetCents,
      maxStores: params.maxStores,
      maxCalls: params.maxCalls,
      couponFirst: params.couponFirst,
      includeClosed: params.includeClosed,
      reservationDate: params.reservationDate,
      logger: logger,
    });
    logger('完成：比价 ' + result.comparisons.length + ' 家门店，共 ' + result.callsUsed + ' 次官方算价');
    const text = engine.renderPhoneCard(result);
    return done({
      ok: true,
      kind: 'phone',
      demo: demo,
      from: demo ? '演示数据' : '环境变量 MCD_MCP_TOKEN',
      result: engine.slimPhoneResult(result),
      text: text,
      // 云函数没有跨请求的 MCP 会话，无法在此下单；下单请用 HTTP 服务模式
      canOrder: false,
      callsUsed: result.callsUsed || 0,
    });
  } catch (err) {
    logger('失败：' + (err && err.message ? err.message : String(err)));
    return done({
      ok: false,
      error: {
        message: (err && err.message ? err.message : String(err)) || '云函数执行失败',
        code: (err && err.code ? err.code : null),
      },
    });
  }
};

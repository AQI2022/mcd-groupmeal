#!/usr/bin/env node
/**
 * mcd-groupmeal · 手机端服务（src/server.mjs）
 *
 * 目标：把引擎「装进手机」——手机浏览器打开一个地址就能用，不需要在手机上装 Node、
 * 不需要敲命令行、不需要把 MCP Token 暴露给浏览器。
 *
 * 架构（刻意保持零运行时依赖，只用 Node 内置模块）：
 *
 *   手机浏览器  ──HTTP──▶  本服务（跑在电脑/NAS/Termux 上）  ──HTTPS──▶  mcp.mcd.cn
 *        ▲                        │
 *        └── 只拿到「算好的结果」   └── 唯一持有 MCP Token 的地方
 *
 * 为什么必须有一个服务端，而不能做成「一个 HTML 文件扔手机里」：
 *   实测 `mcp.mcd.cn` **没有返回任何 CORS 头**（`Access-Control-Allow-Origin` 缺失），
 *   浏览器直连会被同源策略拦掉；而且把 Token 写进前端页面等于把账号凭证公开。
 *   所以「手机直连 MCP」这条路是走不通的，代理是唯一正确解。
 *
 * 用法：
 *   node src/server.mjs                    # 真实 Token，监听 0.0.0.0:8787
 *   node src/server.mjs --demo             # 离线演示数据，不需要 Token
 *   node src/server.mjs --port 9000 --open # 换端口并自动打开电脑浏览器
 *   node src/server.mjs --no-key           # 关闭访问码（不建议在公共 Wi-Fi 下使用）
 *
 * 安全模型：
 *   · 默认生成 6 位访问码，只有带码的请求能读地址簿/算价/下单；
 *   · 手机上打开一次带码链接后，码会存进 localStorage，之后直接用短地址即可；
 *   · Token 永远只存在于服务端进程内存里，接口响应中不含 Token。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { McpClient } from './mcp-client.mjs';
import { listAddresses, TtlCache } from './mcd.mjs';
import { optimize } from './optimizer.mjs';
import { renderReport } from './render.mjs';
import { solvePhoneOrder, renderPhoneCard, placeOrder, CHANNEL } from './phone.mjs';
import { yuanToCents } from './money.mjs';
import { MockClient } from './mock.mjs';
import { loadTokenConfig } from './cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = '1.1.0';

// ───────────────────────────────────────────────────────────── 小工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 本机所有非回环 IPv4（用于打印手机该访问哪个地址）。 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ name, address: ni.address });
    }
  }
  // 常见家用/办公网段优先，虚拟网卡（VMware/VirtualBox/WSL）排后面
  const penalty = (n) => (/vmware|virtualbox|vethernet|wsl|hyper-v|loopback/i.test(n) ? 1 : 0);
  return out.sort((a, b) => penalty(a.name) - penalty(b.name));
}

/** 6 位无歧义访问码（去掉 0/O/1/I/L 这类看不清的字符）。 */
export function makeAccessKey(len = 6, randomBytes = crypto.randomBytes) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error(`请求体不是合法 JSON：${e.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ───────────────────────────────────────────────────────────── 任务与进度

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 20;

/**
 * 一次比价 = 一个 Job。
 *
 * 为什么要 Job 而不是「一个请求算到底」：真实链路一次到店比价要打 30~100 次官方算价，
 * 耗时 10~60 秒。手机上没有进度条会让人以为卡死了，所以这里把执行过程拆成
 * 「POST 建任务 → GET SSE 拿进度 → 结束时推结果」。
 */
class Job {
  constructor(id, kind) {
    this.id = id;
    this.kind = kind;
    this.status = 'running'; // running | done | failed
    this.logs = [];
    this.result = null;
    this.error = null;
    this.client = null; // 不序列化：下单时要复用同一个 MCP 会话
    this.startedAt = Date.now();
    this.endedAt = null;
    this.clients = new Set(); // SSE 订阅者
  }

  log(line) {
    const text = String(line);
    this.logs.push(text);
    this.#emit({ type: 'log', line: text });
  }

  #emit(event) {
    for (const c of this.clients) {
      try {
        c.send(event);
      } catch {
        /* 客户端断了就算了 */
      }
    }
  }

  finish(payload) {
    this.status = 'done';
    this.result = payload;
    this.endedAt = Date.now();
    this.#emit({ type: 'done', status: 'done', payload });
    this.#close();
  }

  fail(err) {
    this.status = 'failed';
    this.error = { message: err?.message ?? String(err), code: err?.code ?? null, stack: err?.stack ?? null };
    this.endedAt = Date.now();
    this.#emit({ type: 'done', status: 'failed', error: this.error });
    this.#close();
  }

  #close() {
    for (const c of this.clients) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  /** 可安全发给浏览器的部分（不含 client）。 */
  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      logs: this.logs,
      result: this.result,
      error: this.error,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}

export class JobStore {
  constructor({ max = MAX_JOBS, ttlMs = JOB_TTL_MS } = {}) {
    this.map = new Map();
    this.max = max;
    this.ttlMs = ttlMs;
  }

  create(kind) {
    this.sweep();
    const id = crypto.randomBytes(8).toString('hex');
    const job = new Job(id, kind);
    this.map.set(id, job);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return job;
  }

  get(id) {
    const job = this.map.get(id);
    if (job && job.status !== 'running' && Date.now() - job.endedAt > this.ttlMs) {
      this.map.delete(id);
      return null;
    }
    return job ?? null;
  }

  sweep() {
    for (const [id, job] of this.map) {
      if (job.status !== 'running' && Date.now() - job.endedAt > this.ttlMs) this.map.delete(id);
    }
  }
}

// ───────────────────────────────────────────────────────────── 业务执行

/** 按运行模式造客户端：demo 走离线 MockClient，行为与真实链路同一套代码。 */
function makeClient(state) {
  if (state.demo) return { client: new MockClient(), from: '演示数据（不联网、不需要 Token）' };
  const cfg = loadTokenConfig({ explicitToken: state.explicitToken });
  if (!cfg?.token) {
    const err = new Error(
      '没有找到 MCP Token：请把 mcp-config.example.json 复制成 mcp-config.json 填入真实 Token，' +
        '或设置环境变量 MCD_MCP_TOKEN；也可以先用 --demo 跑离线演示。',
    );
    err.code = 'NO_TOKEN';
    throw err;
  }
  return { client: new McpClient({ token: cfg.token, url: cfg.url }), from: cfg.from };
}

function normalizePhoneParams(p = {}) {
  const channel = p.channel === 'delivery' ? CHANNEL.DELIVERY : CHANNEL.PICKUP;
  const want = Array.isArray(p.want)
    ? p.want.map((s) => String(s).trim()).filter(Boolean)
    : String(p.want ?? '')
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  return {
    channel,
    city: p.city ? String(p.city).trim() : undefined,
    keyword: p.keyword ? String(p.keyword).trim() : undefined,
    addressQuery: p.addressQuery ? String(p.addressQuery).trim() : undefined,
    want,
    budgetCents: yuanToCents(p.budget) || undefined,
    maxStores: Math.min(20, Math.max(1, Number(p.stores) || 5)),
    maxCalls: Math.min(600, Math.max(10, Number(p.maxCalls) || 60)),
    couponFirst: p.couponScan !== false,
    includeClosed: p.includeClosed === true,
    reservationDate: p.reservation ? String(p.reservation) : undefined,
  };
}

function normalizeOptimizeParams(p = {}) {
  return {
    people: Math.max(1, Number(p.people) || 0),
    budgetPerPersonCents: yuanToCents(p.budget),
    addressQuery: p.addressQuery ? String(p.addressQuery).trim() : undefined,
    prefer: Array.isArray(p.prefer) ? p.prefer : String(p.prefer ?? '').split(/[,，、\s]+/).filter(Boolean),
    maxCalls: Math.min(600, Math.max(15, Number(p.maxCalls) || 150)),
    variants: Math.min(6, Math.max(1, Number(p.variants) || 3)),
    maxOrders: Math.min(6, Math.max(1, Number(p.maxOrders) || 3)),
    reservationDate: p.reservation ? String(p.reservation) : undefined,
  };
}

async function runPhoneJob(job, params, state) {
  const { client, from } = makeClient(state);
  job.client = client;
  job.log(`模式：${state.demo ? '离线演示' : '真实 MCP'}｜Token 来源：${from}`);
  job.log(`渠道：${params.channel === CHANNEL.DELIVERY ? '麦乐送（外送）' : '到店自取'}｜门店数上限 ${params.maxStores}｜算价上限 ${params.maxCalls}`);
  if (!state.demo && params.channel === CHANNEL.PICKUP && !params.city) {
    const err = new Error('到店自取需要「城市」，例如 西安市；也可以改成麦乐送并选择一个收货地址。');
    err.code = 'NEED_CITY';
    throw err;
  }
  const result = await solvePhoneOrder({
    client,
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
    logger: (m) => job.log(m),
  });
  job.log(`完成：比价 ${result.comparisons.length} 家门店，共 ${result.callsUsed} 次官方算价`);
  return {
    kind: 'phone',
    demo: state.demo,
    result,
    text: renderPhoneCard(result),
    // 演示模式不提供下单入口；真实模式只要有可用方案就能生成付款链接
    canOrder: !state.demo && !!result.best,
    from,
  };
}

async function runOptimizeJob(job, params, state) {
  if (!params.people || !params.budgetPerPersonCents) {
    const err = new Error('团餐比价需要「人数」和「人均预算」两个参数。');
    err.code = 'BAD_PARAMS';
    throw err;
  }
  const { client, from } = makeClient(state);
  job.client = client;
  job.log(`模式：${state.demo ? '离线演示' : '真实 MCP'}｜Token 来源：${from}`);
  job.log(`人数 ${params.people} 人｜人均预算 ¥${(params.budgetPerPersonCents / 100).toFixed(2)}`);
  const result = await optimize({
    client,
    people: params.people,
    budgetPerPersonCents: params.budgetPerPersonCents,
    addressQuery: params.addressQuery,
    prefer: params.prefer,
    maxOrders: params.maxOrders,
    variants: params.variants,
    maxCalls: params.maxCalls,
    reservationDate: params.reservationDate,
    cache: new TtlCache(600000),
    logger: (m) => job.log(m),
  });
  job.log(`完成：比价 ${result.plans?.length ?? 0} 个方案，共 ${result.callsUsed} 次官方算价`);
  return {
    kind: 'optimize',
    demo: state.demo,
    result,
    text: renderReport(result, { people: params.people, budgetPerPersonCents: params.budgetPerPersonCents }),
    from,
  };
}

// ───────────────────────────────────────────────────────────── HTTP 层

export function createServer(state) {
  const jobs = state.jobs;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // 手机端常用：局域网内任何设备都能拿到 shell，但拿不到数据
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,X-Mcd-Key',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end();
      }

      if (pathname.startsWith('/api/')) return await handleApi(req, res, url, pathname, state, jobs);
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) json(res, err?.status ?? 500, { ok: false, error: err?.message ?? String(err) });
      else res.end();
    }
    return undefined;
  });

  return server;
}

function authorized(req, url, state) {
  if (!state.accessKey) return true;
  const given = req.headers['x-mcd-key'] || url.searchParams.get('k') || '';
  if (typeof given !== 'string' || given.length !== state.accessKey.length) return false;
  // 定长比较，避免时序侧信道（本地场景其实无所谓，但没成本）
  return crypto.timingSafeEqual(Buffer.from(given.toUpperCase()), Buffer.from(state.accessKey));
}

async function handleApi(req, res, url, pathname, state, jobs) {
  const method = req.method.toUpperCase();

  // 这两个接口不需要访问码：手机要靠它判断「是不是同一台服务」以及输码
  if (pathname === '/api/ping' && method === 'GET') {
    return json(res, 200, {
      ok: true,
      app: 'mcd-groupmeal',
      version: VERSION,
      demo: state.demo,
      needKey: !!state.accessKey,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
    });
  }

  if (!authorized(req, url, state)) {
    return json(res, 401, { ok: false, error: '访问码不正确', code: 'BAD_KEY' });
  }

  if (pathname === '/api/health' && method === 'GET') {
    const deep = url.searchParams.get('deep') === '1';
    const base = {
      ok: true,
      demo: state.demo,
      version: VERSION,
      from: state.demo ? '演示数据（不联网）' : state.tokenFrom,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      addresses: null,
      tools: null,
      handshake: null,
      error: null,
    };
    if (!deep) return json(res, 200, base);
    try {
      const { client } = makeClient(state);
      const serverInfo = await client.initialize();
      base.handshake = { server: serverInfo, protocolVersion: client.protocolVersion };
      const tools = await client.listTools();
      base.tools = { count: tools.length, key: ['delivery-query-stores', 'query-meals', 'query-store-coupons', 'calculate-price', 'create-order'].map((n) => ({ name: n, found: !!client.findTool(n) })) };
      const book = await listAddresses(client);
      base.addresses = { count: book.length, items: book.map((a) => ({ addressId: a.addressId, contactName: a.contactName, fullAddress: a.fullAddress })) };
      base.callsUsed = client.callCount;
    } catch (err) {
      base.ok = false;
      base.error = { message: err?.message ?? String(err), code: err?.code ?? null };
      return json(res, 200, base);
    }
    return json(res, 200, base);
  }

  if (pathname === '/api/addresses' && method === 'GET') {
    if (state.demo) {
      return json(res, 200, {
        ok: true,
        demo: true,
        addresses: [{ addressId: 'DEMO-ADDR-0001', contactName: '演示用户', fullAddress: '演示市演示区演示路 1 号 演示大厦 21 楼', phone: '138****8000' }],
      });
    }
    try {
      const { client } = makeClient(state);
      const book = await listAddresses(client);
      return json(res, 200, {
        ok: true,
        demo: false,
        addresses: book.map((a) => ({ addressId: a.addressId, contactName: a.contactName, fullAddress: a.fullAddress, phone: a.phone })),
      });
    } catch (err) {
      return json(res, 200, { ok: false, error: { message: err?.message ?? String(err), code: err?.code ?? null }, addresses: [] });
    }
  }

  if (pathname === '/api/jobs' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'optimize' ? 'optimize' : body.kind === 'phone' ? 'phone' : null;
    if (!kind) return json(res, 400, { ok: false, error: 'kind 必须是 phone 或 optimize', code: 'BAD_KIND' });

    const job = jobs.create(kind);
    // 立即返回 jobId，执行放到后台（手机端就能立刻看到进度）
    setImmediate(() => {
      const run = kind === 'phone' ? runPhoneJob : runOptimizeJob;
      const params = kind === 'phone' ? normalizePhoneParams(body.params) : normalizeOptimizeParams(body.params);
      run(job, params, state)
        .then((payload) => job.finish({ ...payload, jobId: job.id }))
        .catch((err) => {
          job.log(`失败：${err?.message ?? err}`);
          job.fail(err);
        });
    });
    return json(res, 202, { ok: true, jobId: job.id, kind });
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f]{16})(\/stream|\/order)?$/.exec(pathname);
  if (jobMatch) {
    const [, id, sub] = jobMatch;
    const job = jobs.get(id);
    if (!job) return json(res, 404, { ok: false, error: '任务不存在或已过期', code: 'NO_JOB' });

    if (!sub && method === 'GET') return json(res, 200, { ok: true, job: job.toJSON() });

    if (sub === '/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      // 先补发快照：手机上刷新/重连不会丢进度。
      // 关键细节：任务可能在手机连上来之前就已经跑完了（demo 模式几乎必然如此）。
      // 这时如果只发快照就挂断，前端会一直等 done —— 所以要顺手把 done 补上。
      send({ type: 'snapshot', status: job.status, logs: job.logs, payload: job.result, error: job.error });
      if (job.status !== 'running') {
        send({ type: 'done', status: job.status, payload: job.result, error: job.error });
        return res.end();
      }

      const sub2 = { send, end: () => res.end() };
      job.clients.add(sub2);
      const ping = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        job.clients.delete(sub2);
      });
      return undefined;
    }

    if (sub === '/order' && method === 'POST') {
      // 真实下单：创建「未支付」订单并返回 H5 付款链接。必须在界面上二次确认。
      if (state.demo) return json(res, 400, { ok: false, error: '演示模式不会创建真实订单', code: 'DEMO_MODE' });
      if (!job.client) return json(res, 400, { ok: false, error: '任务已过期或未产生会话，无法下单', code: 'NO_SESSION' });
      const best = job.result?.result?.best;
      if (!best) return json(res, 400, { ok: false, error: '这次比价没有可用方案，无法下单', code: 'NO_PLAN' });
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 400, { ok: false, error: '缺少 confirm=true（下单会创建真实订单，必须显式确认）', code: 'NEED_CONFIRM' });
      const order = await placeOrder(job.client, best, {
        addressId: body.addressId ?? best.addressId,
        takeWayCode: body.takeWayCode,
        remark: body.remark,
      });
      job.log(`已创建未支付订单：${order.orderId}，应付 ¥${order.amount}`);
      return json(res, 200, { ok: true, order });
    }
  }

  return json(res, 404, { ok: false, error: `未知接口 ${pathname}`, code: 'NO_ROUTE' });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只支持 GET' });

  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 目录穿越防护：解析后必须仍在 public/ 内
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { ok: false, error: '路径不合法' });
  }
  if (path.basename(target).startsWith('.')) return json(res, 404, { ok: false, error: 'not found' });

  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    /* fallthrough */
  }
  if (stat?.isDirectory()) {
    rel = path.join(rel, 'index.html');
    return serveStatic(req, res, '/' + rel.split(path.sep).join('/'));
  }
  if (!stat || !stat.isFile()) {
    // 单页应用回退：未知路径交给前端路由
    if (!path.extname(rel)) return serveStatic(req, res, '/');
    return json(res, 404, { ok: false, error: `没有这个静态文件：${rel}` });
  }

  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // 开发/内网场景：宁可每次拉新的，也不要手机上看到旧界面
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(body);
}

/** 端口被占用时顺延，最多试 maxTries 个。 */
export function listenWithFallback(server, { port, host, maxTries = 10 }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < maxTries) {
          attempt += 1;
          tryListen(p + 1);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryListen(port);
  });
}

/** Windows 双击 .cmd 时不弹黑框地打开默认浏览器。 */
function openBrowser(url) {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = isWin ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就算了，用户自己复制地址 */
  }
}

const USAGE = `mcd-groupmeal · 手机端服务

用法：
  node src/server.mjs [选项]

选项：
  --port <int>       监听端口，默认 8787（被占用会自动 +1 顺延）
  --host <addr>      监听地址，默认 0.0.0.0（手机要连就必须是 0.0.0.0）
  --demo             离线演示模式：内置构造数据，不联网、不需要 Token
  --no-key           关闭访问码（同一 Wi-Fi 下的任何设备都能直接用）
  --key <code>       指定固定访问码（默认每次启动随机生成）
  --open             启动后自动在电脑上打开浏览器
  --token <token>    临时指定 MCP Token（仅调试；正式用法是 mcp-config.json）
  -h, --help         显示本帮助

手机怎么连：
  1) 手机和这台电脑连同一个 Wi-Fi；
  2) 手机浏览器打开下面打印的「手机上打开」那个地址（带访问码）；
  3) 打开一次后，用「添加到主屏幕」存成图标，以后点一下就能用。

只想先看看界面长什么样：
  node src/server.mjs --demo
`;

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--demo') args.demo = true;
    else if (a === '--open') args.open = true;
    else if (a === '--no-key') args.noKey = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const port = Number(args.port) || 8787;
  const host = typeof args.host === 'string' ? args.host : '0.0.0.0';
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    process.stderr.write(`❌ 找不到 ${path.join(PUBLIC_DIR, 'index.html')}，前端资源不完整。\n`);
    return 1;
  }

  let tokenFrom = '演示数据（不联网）';
  if (!args.demo) {
    const cfg = loadTokenConfig({ explicitToken: args.token });
    if (!cfg?.token) {
      process.stderr.write(
        '❌ 没有找到 MCP Token。\n' +
          '   · 正式用法：把 mcp-config.example.json 复制为 mcp-config.json 并填入真实 Token\n' +
          '   · 或设置环境变量 MCD_MCP_TOKEN\n' +
          '   · 只想先看界面：node src/server.mjs --demo\n',
      );
      return 1;
    }
    tokenFrom = cfg.from;
  }

  const state = {
    demo: !!args.demo,
    accessKey: args.noKey ? '' : typeof args.key === 'string' && args.key ? args.key.trim().toUpperCase() : makeAccessKey(),
    explicitToken: typeof args.token === 'string' ? args.token : undefined,
    tokenFrom,
    jobs: new JobStore(),
  };

  const server = createServer(state);
  const addr = await listenWithFallback(server, { port, host });
  const actualPort = addr.port;

  const lans = lanAddresses();
  const key = state.accessKey ? `?k=${state.accessKey}` : '';
  const lines = [];
  lines.push('');
  lines.push('  🍟 mcd-groupmeal 手机端已启动');
  lines.push('');
  lines.push(`     电脑上打开：http://localhost:${actualPort}/${key}`);
  if (lans.length) {
    lines.push(`     手机上打开：http://${lans[0].address}:${actualPort}/${key}   ← 手机连同一个 Wi-Fi`);
    for (const l of lans.slice(1)) lines.push(`     备用地址：  http://${l.address}:${actualPort}/${key}   (${l.name})`);
  } else {
    lines.push('     ⚠️ 没检测到局域网 IPv4 地址，手机可能连不上；可检查是否只有虚拟网卡。');
  }
  lines.push('');
  lines.push(`     模式：${state.demo ? '离线演示（不联网、不需要 Token）' : `真实 MCP（Token 来源：${tokenFrom}）`}`);
  lines.push(`     访问码：${state.accessKey || '已关闭（--no-key）'}`);
  if (state.accessKey) lines.push('     （手机打开一次后会自动记住，之后可直接用短地址；访问码仅本次运行有效）');
  lines.push('');
  lines.push('     手机连不上时依次检查：① 是否同一个 Wi-Fi；② Windows 防火墙是否放行 Node；');
  lines.push('     ③ 路由器是否开了「AP 隔离」。Ctrl+C 停止服务。');
  lines.push('');
  process.stdout.write(lines.join('\n'));

  if (args.open) openBrowser(`http://localhost:${actualPort}/${key}`);

  const shutdown = () => {
    process.stdout.write('\n已停止。\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {}); // 常驻，直到 Ctrl+C
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main()
    .then((code) => {
      if (typeof code === 'number') process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`❌ ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}

/**
 * 零依赖 Streamable HTTP MCP 客户端。
 *
 * 为什么不用官方 SDK：本项目的卖点之一是「一行命令能跑」——零运行时依赖意味着
 * `npx mcd-groupmeal` 不需要拉任何东西；同时直连 JSON-RPC 层在无网/评测环境里
 * 更容易排障（`mcd-groupmeal doctor` 会打印到握手这一层为止的全部结果）。
 *
 * 覆盖的真实约束（见 MCP_INTEGRATION.md）：
 *   - MCP Version 2025-06-18 及之前；
 *   - 每次请求都带 `Authorization: Bearer <token>`；
 *   - 响应可能是 `application/json`，也可能是 `text/event-stream`（SSE）；
 *   - 服务端会下发 `mcp-session-id`，后续请求必须回带；
 *   - 限流 600 次/分钟，超限返回 429。
 */
import { contentToText, extractJson } from './json.mjs';

export class McpHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 工具层业务错误（JSON-RPC 返回 error，或业务 code !== 200）。 */
export class McpToolError extends Error {
  constructor(message, { tool, code, raw } = {}) {
    super(message);
    this.name = 'McpToolError';
    this.tool = tool;
    this.code = code;
    this.raw = raw;
  }
}

/** 已知业务错误码 → 处置建议（MCP 工具清单 §5.1）。 */
export const BUSINESS_ERROR_HINTS = {
  401: 'MCP Token 无效、已过期或未提供 → 检查 Authorization 请求头，或去 https://open.mcd.cn/mcp 重新激活',
  429: '触发限流（>600 次/分钟）→ 客户端已内置退避，若仍失败请降低并发',
  600010: '用券缺少 couponId/couponCode → 补全券参数或去掉券',
  600012: '促销规则不支持该商品 → 从 items 中移除该商品，或换助餐档位',
  600050: '收藏餐厅为空 → query-nearby-stores 改用 searchType=2 + city + keyword',
  600058: 'city/keyword 缺一 → query-nearby-stores searchType=2 必须两者同传',
};

/** 令牌桶限流器（默认 600 rpm，与官方限制一致）。 */
class TokenBucket {
  constructor(rpm, now = () => Date.now()) {
    this.capacity = Math.max(1, rpm);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60000;
    this.last = now();
    this.now = now;
  }

  /** 取一个令牌，必要时返回需要等待的毫秒数。 */
  take() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const need = (1 - this.tokens) / this.refillPerMs;
    this.tokens = 0;
    this.last = t + need;
    return Math.ceil(need);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.token       MCP Token（不含 `Bearer ` 前缀）
   * @param {string} [opts.url]       MCP endpoint，默认 https://mcp.mcd.cn
   * @param {number} [opts.timeoutMs] 单次请求超时，默认 30s
   * @param {number} [opts.maxRetries] 网络/429/5xx 重试次数，默认 4
   * @param {number} [opts.rpm]       本地限流，默认 600
   * @param {function} [opts.fetchImpl]
   */
  constructor({ token, url = 'https://mcp.mcd.cn', timeoutMs = 30000, maxRetries = 4, rpm = 600, fetchImpl, logger } = {}) {
    if (!token) throw new Error('McpClient 需要一个 token（见 mcp-config.example.json）');
    this.token = String(token).replace(/^Bearer\s+/i, '').trim();
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.logger = logger || (() => {});
    this.bucket = new TokenBucket(rpm);
    this.sessionId = null;
    this.rpcId = 0;
    this.callCount = 0;
    this.initialized = false;
    this.protocolVersion = '2025-06-18';
    this.serverInfo = null;
    this.tools = [];
  }

  get stats() {
    return { callCount: this.callCount, toolCalls: this.toolCalls ?? 0, session: !!this.sessionId, server: this.serverInfo };
  }

  async #post(payload) {
    const waitMs = this.bucket.take();
    if (waitMs > 0) await sleep(waitMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      const sid = res.headers?.get?.('mcp-session-id');
      if (sid) this.sessionId = sid;
      this.callCount += 1;
      return { status: res.status, contentType: res.headers?.get?.('content-type') || '', text };
    } finally {
      clearTimeout(timer);
    }
  }

  static #parseBody(text, contentType) {
    if ((contentType || '').includes('text/event-stream')) {
      const out = [];
      for (const line of String(text).split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          out.push(JSON.parse(data));
        } catch {
          /* 忽略无法解析的 SSE 片段 */
        }
      }
      return out;
    }
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }

  async #rpc(method, params, { id = ++this.rpcId, retries = this.maxRetries } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await this.#post({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        lastErr = new McpHttpError(`网络错误：${err?.message ?? err}`);
        if (attempt === retries) throw lastErr;
        await sleep(400 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastErr = new McpHttpError(`HTTP ${res.status}`, { status: res.status, body: res.text.slice(0, 300) });
        if (attempt === retries) throw lastErr;
        const retryAfter = Number(/(?:retry-after|重试)[^\d]*(\d+)/i.exec(res.text)?.[1] || 0);
        await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt));
        continue;
      }

      if (res.status === 401) {
        throw new McpHttpError(`HTTP 401：${BUSINESS_ERROR_HINTS[401]}`, { status: 401, body: res.text.slice(0, 300) });
      }
      if (res.status >= 400) {
        throw new McpHttpError(`HTTP ${res.status}`, { status: res.status, body: res.text.slice(0, 300) });
      }

      const msgs = McpClient.#parseBody(res.text, res.contentType);
      if (!msgs.length) {
        // 202 Accepted / 空 body：通知类请求的正常返回
        return null;
      }
      const matched = msgs.find((m) => m && m.id === id) || msgs.find((m) => m && (m.result || m.error));
      if (!matched) return null;
      if (matched.error) {
        throw new McpToolError(`${matched.error.code}: ${matched.error.message}`, {
          tool: method,
          code: matched.error.code,
        });
      }
      return matched.result;
    }
    throw lastErr ?? new McpHttpError('未知错误');
  }

  /** 建立会话。返回 serverInfo。 */
  async initialize() {
    const result = await this.#rpc(
      'initialize',
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'mcd-groupmeal', version: '1.0.0' },
      },
      { id: 0 },
    );
    this.serverInfo = result?.serverInfo ?? null;
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.initialized = true;
    // 通知类消息，best-effort：失败不影响后续调用（实测服务端不强制要求）
    try {
      await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    } catch {
      /* ignore */
    }
    return this.serverInfo;
  }

  async listTools() {
    const result = await this.#rpc('tools/list', {}, { id: 2 });
    this.tools = result?.tools ?? [];
    return this.tools;
  }

  /** 工具名归一化：`query-party-store-date` / `query_partystore_date` 视为同一个。 */
  findTool(name) {
    const norm = (s) => String(s).toLowerCase().replace(/[-_]/g, '');
    const want = norm(name);
    return this.tools.find((t) => norm(t.name) === want)?.name ?? null;
  }

  /**
   * 调用工具并归一化返回。
   *
   * 注意 1：真实服务端会偶发 `code=500 服务器发生了未知的问题`（HTTP 仍是 200），
   * 实测在 `query-promotions` 上遇到过。这属于**瞬时故障**，所以这里对 code=500
   * 做有限次退避重试；重试仍失败则如实返回失败，由上层降级。
   *
   * 注意 2：**有些工具只返回 Markdown，不返回 JSON**（实测 `available-coupons`「麦麦省券列表」、
   * `campaign-calendar`「活动日历」）。它们没有 `success/code/data` 字段，若按「非 JSON 即失败」
   * 处理，会把一次成功调用误判成失败。因此这里以「是否解析出业务 JSON」分流：
   *   · 有 JSON → 按 `success && code==200` 判定（原口径不变）；
   *   · 无 JSON 但有非空文本且 `isError !== true` → 视为成功，打上 `kind:'text'` 标并原样保留文本。
   * 真正的失败仍有两条硬判据兜底：HTTP 层（401/4xx/5xx 抛 McpHttpError）与 JSON 业务 code。
   *
   * @returns {Promise<{ok:boolean, data:any, json:any, text:string, code:number|null, message:string|null, tool:string, kind?:'text'}>}
   */
  async callTool(name, args = {}, { retriesOnServerError = 2 } = {}) {
    const resolved = this.tools.length ? this.findTool(name) : name;
    if (!resolved) {
      throw new McpToolError(`工具不存在：${name}（服务端共 ${this.tools.length} 个工具）`, { tool: name });
    }
    this.toolCalls = (this.toolCalls ?? 0) + 1;

    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await this.#rpc('tools/call', { name: resolved, arguments: args });
      } catch (err) {
        if (err instanceof McpToolError) throw new McpToolError(err.message, { tool: resolved, code: err.code });
        throw err;
      }
      const text = contentToText(result?.content);
      const json = extractJson(text);
      const hasJson = json !== null && json !== undefined;
      const code = typeof json?.code === 'number' ? json.code : null;
      const isError = !!result?.isError;
      const ok = hasJson ? !!json?.success && (code === null || code === 200) && !isError : !isError && text.trim().length > 0;
      if (!ok && code === 500 && attempt < retriesOnServerError) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      return {
        ok,
        json,
        text,
        code,
        message: json?.message ?? null,
        tool: resolved,
        isError,
        ...(hasJson ? {} : { kind: 'text' }),
      };
    }
  }

  /**
   * 调用工具并在业务失败时抛出 McpToolError（附带处置建议）。
   */
  async callToolOrThrow(name, args = {}) {
    const r = await this.callTool(name, args);
    if (!r.ok) {
      const hint = r.code ? BUSINESS_ERROR_HINTS[r.code] : undefined;
      throw new McpToolError(`[${r.tool}] 业务失败 code=${r.code ?? '?'} ${r.message ?? ''}${hint ? ` → ${hint}` : ''}`, {
        tool: r.tool,
        code: r.code,
        raw: r.text.slice(0, 500),
      });
    }
    return r;
  }
}

/**
 * 极简 `fetch` 兼容层（只用 Node 内置模块）。
 *
 * 为什么需要它：微信云函数的部分运行时只有 Node 16（没有全局 fetch），
 * 而 `mcp-client.mjs` 是按 WHATWG fetch 的用法写的（`res.status` / `res.headers.get()` / `res.text()`）。
 * 这里补齐「刚好用到的那个子集」，让同一套引擎代码既能跑在 Node 18+，
 * 也能跑在只有 Node 16 的云函数里，且不引入任何依赖。
 *
 * 支持：GET/POST 与自定义头、请求体（字符串/Buffer）、重定向跟随、
 *      AbortSignal 取消（mcp-client 用它做超时）。
 */
import http from 'node:http';
import https from 'node:https';

const MAX_REDIRECTS = 4;

class FetchHeaders {
  constructor(raw) {
    this.raw = raw || {};
  }
  get(name) {
    const v = this.raw[String(name).toLowerCase()];
    if (v === undefined) return null;
    return Array.isArray(v) ? v.join(', ') : String(v);
  }
  has(name) {
    return this.get(name) !== null;
  }
  forEach(fn) {
    for (const [k, v] of Object.entries(this.raw)) fn(v, k);
  }
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function pickClient(url) {
  return url.protocol === 'https:' ? https : http;
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

/**
 * @param {string|URL} input
 * @param {{method?:string, headers?:object, body?:any, signal?:AbortSignal, timeoutMs?:number}} [init]
 * @returns {Promise<{ok:boolean,status:number,statusText:string,url:string,headers:FetchHeaders,text:()=>Promise<string>,json:()=>Promise<any>}>}
 */
export function httpFetch(input, init = {}) {
  const url = input instanceof URL ? input : new URL(String(input));
  return request(url, init, 0);
}

function request(url, init, depth) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs,
  } = init;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());

    const done = once((err, value) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    });

    const onAbort = () => {
      try {
        req.destroy(abortError());
      } catch {
        /* already destroyed */
      }
      done(abortError());
    };

    const client = pickClient(url);
    const req = client.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && depth < MAX_REDIRECTS) {
          res.resume();
          const next = new URL(location, url);
          // 重定向时保留方法（MCP 端点不会重定向；这里只是稳妥）
          request(next, { ...init, signal }, depth + 1).then(
            (v) => done(null, v),
            (e) => done(e),
          );
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const headersBag = new FetchHeaders(res.headers);
          done(null, {
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || '',
            url: String(url),
            headers: headersBag,
            text: () => Promise.resolve(text),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(text));
              } catch (e) {
                return Promise.reject(e);
              }
            },
          });
        });
        res.on('error', (e) => done(e));
      },
    );

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`HTTP 请求超时（${timeoutMs}ms）`);
        err.name = 'TimeoutError';
        req.destroy(err);
        done(err);
      });
    }

    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
        req.write(body);
      } else {
        req.write(String(body));
      }
    }

    req.on('error', (e) => done(e));
    req.end();
  });
}

export default httpFetch;

/**
 * 小程序 ↔ 后端 的唯一网络层。
 *
 * 为什么小程序不能直连麦当劳 MCP：
 *   ① `mcp.mcd.cn` 不返回 CORS 头，浏览器/小程序直连会被拦；
 *   ② MCP Token 是账号凭证，放进小程序包等于公开（小程序包可被反编译）。
 * 所以这里只有两条合法通道，Token 永远不进入小程序：
 *   · http  —— 你自己的服务（src/server.mjs）
 *   · cloud —— 微信云开发云函数（cloudfunctions/mcd）
 *
 * 所有接口在失败时抛出的 Error 都带 `code`，页面据此给出「下一步点哪里」。
 */
const { loadConfig, normalizeBase } = require('./config.js');

let initedEnv = null;

function err(message, code, extra) {
  const e = new Error(message);
  e.code = code || 'ERROR';
  if (extra) Object.keys(extra).forEach((k) => { e[k] = extra[k]; });
  return e;
}

function networkError(e, base) {
  const detail = e && (e.errMsg || e.message) ? e.errMsg || e.message : '未知网络错误';
  const msg =
    '连不上服务（' + detail + '）。\n' +
    '① 设置里填的地址是不是 ' + (base || '（空）') + '？\n' +
    '② 电脑上的服务是否在跑：node src/server.mjs\n' +
    '③ 真机预览时手机要和电脑同一个 Wi-Fi，地址要用电脑的局域网 IP\n' +
    '④ 开发者工具需勾选「不校验合法域名」（项目已默认关闭域名校验）';
  return err(msg, 'NETWORK');
}

// ───────────────────────────────────────────── HTTP 通道

function request(path, options) {
  const o = options || {};
  const cfg = loadConfig();
  const base = normalizeBase(cfg.serverUrl);
  if (!base) return Promise.reject(err('还没有配置服务器地址：先打开「设置」填写', 'NO_BASE'));

  const header = { 'Content-Type': 'application/json' };
  if (cfg.accessKey) header['X-Mcd-Key'] = String(cfg.accessKey).trim().toUpperCase();

  return new Promise((resolve, reject) => {
    wx.request({
      url: base + path,
      method: o.method || 'GET',
      data: o.data,
      header: Object.assign(header, o.header || {}),
      timeout: o.timeout || 20000,
      success(res) {
        const data = res && res.data;
        if (res && res.statusCode === 401) {
          return reject(err('访问码不正确：请在「设置」里填电脑上打印的那串（每次启动都会变）', 'BAD_KEY'));
        }
        if (res && res.statusCode >= 500) {
          return reject(err('服务端出错了（HTTP ' + res.statusCode + '）：看电脑上那个黑窗口的日志', 'SERVER_ERROR', { status: res.statusCode }));
        }
        resolve(data === undefined ? null : data);
      },
      fail(e) {
        reject(networkError(e, base));
      },
    });
  });
}

/** 服务器是否活着（这个接口不需要访问码）。 */
function ping() {
  return request('/api/ping', { timeout: 8000 });
}

/** 自检：deep=1 会真的握手 MCP、拉工具清单和地址簿。 */
function health(deep) {
  return request('/api/health' + (deep ? '?deep=1' : ''), { timeout: deep ? 45000 : 10000 });
}

/** 账号地址簿（`delivery-query-stores` 只认 addressId，所以必须先拿这个）。 */
function addresses() {
  return request('/api/addresses', { timeout: 30000 });
}

/** 建任务：服务端立刻返回 jobId，真正的算价在后台跑。 */
function createJob(kind, params) {
  return request('/api/jobs', { method: 'POST', data: { kind: kind, params: params }, timeout: 20000 });
}

/** 拉进度/结果：`from` 是已经拿到过的日志条数，只回增量。 */
function job(jobId, from) {
  return request('/api/jobs/' + jobId + '?from=' + (Number(from) || 0), { timeout: 15000 });
}

/** 生成真实未支付订单，返回可付款的 H5 链接（需 confirm=true）。 */
function order(jobId, data) {
  return request('/api/jobs/' + jobId + '/order', { method: 'POST', data: data, timeout: 30000 }).then((res) => {
    if (!res || res.ok !== true) throw err((res && res.error) || '下单失败', (res && res.code) || 'ORDER_FAIL');
    return res;
  });
}

// ───────────────────────────────────────────── 云开发通道

function ensureCloud(cfg) {
  if (!wx.cloud) {
    throw err(
      '当前环境没有云开发能力：请确认已开通云开发，且「调试基础库」≥ 2.2.3；' +
        '如果你想用自己电脑上的服务，请到「设置」把通道改成 HTTP。',
      'NO_CLOUD',
    );
  }
  if (!cfg.cloudEnv) {
    throw err('还没有填云开发环境 ID：微信开发者工具 → 云开发 → 设置 → 环境 ID（形如 my-env-1a2b3c）', 'NO_ENV');
  }
  if (initedEnv !== cfg.cloudEnv) {
    wx.cloud.init({ env: cfg.cloudEnv, traceUser: false });
    initedEnv = cfg.cloudEnv;
  }
}

/**
 * 调云函数。云函数是「一次请求算到底」的同步模型（没有 SSE），
 * 所以这里只能等它返回；耗时由云函数的超时设置决定（建议 60s）。
 */
function callCloud(kind, params, options) {
  const o = options || {};
  let cfg;
  try {
    cfg = loadConfig();
    ensureCloud(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: cfg.cloudFn || 'mcd',
      data: { kind: kind, params: params || {}, demo: !!o.demo, key: cfg.cloudKey || '' },
      success(res) {
        const result = res && res.result;
        if (!result || typeof result !== 'object') {
          return reject(err('云函数没有返回结果：99% 是还没点「上传并部署」。在开发者工具里右键 cloudfunctions/mcd → 上传并部署（云端安装依赖）', 'CLOUD_EMPTY'));
        }
        if (result.ok === false) {
          const e = result.error || {};
          return reject(err(e.message || '云函数执行失败', e.code || 'CLOUD_FAIL', { raw: result }));
        }
        resolve(result);
      },
      fail(e) {
        const raw = (e && (e.errMsg || e.message)) || '未知错误';
        let hint = '';
        if (raw.indexOf('timeout') >= 0 || raw.indexOf('超时') >= 0) {
          hint = '：算价时间超过了云函数超时。把云函数超时调到 60 秒（云开发控制台 → 云函数 → 配置），或在首页打开「快速模式」。';
        } else if (raw.indexOf('not found') >= 0 || raw.indexOf('-501000') >= 0) {
          hint = '：没找到这个云函数。检查「设置 → 云函数名」和是否已部署。';
        }
        reject(err('云函数调用失败（' + raw + '）' + hint, 'CLOUD_FAIL'));
      },
    });
  });
}

// ───────────────────────────────────────────── 对外统一入口

/**
 * 发起一次任务，屏蔽两种通道的差异。
 * @returns {Promise<{transport:'http',jobId:string,kind:string}|{transport:'cloud',payload:object}>}
 */
function startTask(kind, params, options) {
  const cfg = loadConfig();
  if (cfg.transport === 'cloud') {
    return callCloud(kind, params, options).then((payload) => ({ transport: 'cloud', kind: kind, payload: payload }));
  }
  return createJob(kind, params).then((res) => {
    if (!res || res.ok !== true || !res.jobId) {
      throw err((res && res.error) || '服务端没有返回任务号', (res && res.code) || 'NO_JOB');
    }
    return { transport: 'http', kind: res.kind || kind, jobId: res.jobId };
  });
}

/** 设置页的连通性检测：两条通道各测各的。 */
function testConnection() {
  const cfg = loadConfig();
  if (cfg.transport === 'cloud') {
    return callCloud('ping', {}, {}).then((r) => ({
      ok: true,
      mode: '云函数',
      detail:
        '云函数「' + (cfg.cloudFn || 'mcd') + '」可用' +
        (r && r.demoPossible === false ? '（该云函数未配置 Token，只能跑演示数据）' : '') +
        (r && r.server ? '｜麦当劳 MCP：' + r.server : ''),
    }));
  }
  return ping().then((p) => {
    if (!p || !p.ok) throw err('服务有响应但不是本项目的接口：确认地址和端口（默认 8787）', 'BAD_SERVICE');
    const bits = ['服务正常（v' + (p.version || '?') + '，' + (p.demo ? '演示数据' : '真实 MCP') + '）'];
    if (p.needKey) bits.push('本次运行需要访问码');
    return health(false)
      .then((h) => {
        if (h && h.ok === false && h.error) {
          throw err('服务在跑，但自检失败：' + h.error.message, h.error.code || 'HEALTH_FAIL');
        }
        bits.push('地址簿接口就绪');
        return { ok: true, mode: 'HTTP 服务', detail: bits.join('｜') };
      })
      .catch((e) => {
        // 自检失败不应否定「服务是活的」这个判断，原样带出去让用户看到原因
        if (e && e.code === 'BAD_KEY') throw e;
        bits.push('自检未完成：' + (e && e.message ? e.message : e));
        return { ok: true, mode: 'HTTP 服务', detail: bits.join('｜') };
      });
  });
}

module.exports = { request, ping, health, addresses, createJob, job, order, callCloud, startTask, testConnection };

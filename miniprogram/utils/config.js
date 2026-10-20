/**
 * 配置读写（小程序本地存储）。
 *
 * 两种运行架构，切换只改这里：
 *   http  —— 小程序 → 你自己的服务（src/server.mjs）→ 麦当劳 MCP。
 *            开发时连 127.0.0.1 / 局域网 IP；正式发布需要 HTTPS 且域名已备案。
 *   cloud —— 小程序 → 微信云开发云函数（cloudfunctions/mcd）→ 麦当劳 MCP。
 *            不需要域名、不需要备案、不需要公网服务器；Token 放云函数环境变量。
 */
const STORAGE_KEY = 'mcd.config.v1';

const DEFAULTS = {
  transport: 'http',
  serverUrl: 'http://127.0.0.1:8787',
  accessKey: '',
  cloudEnv: '',
  cloudFn: 'mcd',
  cloudKey: '',
};

function loadConfig() {
  let saved = {};
  try {
    saved = wx.getStorageSync(STORAGE_KEY) || {};
  } catch (e) {
    saved = {};
  }
  const out = {};
  Object.keys(DEFAULTS).forEach((k) => {
    out[k] = saved[k] === undefined || saved[k] === null ? DEFAULTS[k] : saved[k];
  });
  return out;
}

function saveConfig(patch) {
  const next = Object.assign({}, loadConfig(), patch || {});
  try {
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (e) {
    /* 存储满了也不能影响使用 */
  }
  return next;
}

/** 去掉末尾斜杠，避免拼出 `//api/ping`。 */
function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

module.exports = { STORAGE_KEY, DEFAULTS, loadConfig, saveConfig, normalizeBase };

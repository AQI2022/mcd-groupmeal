/**
 * 设置页：切换「HTTP 服务 / 云函数」两种后端，并做连通性检测。
 *
 * 这一页是小程序能不能真的跑起来的开关：
 *   · HTTP：地址 + 访问码（服务每次启动都会打印）
 *   · 云函数：环境 ID + 函数名 + 可选的调用口令
 */
const { testConnection } = require('../../utils/api.js');
const { loadConfig, saveConfig, DEFAULTS } = require('../../utils/config.js');

Page({
  data: {
    transport: 'http',
    serverUrl: '',
    accessKey: '',
    cloudEnv: '',
    cloudFn: '',
    cloudKey: '',
    testing: false,
    testOk: false,
    testTitle: '',
    testDetail: '',
    testError: '',
    saved: false,
    platform: '',
  },

  onLoad() {
    this.load();
    let platform = '';
    try {
      const info = wx.getSystemInfoSync();
      platform = (info.system || '') + ' · 基础库 ' + (info.SDKVersion || '?');
    } catch (e) {
      platform = '';
    }
    this.setData({ platform: platform });
  },

  load() {
    const c = loadConfig();
    this.setData({
      transport: c.transport,
      serverUrl: c.serverUrl,
      accessKey: c.accessKey,
      cloudEnv: c.cloudEnv,
      cloudFn: c.cloudFn,
      cloudKey: c.cloudKey,
    });
  },

  onTransport(e) {
    this.setData({ transport: e.currentTarget.dataset.mode, testOk: false, testDetail: '', testError: '' });
  },

  onServerUrl(e) {
    this.setData({ serverUrl: e.detail.value });
  },

  onAccessKey(e) {
    this.setData({ accessKey: e.detail.value.toUpperCase() });
  },

  onCloudEnv(e) {
    this.setData({ cloudEnv: e.detail.value });
  },

  onCloudFn(e) {
    this.setData({ cloudFn: e.detail.value });
  },

  onCloudKey(e) {
    this.setData({ cloudKey: e.detail.value });
  },

  persist() {
    const cfg = saveConfig({
      transport: this.data.transport,
      serverUrl: String(this.data.serverUrl || '').trim(),
      accessKey: String(this.data.accessKey || '').trim().toUpperCase(),
      cloudEnv: String(this.data.cloudEnv || '').trim(),
      cloudFn: String(this.data.cloudFn || '').trim() || 'mcd',
      cloudKey: String(this.data.cloudKey || '').trim(),
    });
    const app = getApp();
    app.globalData.config = cfg;
    app.globalData.cloudReady = false;
    app.initCloud();
    return cfg;
  },

  save() {
    this.persist();
    this.setData({ saved: true });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  reset() {
    wx.showModal({
      title: '恢复默认设置？',
      content: '会清空服务器地址和访问码（默认 ' + DEFAULTS.serverUrl + '）。',
      success: (res) => {
        if (!res.confirm) return;
        saveConfig(DEFAULTS);
        const app = getApp();
        app.globalData.config = loadConfig();
        app.globalData.cloudReady = false;
        this.load();
        wx.showToast({ title: '已恢复默认', icon: 'none' });
      },
    });
  },

  test() {
    if (this.data.testing) return;
    this.persist(); // 先存再测，避免测的是旧配置
    this.setData({ testing: true, testOk: false, testError: '', testDetail: '', testTitle: '' });
    testConnection()
      .then((r) => {
        this.setData({ testing: false, testOk: true, testTitle: (r.mode || '') + ' 连接正常', testDetail: r.detail || '' });
      })
      .catch((e) => {
        this.setData({ testing: false, testOk: false, testTitle: '连接失败', testError: (e && e.message) || String(e) });
      });
  },

  copyCommand() {
    wx.setClipboardData({
      data: 'node src/server.mjs --port 8787',
      success: () => wx.showToast({ title: '启动命令已复制', icon: 'none' }),
    });
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },
});

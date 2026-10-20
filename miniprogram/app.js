/**
 * 小程序全局入口。
 *
 * 只做三件事：
 *  1) 读配置（服务器地址 / 访问码 / 云函数环境）；
 *  2) 云函数模式下初始化 wx.cloud；
 *  3) 在页面之间传递「刚提交的任务」（不用 URL 携带参数，避免地址被转义坏）。
 */
const { loadConfig } = require('./utils/config.js');

App({
  globalData: {
    config: null,
    // 首页 → 结果页的任务交接：{ transport, kind, params, demo }
    handoff: null,
    cloudReady: false,
  },

  onLaunch() {
    this.globalData.config = loadConfig();
    this.initCloud();
  },

  onShow() {
    // 从设置页返回时配置可能已改，重新读一次
    this.globalData.config = loadConfig();
    this.initCloud();
  },

  initCloud() {
    const cfg = this.globalData.config || {};
    if (cfg.transport !== 'cloud') return;
    if (!wx.cloud) return;
    if (this.globalData.cloudReady && this.globalData.cloudEnv === cfg.cloudEnv) return;
    try {
      if (cfg.cloudEnv && wx.cloud.init) {
        wx.cloud.init({ env: cfg.cloudEnv, traceUser: false });
      }
      this.globalData.cloudReady = true;
      this.globalData.cloudEnv = cfg.cloudEnv;
    } catch (e) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = e && e.message ? e.message : String(e);
    }
  },
});

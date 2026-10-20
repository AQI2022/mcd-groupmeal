/**
 * 首页：只负责「收集参数 → 校验 → 把任务交给结果页」。
 *
 * 不在这一页发起比价：真实链路要跑几十次官方算价（10~60 秒），
 * 必须有专门的进度页，否则用户会以为卡死了。
 */
const { addresses: fetchAddresses } = require('../../utils/api.js');
const { loadConfig } = require('../../utils/config.js');

Page({
  data: {
    mode: 'group', // group | phone
    channel: 'pickup', // pickup | delivery
    people: 20,
    budget: '35',
    city: '西安市',
    keyword: '长安大厦',
    want: '巨无霸,中杯美式',
    prefer: '',
    addressQuery: '',
    addresses: [],
    addressLabels: [],
    addressIndex: -1,
    loadingAddresses: false,
    addressError: '',
    demo: false,
    quick: true,
    transport: 'http',
    transportText: 'HTTP 服务',
    endpointText: '',
    submitting: false,
    errorText: '',
  },

  onLoad() {
    this.refreshConfig();
    this.loadAddresses();
  },

  onShow() {
    this.refreshConfig();
  },

  refreshConfig() {
    const c = loadConfig();
    const transportText = c.transport === 'cloud' ? '云函数' : 'HTTP 服务';
    const endpointText = c.transport === 'cloud' ? (c.cloudEnv || '未填环境 ID') : (c.serverUrl || '未配置');
    this.setData({ transport: c.transport, transportText: transportText, endpointText: endpointText });
  },

  // ── 模式 / 渠道 ─────────────────────────────────

  onMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, errorText: '' });
  },

  onChannel(e) {
    this.setData({ channel: e.currentTarget.dataset.channel, errorText: '' });
  },

  // ── 表单 ────────────────────────────────────────

  onPeopleInput(e) {
    const v = parseInt(e.detail.value, 10);
    this.setData({ people: isFinite(v) ? v : 0 });
  },

  incPeople() {
    const v = Math.min(200, Number(this.data.people || 0) + 1);
    this.setData({ people: v });
  },

  decPeople() {
    const v = Math.max(1, Number(this.data.people || 1) - 1);
    this.setData({ people: v });
  },

  onBudgetInput(e) {
    this.setData({ budget: e.detail.value });
  },

  onCityInput(e) {
    this.setData({ city: e.detail.value });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onWantInput(e) {
    this.setData({ want: e.detail.value });
  },

  onPreferInput(e) {
    this.setData({ prefer: e.detail.value });
  },

  onAddressQueryInput(e) {
    this.setData({ addressQuery: e.detail.value, addressIndex: -1 });
  },

  onAddressChange(e) {
    const i = Number(e.detail.value);
    this.setData({ addressIndex: i });
  },

  onDemoChange(e) {
    this.setData({ demo: !!e.detail.value });
  },

  onQuickChange(e) {
    this.setData({ quick: !!e.detail.value });
  },

  // ── 地址簿 ──────────────────────────────────────

  loadAddresses() {
    if (this.data.transport === 'cloud') return;
    if (this.data.loadingAddresses) return;
    this.setData({ loadingAddresses: true, addressError: '' });
    fetchAddresses()
      .then((res) => {        const list = (res && res.addresses) || [];
        if (res && res.ok === false) {
          const msg = (res.error && res.error.message) || '读取地址簿失败';
          this.setData({ loadingAddresses: false, addresses: [], addressLabels: [], addressIndex: -1, addressError: msg });
          return;
        }
        this.setData({
          loadingAddresses: false,
          addresses: list,
          addressLabels: list.map((a) => (a.contactName ? a.contactName + '｜' : '') + a.fullAddress),
          addressIndex: list.length ? 0 : -1,
        });
      })
      .catch((e) => {
        this.setData({ loadingAddresses: false, addressError: (e && e.message) || '读取地址簿失败' });
      });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  // ── 提交 ────────────────────────────────────────

  buildParams() {
    const d = this.data;
    const picked = d.addressIndex >= 0 && d.addresses[d.addressIndex] ? d.addresses[d.addressIndex].fullAddress : '';
    const addressQuery = picked || String(d.addressQuery || '').trim();
    const quick = d.quick;

    if (d.mode === 'group') {
      const people = parseInt(d.people, 10);
      const budget = Number(String(d.budget).replace(/[^\d.]/g, ''));
      if (!isFinite(people) || people < 1) return { error: '人数至少 1 人' };
      if (people > 200) return { error: '人数请填 1–200（超大团餐请拆成多单）' };
      if (!isFinite(budget) || budget <= 0) return { error: '请填人均预算，例如 35' };
      const prefer = String(d.prefer || '')
        .split(/[,，、\s]+/)
        .filter(Boolean);
      return {
        kind: 'optimize',
        params: {
          people: people,
          budget: budget,
          addressQuery: addressQuery,
          prefer: prefer,
          maxCalls: quick ? 60 : 150,
          variants: quick ? 2 : 3,
          maxOrders: 3,
        },
      };
    }

    const want = String(d.want || '')
      .split(/[,，、\s]+/)
      .filter(Boolean);
    const budget = String(d.budget).trim() ? Number(String(d.budget).replace(/[^\d.]/g, '')) : 0;
    const params = {
      channel: d.channel,
      city: String(d.city || '').trim(),
      keyword: String(d.keyword || '').trim(),
      addressQuery: addressQuery,
      want: want,
      budget: isFinite(budget) && budget > 0 ? budget : 0,
      stores: quick ? 4 : 8,
      maxCalls: quick ? 40 : 90,
    };
    if (d.channel === 'pickup') {
      if (!params.city) return { error: '到店自取需要填城市，例如 西安市' };
      if (!params.keyword) return { error: '到店自取需要填位置关键词，例如 长安大厦' };
    } else if (!params.addressQuery) {
      return { error: '麦乐送需要先选收货地址（或填地址关键词）' };
    }
    return { kind: 'phone', params: params };
  },

  submit() {
    if (this.data.submitting) return;
    const built = this.buildParams();
    if (built.error) {
      this.setData({ errorText: built.error });
      wx.showToast({ title: built.error, icon: 'none' });
      return;
    }
    const app = getApp();
    app.globalData.handoff = {
      transport: this.data.transport,
      kind: built.kind,
      params: built.params,
      demo: this.data.demo,
    };
    this.setData({ submitting: true, errorText: '' });
    wx.navigateTo({
      url: '/pages/result/result?kind=' + built.kind,
      complete: () => this.setData({ submitting: false }),
    });
  },

  onShareAppMessage() {
    return {
      title: '给人数 + 人均预算，算出麦当劳团餐最省的一单',
      path: '/pages/index/index',
    };
  },
});

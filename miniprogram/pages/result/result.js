/**
 * 结果页：同时负责「发起任务 + 跟踪进度 + 渲染结果」。
 *
 * 两种后端的进度模型不同，这里统一成一套 UI：
 *   · HTTP：POST /api/jobs 拿到 jobId → 每 900ms 拉一次增量日志（服务端只回新日志）
 *   · 云函数：一次调用算到底，没有中间进度（云函数不支持流式返回）
 */
const { startTask, job: fetchJob, order: postOrder } = require('../../utils/api.js');
const { groupVM, phoneVM } = require('../../utils/view.js');

const POLL_INTERVAL = 900;
const POLL_MAX_MS = 5 * 60 * 1000;
const MAX_LOG_LINES = 40;

function elapsedText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}

function hintFor(code, message) {
  const m = String(message || '');
  switch (code) {
    case 'NO_TOKEN':
      return '电脑上还没有 MCP Token：把 mcp-config.example.json 复制成 mcp-config.json 并填入真实 Token，或设置环境变量 MCD_MCP_TOKEN。也可以先打开「演示数据」看界面。';
    case 'ADDRESS_NOT_FOUND':
      return '地址在账号地址簿里匹配不上。去「设置」里确认账号地址簿，或把地址关键词改成地址里的地标（例如「长安大厦」）。';
    case 'EMPTY_ADDRESS_BOOK':
      return '账号地址簿是空的。麦当劳的「可配送门店」只接受 addressId，请先在麦当劳 App → 我的 → 收货地址 里保存一个地址。';
    case 'NEED_CITY':
      return '到店自取需要「城市 + 位置关键词」两个都填，例如 西安市 / 长安大厦。';
    case 'BAD_PARAMS':
      return '参数不完整：团餐比价需要人数和人均预算。';
    case 'BAD_KEY':
      return '访问码不对。电脑上启动服务时会打印一串访问码（每次启动都会变），复制到「设置」里。';
    case 'NETWORK':
      return '连不上后端。检查：① 电脑上 node src/server.mjs 是否在跑；② 真机预览要用电脑局域网 IP 且同一个 Wi-Fi；③ 开发者工具勾选「不校验合法域名」。';
    case 'NO_ENV':
      return '云函数模式还没填环境 ID：微信开发者工具 → 云开发 → 设置 → 环境 ID。';
    case 'NO_CLOUD':
      return '这个环境没有云开发能力：确认已开通云开发，或改用 HTTP 通道。';
    case 'CLOUD_EMPTY':
      return '云函数没部署：开发者工具里右键 cloudfunctions/mcd → 上传并部署（云端安装依赖）。';
    case 'CLOUD_FAIL':
      return '云函数执行失败。若是超时，把云函数 config.json 的 timeout 调到 60，或打开「快速模式」少算几家店。';
    case 'TIMEOUT':
      return '等太久了。打开首页的「快速模式」再试（少算几家店、少验几个篮子）。';
    case 'DEMO_MODE':
      return '演示模式不会创建真实订单，也不消耗 Token。';
    default:
      if (m.indexOf('打烊') >= 0 || m.indexOf('营业时间') >= 0) return '门店当前不在营业时间。换个时间再试，或换成麦乐送渠道。';
      return '可以返回首页调整参数重试；如果一直失败，把下面的日志发给开发者。';
  }
}

Page({
  data: {
    kind: 'group',
    status: 'starting', // starting | running | done | failed
    statusText: '提交中…',
    logs: [],
    logTotal: 0,
    vm: null,
    text: '',
    canOrder: false,
    ordering: false,
    order: null,
    failedText: '',
    failedHint: '',
    demo: false,
    transport: 'http',
    elapsedText: '',
  },

  onLoad(query) {
    const app = getApp();
    const handoff = app.globalData.handoff;
    const kind = (query && query.kind) || (handoff && handoff.kind) || 'group';
    this.setData({ kind: kind });

    if (!handoff) {
      this.setData({
        status: 'failed',
        statusText: '失败',
        failedText: '任务信息已丢失（小程序被回收或直接从历史进入）。',
        failedHint: '返回首页重新发起一次即可。',
      });
      return;
    }
    this.handoff = handoff;
    this.setData({ demo: !!handoff.demo, transport: handoff.transport });
    this.start();
  },

  onUnload() {
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
  },

  // ── 发起 ────────────────────────────────────────

  /** 日志统一存成 {id,text}，WXML 用 wx:key="id"（字符串数组会撞 key）。 */
  appendLogs(lines) {
    const list = (lines || []).map((text) => {
      this.logSeq = (this.logSeq || 0) + 1;
      return { id: this.logSeq, text: String(text) };
    });
    return this.data.logs.concat(list).slice(-MAX_LOG_LINES);
  },

  start() {
    this.startedAt = Date.now();
    this.pollErrors = 0;
    this.logSeq = 0;
    this.setData({ status: 'starting', statusText: '提交中…', logs: [], logTotal: 0, vm: null, failedText: '', failedHint: '', order: null, canOrder: false, elapsedText: '0 秒' });

    api
      .startTask(this.handoff.kind, this.handoff.params, { demo: this.handoff.demo })
      .then((res) => {
        if (this.dead) return;
        if (res.transport === 'cloud') {
          // 云函数是同步模型：拿到返回值时已经算完了
          this.apply(res.payload);
          return;
        }
        this.jobId = res.jobId;
        this.setData({
          status: 'running',
          statusText: this.handoff.kind === 'phone' ? '正在逐店比价…' : '正在跑官方算价…',
        });
        this.poll(0);
      })
      .catch((e) => this.fail(e));
  },

  // ── HTTP：轮询增量日志 ───────────────────────────

  poll(from) {
    if (this.dead) return;
    this.timer = setTimeout(() => {
      api
        .job(this.jobId, from)
        .then((res) => {
          if (this.dead) return;
          const job = res && res.job;
          if (!job) throw new Error('任务查询失败：服务端没有返回任务对象');
          this.pollErrors = 0;
          const incoming = job.logs || [];
          // 服务端用「日志总条数」当游标；拿不到就本地累加，保证不重不漏
          this.serverCount = (typeof job.logTotal === 'number' ? job.logTotal : (this.serverCount || 0) + incoming.length);
          const logs = this.appendLogs(incoming);
          this.setData({
            logs: logs,
            logTotal: this.serverCount,
            elapsedText: elapsedText(Date.now() - this.startedAt),
            statusText: job.status === 'running' ? (this.data.kind === 'phone' ? '正在逐店比价…' : '正在跑官方算价…') : this.data.statusText,
          });
          if (job.status === 'done') return this.apply(job.result);
          if (job.status === 'failed') return this.fail(job.error || { message: '任务失败' });
          if (Date.now() - this.startedAt > POLL_MAX_MS) {
            return this.fail({ message: '等了 5 分钟还没算完', code: 'TIMEOUT' });
          }
          return this.poll(this.serverCount);
        })
        .catch((e) => {
          if (this.dead) return;
          this.pollErrors += 1;
          // 轮询偶发网络抖动不该让整单失败：连续 3 次才报错
          if (this.pollErrors <= 3) {
            return this.poll(this.serverCount || 0);
          }
          this.fail(e);
        });
    }, POLL_INTERVAL);
  },

  // ── 结果 / 失败 ─────────────────────────────────

  apply(payload) {
    if (this.dead) return;
    const result = payload && payload.result;
    const vm = this.data.kind === 'phone' ? phoneVM(result, this.handoff.params) : groupVM(result, this.handoff.params);
    let logs = this.data.logs;
    if (payload && Array.isArray(payload.logs) && payload.logs.length && !logs.length) {
      logs = this.appendLogs(payload.logs);
      this.serverCount = payload.logs.length;
    }
    this.setData({
      status: 'done',
      statusText: vm.noPlan ? '没有可用方案' : '算完了',
      vm: vm,
      logs: logs,
      logTotal: logs.length,
      text: (payload && payload.text) || '',
      canOrder: !!(payload && payload.canOrder) && !!this.jobId,
      elapsedText: elapsedText(Date.now() - this.startedAt),
    });
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  fail(e) {
    if (this.dead) return;
    const message = (e && e.message) || String(e);
    const code = (e && e.code) || '';
    this.setData({
      status: 'failed',
      statusText: '失败',
      failedText: message,
      failedHint: hintFor(code, message),
      elapsedText: elapsedText(Date.now() - this.startedAt),
    });
  },

  retry() {
    if (this.dead) return;
    if (!this.handoff) {
      wx.reLaunch({ url: '/pages/index/index' });
      return;
    }
    this.start();
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  // ── 操作 ────────────────────────────────────────

  copyText() {
    const text = this.data.text || '';
    if (!text) {
      wx.showToast({ title: '还没有可复制的文案', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，可粘到群里', icon: 'none' }),
    });
  },

  onOrderTap() {
    if (this.data.ordering) return;
    if (!this.data.canOrder || !this.jobId) {
      wx.showToast({ title: '这次没有可下单的方案', icon: 'none' });
      return;
    }
    const priceText = this.data.vm && this.data.vm.best ? this.data.vm.best.priceText : '';
    wx.showModal({
      title: '生成支付链接？',
      content: '这会创建一笔真实「未支付」订单（不会自动付款），金额以官方算价为准：' + priceText + '。生成后你需要在麦当劳里完成支付。',
      confirmText: '生成链接',
      cancelText: '先不下单',
      success: (res) => {
        if (res.confirm) this.doOrder();
      },
    });
  },

  doOrder() {
    this.setData({ ordering: true });
    api
      .order(this.jobId, { confirm: true })
      .then((res) => {
        if (!res || res.ok !== true) throw new Error((res && res.error) || '下单失败');
        const o = res.order || {};
        this.setData({
          ordering: false,
          order: {
            orderId: o.orderId || '',
            amountText: o.amount ? '¥' + o.amount : '',
            status: o.status === null || o.status === undefined ? '' : String(o.status),
            payUrl: o.payH5Url || '',
          },
        });
      })
      .catch((e) => {
        this.setData({ ordering: false });
        wx.showModal({ title: '下单失败', content: (e && e.message) || '未知错误', showCancel: false });
      });
  },

  copyPayUrl() {
    const url = this.data.order && this.data.order.payUrl;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制，去浏览器付款', icon: 'none' }),
    });
  },

  onShareAppMessage() {
    const vm = this.data.vm;
    const title = vm && vm.best ? '人均 ' + vm.best.perHeadText + '｜麦当劳团餐比价结果' : '给人数 + 预算，算麦当劳最省的一单';
    return { title: title, path: '/pages/index/index' };
  },
});

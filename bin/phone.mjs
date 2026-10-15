#!/usr/bin/env node
/**
 * bin/phone.mjs —— 手机点餐的「一问一答」入口（被 bin/mcd-phone.cmd 调用，也可直接 node 跑）。
 *
 *   node bin/phone.mjs                               # 交互式：城市 / 位置 / 想吃什么 / 预算
 *   node bin/phone.mjs 西安市 长安大厦 巨无霸,中杯美式   # 直接给参数
 *   node bin/phone.mjs --demo                        # 离线演示（构造数据，不需要 Token）
 *
 * 设计口径与 bin/meal.mjs 一致：失败时不丢一个退出码，而是给中文的下一步动作。
 */
import readline from 'node:readline/promises';
import process from 'node:process';

import { McpClient } from '../src/mcp-client.mjs';
import { loadTokenConfig } from '../src/cli.mjs';
import { solvePhoneOrder, renderPhoneCard, CHANNEL } from '../src/phone.mjs';
import { MockClient } from '../src/mock.mjs';
import { yuanToCents } from '../src/money.mjs';

const TOKEN_HELP = `没有找到 MCP Token。

请任选一种方式补齐：
  ① 打开 https://open.mcd.cn/mcp → 右上角【登录】（手机号验证码）→【控制台】→【激活】→ 一键复制 Token
  ② 复制 mcp-config.example.json 为 mcp-config.json，把 YOUR_MCP_TOKEN 换成刚复制的 Token
  ③ 或者设置环境变量 MCD_MCP_TOKEN
  ④ 只是想先看效果：运行  bin\\mcd-phone.cmd --demo  （演示数据，不需要 Token）`;

async function main() {
  const argv = process.argv.slice(2);
  const demo = argv.includes('--demo');
  const positional = argv.filter((a) => !a.startsWith('--'));

  let city = positional[0];
  let keyword = positional[1];
  let want = positional[2];
  let budget = positional[3];

  const interactive = process.stdin.isTTY && (!city || !keyword);
  let rl = null;
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('\n=== 麦当劳手机点餐 · 到店自取 ===\n\n');
  }
  try {
    if (!city && rl) city = (await rl.question('1/4 城市（例如 西安市）：')).trim();
    if (!keyword && rl) keyword = (await rl.question('2/4 位置关键词（例如 长安大厦）：')).trim();
    if (want === undefined && rl) want = (await rl.question('3/4 想吃什么，逗号分隔（留空=按预算自动配餐）：')).trim();
    if (budget === undefined && rl) budget = (await rl.question('4/4 单人预算，单位元（留空=不限）：')).trim();
  } finally {
    if (rl) rl.close();
  }

  if (!demo && (!city || !keyword)) throw new Error('缺少位置。用法：node bin/phone.mjs 西安市 长安大厦 巨无霸,中杯美式');

  const client = demo ? new MockClient() : null;
  if (!demo) {
    const cfg = loadTokenConfig();
    if (!cfg?.token) {
      process.stderr.write(`\n❌ ${TOKEN_HELP}\n\n`);
      return 1;
    }
  }
  const live = client ?? new McpClient({ token: loadTokenConfig().token, url: loadTokenConfig().url });

  process.stdout.write(
    `\n============================================================\n` +
      `  手机点餐（到店自取）| ${city || '演示市'} ${keyword || '演示路'} | 想吃：${want || '（自动配餐）'}\n` +
      `  正在问麦当劳官方接口（几秒到几十秒），请勿关闭窗口……\n` +
      `============================================================\n\n`,
  );

  try {
    const result = await solvePhoneOrder({
      client: live,
      channel: CHANNEL.PICKUP,
      city,
      keyword,
      want: String(want ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      budgetCents: budget ? yuanToCents(budget) : undefined,
    });
    if (demo) process.stdout.write('⚠️ 演示数据：门店名、券与价格均为构造数据，不是真实门店报价。\n\n');
    process.stdout.write(renderPhoneCard(result) + '\n');
    process.stdout.write('\n提示：以上金额全部来自官方 calculate-price；下单与支付请在麦当劳 App / 小程序里完成。\n');
    return result.comparisons.length ? 0 : 1;
  } catch (err) {
    if (err.code === 'EMPTY_ADDRESS_BOOK') {
      process.stderr.write('\n❌ 账号地址簿为空：请先在麦当劳 App 里保存一个收货地址。\n\n');
      return 1;
    }
    process.stderr.write(`\n❌ 运行失败：${err.message}\n\n`);
    process.stderr.write('先跑 bin\\mcd-doctor.cmd 自检 Token / 握手 / 地址簿，通常能直接定位原因。\n\n');
    return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`\n❌ ${err.message}\n\n`);
    process.exit(1);
  });

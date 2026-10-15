#!/usr/bin/env node
/**
 * bin/meal.mjs —— 面向普通用户的一步式入口（被 bin/*.cmd 调用，也可直接 `node bin/meal.mjs`）。
 *
 * 与 src/cli.mjs 的区别：这里会把「要填什么」问清楚，并在失败时给出**中文的下一步动作**，
 * 而不是抛一个退出码。所有文字都在这个 UTF-8 的 .mjs 里，避免 Windows 批处理的中文编码问题。
 *
 *   node bin/meal.mjs                 # 交互式提问
 *   node bin/meal.mjs 20 35 西安       # 直接给参数
 */
import readline from 'node:readline/promises';
import process from 'node:process';

import { McpClient } from '../src/mcp-client.mjs';
import { loadTokenConfig } from '../src/cli.mjs';
import { optimize } from '../src/optimizer.mjs';
import { renderReport } from '../src/render.mjs';
import { yuanToCents } from '../src/money.mjs';

const TOKEN_HELP = `没有找到 MCP Token。

请任选一种方式补齐：
  ① 打开 https://open.mcd.cn/mcp → 右上角【登录】（手机号验证码）→【控制台】→【激活】→ 一键复制 Token
  ② 复制 mcp-config.example.json 为 mcp-config.json，把 YOUR_MCP_TOKEN 换成刚复制的 Token
  ③ 或者设置环境变量 MCD_MCP_TOKEN
  ④ 只是想先看效果：运行  bin\\mcd-demo.cmd  （演示数据，不需要 Token）`;

const ADDRESS_HELP = `你的麦当劳账号地址簿是空的。

团餐门店查询（delivery-query-stores）只接受 addressId，而 addressId 只能来自账号地址簿：
  打开麦当劳 App / 小程序 → 我的 → 收货地址 → 新增并保存一个地址（约 30 秒）
  想比较多个城市，就存多条地址。存完再跑一次即可。`;

function ask(rl, question) {
  return rl.question(question);
}

async function main() {
  const argv = process.argv.slice(2);
  let people = argv[0];
  let budget = argv[1];
  let address = argv[2];

  const interactive = process.stdin.isTTY && (!people || !budget || !address);
  let rl = null;
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('\n=== 麦当劳团餐比价 · 三步 ===\n\n');
  }

  try {
    if (!people) {
      if (!rl) throw new Error('缺少参数：人数。用法：node bin/meal.mjs 20 35 西安');
      people = (await ask(rl, '1/3 人数（例如 20）：')).trim();
    }
    if (!budget) {
      if (!rl) throw new Error('缺少参数：人均预算。用法：node bin/meal.mjs 20 35 西安');
      budget = (await ask(rl, '2/3 人均预算，单位元（例如 35）：')).trim();
    }
    if (!address) {
      if (!rl) throw new Error('缺少参数：地址。用法：node bin/meal.mjs 20 35 西安');
      address = (await ask(rl, '3/3 地址关键词或城市（例如 西安、长安大厦）：')).trim();
    }
  } finally {
    if (rl) rl.close();
  }

  const n = Number(people);
  const budgetCents = yuanToCents(budget);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`人数「${people}」不是正整数`);
  if (!budgetCents) throw new Error(`人均预算「${budget}」不是有效金额`);

  const cfg = loadTokenConfig();
  if (!cfg?.token) {
    process.stderr.write(`\n❌ ${TOKEN_HELP}\n\n`);
    return 1;
  }

  process.stdout.write(
    `\n============================================================\n` +
      `  团餐比价 | ${n} 人 | 人均 ¥${budget} | 地址「${address}」\n` +
      `  正在询问麦当劳官方接口（约 30~90 秒，最多 97 次官方算价），请勿关闭窗口……\n` +
      `============================================================\n\n`,
  );

  const client = new McpClient({ token: cfg.token, url: cfg.url });

  try {
    const result = await optimize({
      client,
      people: n,
      budgetPerPersonCents: budgetCents,
      addressQuery: address,
    });
    process.stdout.write(renderReport(result, { people: n, budgetPerPersonCents: budgetCents }) + '\n');
    process.stdout.write('\n提示：以上每个金额都来自官方 calculate-price 算价回执；下单请在麦当劳 App / 小程序完成支付。\n');
    return result.best ? 0 : 1;
  } catch (err) {
    if (err.code === 'EMPTY_ADDRESS_BOOK') {
      process.stderr.write(`\n❌ ${ADDRESS_HELP}\n\n`);
      return 1;
    }
    if (/找不到匹配/.test(err.message)) {
      process.stderr.write(`\n❌ ${err.message}\n\n`);
      process.stderr.write('打开麦当劳 App → 我的 → 收货地址，确认地址文字，或换一个更短的关键词（如城市名）重试。\n\n');
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

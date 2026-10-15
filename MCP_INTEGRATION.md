# MCP 集成说明 · MCP_INTEGRATION.md

> 本文档说明 `mcd-groupmeal` **实际使用了哪些麦当劳 MCP Server / Tool、调用流程长什么样、以及业务价值在哪里**。
> 所有调用参数、返回结构与错误处置均来自 **2026-10-15 对真实服务端的实测**，可复现（`node tools/lifeline-probe.mjs`）。

---

## 1. MCP Server 接入

| 项 | 值 |
|---|---|
| Server 名称 | 麦当劳中国 MCP Server（`mcd-mcp`） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | **Streamable HTTP** |
| 协议版本 | `2025-06-18`（服务端仅支持该版本及之前） |
| 鉴权 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 限流 | **600 次/分钟**，超限返回 `429`（客户端内置令牌桶 + 指数退避） |
| 会话 | 服务端下发 `mcp-session-id`，后续请求必须回带 |
| Token 申请 | <https://open.mcd.cn/mcp> → 登录 → 控制台 → 激活 |
| 实测工具总数 | **35**（官方 README 表格列 33 个；多出来的正是本项目的核心依赖 `query-promotions` 与 `query-survey-coupon`） |

配置（`mcp-config.example.json`，**仓库内只有占位符**）：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

客户端实现见 [`src/mcp-client.mjs`](./src/mcp-client.mjs)：**零依赖**，自己完成 `initialize` → 会话维护 → SSE/JSON 双形态响应解析 → 429/5xx 退避 → 工具名归一化 → 业务错误码处置。

---

## 2. 实际使用的 Tool（团餐链路 5 个 + 手机点餐链路 6 个）

团餐链路（`optimize`）：

| # | Tool | 在本项目中的职责 | 关键入参 | 关键出参 |
|--:|---|---|---|---|
| 1 | `delivery-query-stores` | 地址 → **全部可配送团餐门店**（跨门店比价的入口） | `addressId`, `beType=6` | `data[]`: `storeCode`, `beCode`, `storeName`, `reservation`, `reservationTimeOptions` |
| 2 | `query-meals` | 门店**实时菜单**（价格与可售构成） | `storeCode`, `beCode`, `beType=6`, `orderType=2` | `data.meals{code:{name,currentPrice,originalPrice}}`, `data.categories[]` |
| 3 | `query-meal-assistance` | **助餐服务档位** → `gmServiceCode`（团餐链路的钥匙） | `storeCode`, `beCode`, `orderType=2`, `beType=6` | `data.mealAssistanceItems[]`: `gmServiceCode`, `gmServiceName`, `serviceItems[]`, `enable`, `unusableReason` |
| 4 | `query-promotions` | **团餐满折/满减规则**（本项目的技术护城河） | `storeCode`, `beCode`, `beType=6`, `orderType=2` | `data[]`: `promotionType`(31满额减/33订单折扣), `ruleCategory`(30满折/40满减), `gmServiceCode`, `products[]`, `ruleDetail` |
| 5 | `calculate-price` | **官方权威算价**（唯一可信的金额口径） | `storeCode`, `beCode`, `beType=6`, `orderType=2`, `gmServiceCode`, `addressId`, `items[]` | `data`: `productOriginalPrice` / `discount` / `deliveryPrice` / `packingPrice` / `price` / `enjoyable` |

手机点餐链路（`phone`，到店自取 beType=1 / 麦乐送 beType=2）：

| # | Tool | 在本项目中的职责 | 关键入参 | 关键出参 |
|--:|---|---|---|---|
| 1 | `query-nearby-stores` | 到店：城市 + 位置 → 附近门店与距离（**不需要地址簿**） | `beType=1`, `searchType=2`, `city`, `keyword` | `data[]`: `storeCode`（无 `beCode`）, `storeName`, `distance`, `businessStatus` |
| 2 | `delivery-query-stores` | 麦乐送：地址 → 可配送门店 | `addressId`, `beType=2` | `data[]`: `storeCode`, `beCode`, `businessStatus` |
| 3 | `query-meals` | 门店菜单与单价（到店实测 130 项 / 麦乐送 125 项） | `storeCode`, `orderType`, `beType`（外送加 `beCode`） | 同团餐 |
| 4 | `query-store-coupons` | **本账号在该店该渠道可用的券**（券找货的入口） | `storeCode`, `orderType`, `beType`（外送加 `beCode`） | `data[]`: `title`, `couponId`, `couponCode`, `tradeDateTime`, `products[{productCode,productName}]` |
| 5 | `calculate-price` | 逐「用券组合」验价（含 `items[].couponId`/`couponCode`） | + `items[].couponId`/`couponCode` | 同团餐（到店无配送费） |
| 6 | `create-order` | 可选：生成**未支付**订单 + `payH5Url`（手机可直接付款） | `storeCode`, `orderType`, `beType`, `items`, `takeWayCode`(到店必传) / `addressId`(外送必传) | `data`: `orderId`, `amount`, `payH5Url`, `status` |

辅助（非核心链路）：

| Tool | 用途 |
|---|---|
| `delivery-query-addresses` | 读取账号地址簿 → `addressId`（**没有地址就查不到任何外送/团餐门店**） |
| `available-coupons` | 麦麦省**可领取**券清单（实测只返回 Markdown，且不含券 ID → 必须先 `auto-bind-coupons`） |
| `auto-bind-coupons` | 一键领取麦麦省券（**会改写账号券包**，本项目默认不调用） |
| `campaign-calendar` | 当月营销活动日历（实测只返回 Markdown） |
| `now-time-info` | 用服务端时间校验促销规则有效期，避免客户端时钟偏差 |

> 为什么不用官方 `@modelcontextprotocol/sdk`：本项目要打「一行命令能跑」的体验，零运行时依赖让 `npx mcd-groupmeal` 不需要拉任何包；同时直连 JSON-RPC 层便于排障（`mcd-groupmeal doctor` 会把握手到工具清单的结果全打印出来）。

---

## 3. 调用流程

```
                         ┌─────────────────────────────────────────┐
  用户输入                │ --people 20 --budget 35 --address 西安    │
                         └───────────────────┬─────────────────────┘
                                             ▼
 ① 地址解析        delivery-query-addresses ─▶ 在账号地址簿里模糊匹配（城市/写字楼/完整地址）
                                             ▼
 ② 门店发现        delivery-query-stores{addressId, beType:6} ─▶ 全部可配送团餐门店 S
                                             ▼
 ③ 门店画像（每店并行，TTL 10 分钟缓存）
      ├─ query-meals               ─▶ 菜单与价格（品类识别：汉堡/薯条/小食/饮料/甜品）
      ├─ query-meal-assistance     ─▶ gmServiceCode 档位（默认只有 GMS001 可用）
      └─ query-promotions          ─▶ 满折/满减阶梯（按 gmServiceCode 分组）
                                             ▼
 ④ 候选生成（本地，零调用）
      官方分档约束（<20 / 20–30 / 30–40 / 40–50 / >50 元）→ 每人份搭配 → 基线 / 均衡 / 顶格 3 个篮子
      用本地规则模型估算实付做**预筛**，只有入选篮子才进入算价
                                             ▼
 ⑤ 单笔验价        calculate-price(门店 × 助餐档 × 篮子) ─▶ 官方实付（含配送费/打包费/优惠）
                                             ▼
 ⑥ 拆单枚举        单笔最优的若干组合 → 人数拆分 k ≤ 3 → 每单独立 calculate-price ─▶ 拆与不拆的诚实对比
                                             ▼
 ⑦ 排序输出        按「人均实付」排序 ─▶ 跨门店比价矩阵 + 最优方案 + 拆单结论 + 凑单提示
```

### 调用量与限流控制

| 措施 | 实现 |
|---|---|
| 本地缓存 | 门店画像 TTL 10 分钟（`src/mcd.mjs` 的 `TtlCache`），同一门店不重复拉 |
| 候选预筛 | 本地规则模型先算，明显超预算的篮子不调 `calculate-price` |
| 令牌桶 | 客户端内置 600 rpm 令牌桶，与官方限制一致 |
| 退避重试 | `429`/`5xx`/网络错误指数退避；业务 `code=500`（实测偶发）也会重试 |
| 拆单预算 | 给每个目标门店分配一份算价预算，用完即收敛，并在输出里如实告知「已抽样」 |
| 单次运行硬上限 | `--max-calls`（默认 150） |

**实测开销**：20 人比价（3 家门店 × 3 个篮子 + 拆单枚举）= **98 次 `calculate-price`**，远低于 600 rpm。

---

## 4. 真实返回结构（实测，含踩过的坑）

### 4.1 返回体不是纯 JSON

工具返回是「markdown 说明 + 内嵌 JSON + 尾随说明」的混合文本，而且 markdown 说明本身含 `{序号}`、`{data[].storeCode}` 这类花括号占位符，**JSON 也不一定在字符串末尾**。
→ 因此不能用 `indexOf('{')..lastIndexOf('}')` 切片，必须按**平衡花括号**扫描。实现见 [`src/json.mjs`](./src/json.mjs)。

### 4.2 金额单位不统一

`calculate-price` 原生返回**分**；`query-meals` 的 `currentPrice`、`query-promotions` 的 `startDiscountPoint`/`reduceAmount` 都是**元字符串**。
→ 业务层入口统一转分，全程整数加总（[`src/money.mjs`](./src/money.mjs)）。

### 4.3 满折的真实口径（**用官方算价反证过**）

`query-promotions` 返回 12 条规则，形如：

```json
{
  "promotionId": "331878001", "promotionType": "33", "ruleCategory": 30,
  "gmServiceCode": "GMS001",
  "products": [{ "type": "2", "productCode": "9900016058" }, ...],
  "ruleDetail": { "orderDiscount": { "discount": "26", "startDiscountPoint": "500" } }
}
```

- `discount: "26"` = **让利 26%**，即 **7.4 折**（官方注释：「如 30 表示 7 折」）。
- `startDiscountPoint: "500"` = 门槛 **¥500**（单位是元）。
- `products[].type: "2"` = **不包含**这几件商品 → 折扣覆盖全单，但要先剔除它们。

用 `calculate-price` 逐档反证（同一门店，单品 × N）：

| 小计 | 商品小计(分) | 让利 | 商品折后(分) | 配送费 | 打包费 | 实付(分) | 结论 |
|---:|---:|---:|---:|---:|---:|---:|---|
| ¥30 | 3000 | 0% | 3000 | 600 | 160 | **3760** | 未达门槛，无优惠 |
| ¥300 | 30000 | 22% | 23400 | 600 | 600 | **24600** | 命中满 ¥300 档；配送费照收 |
| ¥510 | 51000 | 26% | 37740 | **0** | 900 | **38640** | 命中满 ¥500 档；**已免配送费** |
| ¥1005 | 100500 | 30% | 70350 | 0 | 900 | **71250** | 命中满 ¥1000 档 |

由此确认三条可写进代码的规则：
1. **折扣只作用在可参与商品小计上**，配送费/打包费不参与打折；
2. **满 ¥500 左右起免配送费**（¥300 仍收 ¥6，¥510 已免）——这是「拆单更贵」的重要成因；
3. 同一助餐档位下取「门槛 ≤ 小计」中门槛最高的那一档。

### 4.4 `enjoyable` 是官方白送的凑单信息

`calculate-price` 返回体里有：

```json
"enjoyable": { "amountType": "2", "realDiscount": 7.8, "balance": 27000 }
```

实测语义：**`balance` 是「距离下一档还差多少（分）」，`realDiscount` 是下一档的折扣（折）**。
例：小计 ¥30 时 `balance=27000`（差 ¥270 到 ¥300 档）、`realDiscount=7.8`；小计 ¥510 时 `balance=49000`（差 ¥490 到 ¥1000 档）、`realDiscount=7.0`。

本项目把它直接做成产品功能：**「再消费 ¥X 就能升到 Y 折」**，并明确标注「这是客观档位差，不代表建议加购」。

### 4.5 业务错误码处置

| code | 含义 | 本项目的处置 |
|---|---|---|
| `401` | Token 无效/过期/未提供 | 直接抛出并提示去控制台重新激活 |
| `429` | 超 600 rpm | 指数退避重试 |
| `500` | 服务端未知错误（实测在 `query-promotions` 上偶发） | 重试 2 次；仍失败则**该店降级**（按「无规则」处理）并把原因写进输出的告警区，不让整次比价崩掉 |
| `600010` | 用券缺 `couponId`/`couponCode` | 内置处置建议文案 |
| `600012` | 促销规则不支持该商品 | 同上 |
| `600050` | 收藏餐厅为空 | 建议改 `searchType=2` + `city` + `keyword` |
| `600058` | `city`/`keyword` 缺一 | 同上 |

### 4.6 一个必须知道的硬前提

`delivery-query-stores` **只接受 `addressId`**，而 `addressId` 只能来自账号地址簿（`delivery-query-addresses`）。
→ **账号里没有配送地址 = 一家团餐门店都查不到**。这是假阴性，不是工具坏了。
本项目在地址簿为空时抛出 `EMPTY_ADDRESS_BOOK` 并给出明确指引，而不是静默返回「0 家门店」。

> 补充（`phone` 模式新增）：**到店自取（`query-nearby-stores`）不需要地址簿**，
> 只要 `city` + `keyword` 就能列店与距离，且 beType=1 返回的门店**没有 `beCode`**（后续调用一律不传）。
> 这是「手机上点餐」里依赖最少的一条路。

### 4.7 手机点餐链路的 5 条实测补充（2026-10-15）

`phone` 模式把链路扩到「到店自取 / 麦乐送」后，又踩到 5 个必须写下来的行为：

| # | 实测行为 | 影响与处置 |
|---|---|---|
| 1 | 非营业时间 `query-meals` 返回 **`code=600057 门店可能已关闭或不在营业时间`**，菜单为空 | 不能把「菜单 0 项」当成「这家店没有菜单」。本项目识别 600057 → 门店进「已排除（当前非营业时间）」 |
| 2 | `query-store-coupons` 的 `products[].productCode` **可能不在 `query-meals` 菜单里**（实测 `9900000119 美式中杯` 不在 130 项菜单中） | 这是**券专属商品**：菜单搜不到、不带券算价返回 `price=0` 且 `productList=[]`。「券找货」必须从券里取商品码 |
| 3 | 券专属商品在「不用券」组合里会被官方**直接丢弃** | 若按价格取最小值，会得出「别用券更省」的**假结论**。必须先按回执 `productList` 校验「是否买齐清单」（`priceCovers()`） |
| 4 | **券是分渠道的**：同一门店同一账号，到店自取有 2 张券、麦乐送 0 张、团餐 0 张；把到店券塞进麦乐送算价 → `600012 当前优惠券不可用！` | 「我有券」≠「这单能用券」。必须按**门店 + 渠道**分别查 `query-store-coupons` |
| 5 | `available-coupons` 与 `campaign-calendar` **只返回 Markdown，没有 `success/code/data`** | 客户端若按「非 JSON 即失败」判定，会把成功调用误判为失败。本项目为这类工具返回 `kind:'text'` 并单独解析；要先 `auto-bind-coupons` 领券才会带出 `couponId` 进入算价 |

另外一个**渠道差异**的量化对照（同一家店、同一个商品、同一张券）：

| 渠道 | 该店可用券数 | 「美式中杯」带券算价 |
|---|---:|---|
| 到店自取（orderType=1 / beType=1） | 2 | `productPrice=1330`、`discount=570`（¥19.00 → ¥13.30） |
| 麦乐送（orderType=2 / beType=2） | 0 | 业务失败 `600012 当前优惠券不可用！` |
| 团餐（beType=6） | 0 | — |

---

## 5. 业务价值

| 价值点 | 具体是什么 | 依赖的 Tool |
|---|---|---|
| **把难题接过来** | 官方在 `query-promotions` 的说明里明确写：「由大模型自行根据规则解读优惠并计算搭配方案，**工具不做最优推荐**」。本项目就是把这句「留给开发者」的难题做成了一个可复现的求解器 | `query-promotions` |
| **跨门店比价** | 同一地址下所有可配送团餐门店的菜单价格不同（西安 3 店实测：67 个共同商品里 14 项有店间价差），求解器把它们放在同一张表里比较 | `delivery-query-stores` + `query-meals` |
| **助餐档位对比** | `GMS001 保鲜速达` / `GMS002 专人分餐` / `GMS003 专人摆台` 的让利率不同；后两者需提前 ≥4h 预约。选错档位实测可差 **¥100.50**（20 人单） | `query-meal-assistance` + `query-promotions` |
| **拆单的诚实结论** | 穷举 k ≤ 3 拆法并逐单用官方算价验证。实测满折场景下拆 2 单要**多付 ¥26.42~52.55**，所以直接告诉用户「**别拆**」——比承诺「立省 X 元」更抗打脸 | `calculate-price` |
| **官方验价兜底** | 所有对外数字都来自 `calculate-price`，本地模型只用于预筛。任何方案都能复现、能证伪 | `calculate-price` |
| **凑单提示** | 直接用官方 `enjoyable.balance` 告诉用户距下一档还差多少 | `calculate-price` |
| **手机点餐「券找货」** | 把账号在该店该渠道可用的券 × 菜单 × 官方算价交叉，算出「去哪家店、点这些、勾哪张券、实付多少」；还能算出券锁着但菜单里没有的商品（实测 ¥19.00 → ¥13.30） | `query-nearby-stores` / `delivery-query-stores` + `query-store-coupons` + `query-meals` + `calculate-price` |
| **下单闭环（可选）** | `create-order` 返回 `payH5Url`，手机上点开即可付款；本项目默认只算不下单，`--pay` 才创建**未支付**订单 | `create-order` |

---

## 6. 可复现的验证脚本

| 脚本 | 作用 | 产出 |
|---|---|---|
| `node tools/lifeline-probe.mjs` | A~E 生死线验证（门店数 / 菜单 / gmServiceCode / 规则 / 算价） | [`docs/LIFELINE.md`](./docs/LIFELINE.md) |
| `node tools/city-scan.mjs` | 8 城团餐门店、店间价差、折扣阶梯对比 | [`docs/CITY-COMPARISON.md`](./docs/CITY-COMPARISON.md) |
| `node src/cli.mjs doctor` | 握手 / 工具清单 / 地址簿自检 | 终端输出 |
| `node src/cli.mjs demo` | **不需要 Token**，用离线演示数据跑通同一条代码路径 | 终端输出 |
| `node src/cli.mjs phone --demo` | **不需要 Token**，手机点餐链路离线演示（含券、券专属商品、打烊门店） | 终端输出 |
| `node test/core.test.mjs` | 33 个单元测试（规则解析、拆单、分档、MCP 返回体解析、离线定价器对齐官方口径、手机点餐 9 项） | 通过/失败 |

`phone` 模式新增的 9 项测试覆盖的正是上面 §4.7 的坑：
券商品匹配、单券组合不串券、`priceCovers()` 识别「券商品被丢弃」、打烊门店排除、
到店/麦乐送端到端实付、自动配餐预算、下单参数拼装、文字型工具不误判。

---

## 7. 合规声明

- 仓库内**不含任何真实 Token / 手机号 / 完整地址 / `addressId`**；`mcp-config.json` 已被 `.gitignore` 忽略，示例文件只有占位符。
- 验证脚本对地址与 `addressId` 做脱敏后才落盘。
- 本项目为麦当劳程序员节创意开发大赛参赛作品，由参赛者独立开发，**非麦当劳官方产品**；输出仅供参考，餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。
- 详见 [`CONTEST_DECLARATION.md`](./CONTEST_DECLARATION.md)。

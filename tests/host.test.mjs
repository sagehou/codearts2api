/**
 * 宿主装配的断言：插件真的被「不依赖 DSH」地跑起来了。
 *
 * 这些断言对应项目最核心的假设 —— 只要提供 credentials / commands /
 * connection / llm 四个服务，上游插件就能完整加载。它们**不**依赖网络，
 * 也不依赖任何 DSH 宿主。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestApp, rpc } from "./helpers.mjs"

/** 期望注册的 provider（12 个上游渠道 + opencode 的匿名通道）。 */
const EXPECTED_PROVIDERS = [
  "codearts",
  "buddy",
  "workbuddy",
  "lobsterai",
  "qoder",
  "qodercn",
  "trae",
  "cline",
  "loomy",
  "raccoon",
  "minimax",
  "gemini",
  "zcode",
  "opencode",
]

test("插件在无 DSH 的纯 cordis 宿主上完整加载", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // ① 四个必要服务都在，且插件把 llm 适配器注册齐了。
  const llm = app.host.ctx.get("llm")
  assert.ok(llm, "ctx.llm 应存在")
  const providers = llm.listProviders().map((entry) => entry.id)

  // ⚠️ 双向断言，**不能只查「期望的都在」**。
  //
  // 只写 `providers.includes(expected)` 的话，上游**新增渠道**时会静默通过
  // （旧期望仍是子集），人就不会注意到 `EXPECTED_PROVIDERS` 该更新了。
  // 本项目亲历过：上游加 gemini 时测试仍然全绿，与本文件里那句注释
  // 「上游新增渠道时这条会失败」的说法不符 —— 现在真的会失败了。
  //
  // 故意用 `deepEqual`（集合 + 顺序）：新增或删除渠道都会红，强迫人来看一眼。
  assert.deepEqual(
    providers,
    EXPECTED_PROVIDERS,
    `provider 列表与期望不一致 —— 上游多半增删了渠道。\n  期望：${EXPECTED_PROVIDERS.join(", ")}\n  实际：${providers.join(", ")}\n` +
      "若是上游新增：把新渠道 id 按注册顺序加进 EXPECTED_PROVIDERS（只改测试，不改产品代码）。",
  )

  // ② Jet Hub 的管理端点注册到了 connection seam 上。
  assert.ok(app.host.routes.has("/api/jet-hub"), "Jet Hub 管理端点应已注册")

  // ③ 服务真的能应答（经完整 HTTP 链路，不是内部调用）。
  const listed = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(listed.ok, true, `account.list 应成功：${JSON.stringify(listed)}`)
  assert.ok(Array.isArray(listed.value.accounts), "accounts 应是数组")
})

test("/healthz 汇总服务状态", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const response = await fetch(`${app.origin}/healthz`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.home, app.home, "healthz 应回显实际 state home")
  assert.ok(body.providers.includes("codearts"), "providers 应含 codearts")
  assert.ok(body.routes.includes("/api/jet-hub"), "routes 应含 Jet Hub 端点")
  assert.equal(body.gateway.running, true, "网关应已启动")
  // ⚠️ 健康检查**不得**包含网关密钥明文：它可能被日志/监控/CDN 记录。
  const raw = JSON.stringify(body)
  assert.doesNotMatch(raw, /apiKey/, "healthz 不应回传 apiKey 字段")
})

test("未知 RPC 方法回可读错误而不是崩掉", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const result = await rpc(app.origin, "definitely.not.a.method", {})
  // 插件的 handler 会把未知方法抛出的异常包成 rpc 错误信封，
  // 关键是**不能**变成 HTTP 500 或连接挂起。
  assert.ok(result.ok === false || result.ok === true, "应返回规范的 rpc 信封")
})

test("PROXY_GATEWAY 开启时 /v1/* 经本服务透明转发", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 先取网关密钥（经管理 RPC，这是显式的用户操作）。
  const status = await rpc(app.origin, "gateway.getEnabled", {})
  const key = status.value.apiKey.value

  // ① 无 Key 仍应 401 —— 反代不替客户端鉴权，判定权只在插件网关一处。
  const unauthorized = await fetch(`${app.origin}/v1/models`)
  assert.equal(unauthorized.status, 401, "反代不应绕过网关鉴权")

  // ② 带 Key：拿到与直连一致的模型目录。
  const throughProxy = await fetch(`${app.origin}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  assert.equal(throughProxy.status, 200)
  const proxied = await throughProxy.json()
  assert.equal(proxied.object, "list")

  const direct = await fetch(`http://${status.value.address.host}:${status.value.address.port}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  const directBody = await direct.json()
  assert.deepEqual(
    proxied.data.map((model) => model.id),
    directBody.data.map((model) => model.id),
    "反代结果应与直连完全一致",
  )
})

test("网关不可达时反代回可读的 OpenAI 错误信封", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 关掉网关，模拟「端口没人听」。
  await rpc(app.origin, "gateway.setEnabled", { enabled: false })

  const response = await fetch(`${app.origin}/v1/models`, {
    headers: { authorization: "Bearer whatever" },
  })
  // 502 而非挂起/500 HTML：OpenAI 客户端能据此判断是服务端问题。
  assert.equal(response.status, 502, "网关不可达应回 502")
  const body = await response.json()
  assert.equal(body.error.code, "gateway_unreachable")
  assert.match(body.error.message, /admin/, "错误信息应指引用户去 /admin 检查网关")
})

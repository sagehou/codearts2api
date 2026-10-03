/**
 * 测试用的应用装配辅助：起一个**自包含**的宿主 + HTTP 服务。
 *
 * ## 为什么要动态 import
 *
 * `src/host.js` 在装载时会读环境变量决定 state home（`pinHome()`），而
 * `src/index.js` 更是直接起服务。ESM 的 import 是提升的，所以必须在设置
 * 环境变量**之后**再 `await import(...)` —— 否则测试会污染真实 `~/.dsh`。
 *
 * ## 为什么每个测试用独立的 home 与网关端口
 *
 * 账号池、凭据、网关 API Key 都落在 home 下，共用会让测试互相干扰（且真的
 * 动到用户数据）。网关默认端口 8326 也可能已被占用，故每次随机取一个高位端口。
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * 起一个测试用实例。
 *
 * @param options - `{ home, gatewayEnabled, proxyGateway }`。
 *   `home` 用于「预置好凭据/账号再启动」的用例；省略则新建临时目录。
 * @returns `{ host, server, origin, home, close }`。
 */
export async function startTestApp(options = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "c2a-test-"))
  // ⚠️ 用**本程序自己的**变量：`pinHome()` 会把它写进 `DSH_HOME` /
  //    `DSH_JET_HUB_STATE_DIR`（插件读的那两个），从而与真实 DSH 隔离。
  //    直接设 `DSH_HOME` 是没用的 —— 会被 `pinHome()` 覆盖掉。
  process.env.CODEARTS2API_HOME = home
  // 端口 1..65535 且必须「十进制原文与数值一致」（插件的校验），故取高位随机值。
  process.env.DSH_OPENAI_GATEWAY_PORT = String(20_000 + Math.floor(Math.random() * 20_000))
  if (options.gatewayEnabled === false) process.env.DSH_OPENAI_GATEWAY_ENABLED = "0"
  else delete process.env.DSH_OPENAI_GATEWAY_ENABLED
  // 测试默认开启反代：这样网关相关的断言可以只经一个端口完成，
  // 与容器部署的形态一致（也更接近用户实际会怎么用）。
  process.env.PROXY_GATEWAY = options.proxyGateway === false ? "0" : "1"

  const { createHost } = await import("../src/host.js")
  const { createHttpServer } = await import("../src/server.js")

  const host = await createHost()
  const server = createHttpServer(host, {
    logger: console,
    proxyGateway: options.proxyGateway !== false,
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
    // 端口 0 = 由操作系统分配空闲端口，避免与开发中的实例抢端口。
    server.listen(0, "127.0.0.1")
  })

  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`

  return {
    host,
    server,
    origin,
    home,
    /**
     * 关服务 + 回收插件资源。
     *
     * 必须走 `host.close()`：插件用 `ctx.effect` 注册了续期定时器与
     * zcode 的 captcha 子进程，不收会让 `node --test` 挂住不退出。
     */
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
      await host.close()
    },
  }
}

/**
 * 调一次 Jet Hub RPC（走真实的 HTTP 端点，不经任何内部捷径）。
 *
 * @returns `result` 信封（`{ ok, value }` 或 `{ ok, error }`）。
 */
export async function rpc(origin, method, payload = {}) {
  const response = await fetch(`${origin}/api/jet-hub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `test-${Math.random().toString(36).slice(2)}`,
      method: "jet-hub",
      payload: { method, payload },
    }),
  })
  const body = await response.json()
  return body.result
}

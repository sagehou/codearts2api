/**
 * 进程入口：装配宿主 → 起 HTTP → 优雅退出。
 *
 * ## 启动是两个独立的监听
 *
 * - 本站点（`PORT`）：管理界面 `/admin` 与 Jet Hub RPC；
 * - 插件网关（`DSH_OPENAI_GATEWAY_PORT`）：OpenAI 兼容接口。
 *
 * 网关由插件在 `apply()` 里**自行**根据开关启动，本站点**不**干预它 ——
 * 启停只经 `gateway.setEnabled` 这条 RPC。因此这里只确保本站点起来了，
 * 网关的状态由 `/healthz` 与 `/admin` 反映。
 *
 * ## 退出必须走 close()
 *
 * 插件的 `apply()` 用 `ctx.effect` 注册了若干清理器（续期定时器、
 * zcode 的 captcha 子进程、opencode 的代理连接池、网关的 HTTP server）。
 * 直接 `process.exit()` 会留下孤儿 chromium（数百 MB）与挂住的 socket，
 * 故 SIGINT/SIGTERM 都必须走 `host.close()`。
 */

import { createHost } from './host.js'
import { createHttpServer } from './server.js'

/** 默认管理端口。 */
const DEFAULT_PORT = 8080

/**
 * 解析端口。非法值**显式失败**，不静默换端口
 * （与插件网关对 `DSH_OPENAI_GATEWAY_PORT` 的取舍一致：静默改端口会让
 * 用户按文档配的反代指向空）。
 */
function resolvePort(env = process.env) {
  const raw = env.PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，收到：${raw}`)
  }
  return port
}

/** 监听地址：默认全网卡（容器里必须如此，否则宿主访问不到）。 */
function resolveHost(env = process.env) {
  const raw = env.HOST?.trim()
  return raw === undefined || raw === '' ? '0.0.0.0' : raw
}

/**
 * 是否把 `/v1/*` 反代到插件网关。
 *
 * 默认关闭（本机开发直连 8326 更直观）。容器部署必须开启 —— 插件网关的
 * 监听地址被上游硬编码为 `127.0.0.1`，容器外无法直达，只能经本服务转发。
 * 见 `server.js` 的模块头。
 */
function resolveProxyGateway(env = process.env) {
  const raw = env.PROXY_GATEWAY?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

const host = await createHost()
const port = resolvePort()
const bind = resolveHost()
const proxyGateway = resolveProxyGateway()

const server = createHttpServer(host, { logger: console, proxyGateway })
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.once('listening', resolve)
  server.listen(port, bind)
})

console.log(`[codearts2api] 管理界面 http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/admin`)
console.log(`[codearts2api] state home: ${host.home}`)
console.log(`[codearts2api] 已注册路由: ${[...host.routes.keys()].join(', ') || '（无）'}`)
if (proxyGateway) console.log(`[codearts2api] /v1/* 已反代到本机插件网关`)
else console.log(`[codearts2api] OpenAI 接口请直连插件网关（默认 127.0.0.1:8326，见 /healthz）；如需经本端口访问请设 PROXY_GATEWAY=1`)

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[codearts2api] 收到 ${signal}，正在关闭…`)
  // 兜底强制退出：插件清理里可能有等待网络的部分（如 captcha 子进程回收），
  // 不能让它无限期吊住进程。仍在飞行的请求由 closeAllConnections 收掉。
  const force = setTimeout(() => {
    console.warn('[codearts2api] 关闭超时，强制退出')
    server.closeAllConnections?.()
    process.exit(0)
  }, 10_000)
  force.unref?.()

  await new Promise((resolve) => server.close(() => resolve()))
  try {
    await host.close()
  } catch (error) {
    console.error(`[codearts2api] 插件清理失败：${String(error)}`)
  }
  clearTimeout(force)
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

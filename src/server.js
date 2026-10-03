/**
 * 对外 HTTP 服务：`/admin` 管理界面 + Jet Hub RPC 透传 + 健康检查
 * （+ 可选的 `/v1/*` 网关反代）。
 *
 * ## 两个监听端口
 *
 * - 本服务（`PORT`，默认 8080）：管理界面、`POST /api/jet-hub`；
 * - 插件网关（`DSH_OPENAI_GATEWAY_PORT`，默认 8326）：OpenAI 兼容接口。
 *
 * 网关的监听地址由上游**硬编码**为 `127.0.0.1`（`DEFAULT_GATEWAY_HOST`
 * 不可经环境变量修改 —— 那是上游刻意的安全边界）。于是容器部署时外部
 * 根本连不到 8326，这正是下面反代存在的原因。
 *
 * ## `PROXY_GATEWAY=1` 时的 `/v1/*` 反代
 *
 * 开启后本服务会把 `/v1/*` **透明转发**到插件网关（同进程内的
 * `127.0.0.1:<网关端口>`），于是只需暴露一个端口（8080）就能同时提供
 * 管理界面与 OpenAI 接口 —— 容器部署的关键。
 *
 * ⚠️ 透明转发 = **不碰 Authorization**：客户端仍须带插件网关的 Bearer Key，
 * 反代不注入、不校验、不换钥。这样「谁能用」「用哪个 Key」的判定始终只有
 * 插件网关一处，不会出现两套鉴权。
 *
 * ⚠️ SSE 必须**流式**转发（`Readable.fromWeb(...).pipe(...)`）。若图省事把
 * 上游响应 `await arrayBuffer()` 再回写，流式输出会变成「攒完一次性吐」，
 * 客户端表现为长时间无响应后突然全文出现 —— 那正是 OpenAI 客户端最容易
 * 超时报错的形态。
 *
 * 默认**关闭**：本机开发时直连 8326 更直观，多一跳没有收益。容器里由
 * Dockerfile 显式设为 1。
 */

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"

import { CARRIER_PATH, JET_HUB_PATH, rpcEnvelope } from "./upstream.js"

/** 请求体上限，与插件网关同值（16MB）。 */
const BODY_LIMIT = 16 * 1024 * 1024

/** 网关目标地址的缓存时长：网关可被开关启停，端口可能变，故不能永久缓存。 */
const TARGET_TTL_MS = 5_000

const here = fileURLToPath(new URL(".", import.meta.url))
/** 静态资源目录（`admin.html` 与构建出的 `admin.js`）。 */
const PUBLIC_DIR = join(here, "..", "public")

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { "cache-control": "no-store", ...headers })
  response.end(body)
}

const sendJson = (response, status, value) =>
  send(response, status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
  })

/**
 * 静态文件白名单。
 *
 * 不拼用户输入，故无穿越面；仍收敛到固定几个名字，避免将来越加越多时
 * 引入目录穿越。
 */
const STATIC_FILES = new Map([
  ["/", "admin.html"],
  ["/admin", "admin.html"],
  ["/admin/", "admin.html"],
  ["/admin.js", "admin.js"],
  ["/upstream-jet-hub.js", "upstream-jet-hub.js"],
])

/** 逐跳头：不应转发（由本跳的连接自己决定）。 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** 把 WHATWG Request 所需的请求体读成 Buffer（带上限）。 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error("request body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("error", reject)
    request.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * 把 node 的 req/res 适配成 WHATWG Request。
 *
 * 插件的 handler 是按 Web 标准写的（`request.json()`、`Response.json()`），
 * 而 `node:http` 给的是流式 req/res —— 这里转换一次，让插件代码**原样**
 * 运行，不需要为宿主做任何适配（也就不存在「两边行为漂移」）。
 */
async function toWebRequest(request, url) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request)
  return new Request(url, { method, headers, body, ...(body === undefined ? {} : { duplex: "half" }) })
}

/** 把 WHATWG Response 写回 node res。 */
async function sendWebResponse(response, web) {
  const headers = {}
  web.headers.forEach((value, key) => {
    headers[key] = value
  })
  response.writeHead(web.status, headers)
  response.end(Buffer.from(await web.arrayBuffer()))
}

/**
 * 创建 HTTP 服务。
 *
 * @param host - 插件宿主（`createHost()` 的返回值）。
 * @param options - `{ logger, proxyGateway }`。
 */
export function createHttpServer(host, options = {}) {
  const proxyGateway = options.proxyGateway === true

  /** 网关目标地址的缓存（避免每个请求都多一次本地 RPC）。 */
  let targetCache = { at: 0, host: undefined, port: undefined }

  /**
   * 解析网关当前监听地址。
   *
   * 走**插件公开的 RPC**（而不是读 env 猜端口）：端口被 `gateway.setEnabled`
   * 启停、或 env 改过时，只有插件自己知道真实地址。带 TTL 缓存，失败回退
   * 到 env 默认值，保证「探测偶发失败」不会让反代整体不可用。
   */
  async function resolveGatewayTarget() {
    if (Date.now() - targetCache.at < TARGET_TTL_MS) return targetCache
    let resolved
    const state = await readGatewayState(host).catch(() => null)
    if (state?.address?.port !== undefined) resolved = { host: state.address.host, port: state.address.port }
    else {
      // 网关未运行/读不到：退回 env 默认（请求会失败并给出可读错误）。
      const raw = process.env.DSH_OPENAI_GATEWAY_PORT
      const port = raw === undefined || raw.trim() === "" ? 8326 : Number.parseInt(raw, 10)
      resolved = { host: "127.0.0.1", port: Number.isInteger(port) ? port : 8326 }
    }
    targetCache = { at: Date.now(), ...resolved }
    return targetCache
  }

  /**
   * 透明转发 `/v1/*` 到插件网关。
   *
   * 请求体直接用 node 的 req 流式透传（不缓冲）；响应体流式回写以保住 SSE。
   */
  async function proxyToGateway(request, response, url) {
    const target = await resolveGatewayTarget()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.set(key, value)
    }

    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"

    let upstream
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers,
        // 直接传 req（Readable）：undici 会流式发送，不把 16MB 上限内的请求体
        // 整个读进内存。`duplex: 'half'` 是带流 body 时的必需项。
        body: hasBody ? request : undefined,
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(options.upstreamTimeoutMs ?? 600_000),
      })
    } catch (error) {
      // 网关没起来（被关掉 / 端口冲突 / 启动失败）：回 OpenAI 形态的错误，
      // 让客户端能读懂，而不是一个空连接或 HTML 500。
      options.logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`)
      sendJson(response, 502, {
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
          type: "server_error",
          code: "gateway_unreachable",
        },
      })
      return
    }

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase())) return
      outHeaders[key] = value
    })
    response.writeHead(upstream.status, outHeaders)

    if (upstream.body === null) {
      response.end()
      return
    }
    // 流式回写：SSE 的每一帧立即到达客户端，而不是等整段生成完。
    // 客户端中途断开时销毁上游流，避免上游继续生成白耗额度。
    const stream = Readable.fromWeb(upstream.body)
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy()
    })
    stream.on("error", () => response.destroy())
    stream.pipe(response)
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)
    const path = url.pathname

    try {
      // ── 健康检查 ──
      if (path === "/healthz") {
        const gateway = await readGatewayState(host)
        sendJson(response, 200, {
          ok: true,
          home: host.home,
          routes: [...host.routes.keys()],
          providers: providerIds(host),
          proxyGateway,
          gateway,
        })
        return
      }

      // ── OpenAI 兼容反代（可选）──
      if (proxyGateway && path.startsWith("/v1/")) {
        await proxyToGateway(request, response, url)
        return
      }

      // ── Jet Hub 管理 RPC（透传给插件） ──
      if (path === JET_HUB_PATH) {
        const outcome = await host.handleRpc(JET_HUB_PATH, await toWebRequest(request, url.href))
        if (outcome === undefined) {
          sendJson(response, 404, { error: "Jet Hub 端点未注册" })
          return
        }
        await sendWebResponse(response, outcome)
        return
      }

      // ── zcode 载体页（可选，插件未注册时 404） ──
      if (path === CARRIER_PATH) {
        const outcome = await host.handleRpc(CARRIER_PATH, await toWebRequest(request, url.href))
        if (outcome === undefined) {
          send(response, 404, "载体页未注册")
          return
        }
        await sendWebResponse(response, outcome)
        return
      }

      // ── 静态资源 ──
      const file = STATIC_FILES.get(path)
      if (file !== undefined && (request.method === "GET" || request.method === "HEAD")) {
        const target = join(PUBLIC_DIR, file)
        if (!existsSync(target)) {
          send(response, 503, "管理界面尚未构建：请先执行 npm run build")
          return
        }
        send(response, 200, readFileSync(target), {
          "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        })
        return
      }

      sendJson(response, 404, { error: "not found" })
    } catch (error) {
      // 兜底：任何未捕获异常都必须变成响应，否则连接会挂住、前端表现为「点了没反应」。
      options.logger?.error?.(`[http] ${request.method} ${path} 处理失败：${String(error)}`)
      if (!response.headersSent) sendJson(response, 500, { error: String(error) })
      else response.end()
    }
  })

  return server
}

/**
 * 读网关状态。
 *
 * 同时服务于 `/healthz` 与反代的目标解析，故直接返回**插件原始响应**；
 * 调用方各自裁剪。失败返回 `null`（不影响服务本身）。
 */
async function readGatewayState(host) {
  try {
    const route = host.routes.get(JET_HUB_PATH)
    if (route === undefined) return null
    const web = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope("gateway.getEnabled", {}, "healthz")),
      }),
    )
    const parsed = await web.json()
    const value = parsed?.result?.value
    if (value === undefined) return null
    return {
      enabled: value.enabled,
      running: value.running,
      blockedByEnv: value.blockedByEnv,
      address: value.address,
      modelsSource: value.modelsSource,
      modelCount: Array.isArray(value.models) ? value.models.length : 0,
      // ⚠️ 刻意**不**把 apiKey 明文放进健康检查：它可能被日志、监控或 CDN 记录。
      // 需要 Key 的用户在 /admin 里点「复制」（或走 gateway.getEnabled，那是
      // 显式的用户操作）—— 参见上游对「明文只用于设置页展示」的取舍。
    }
  } catch {
    return null
  }
}

/** 已注册的 llm provider id（读不到就回空数组）。 */
function providerIds(host) {
  try {
    const llm = host.ctx.get("llm")
    const listed = llm?.listProviders?.()
    return Array.isArray(listed) ? listed.map((entry) => entry.id) : []
  } catch {
    return []
  }
}

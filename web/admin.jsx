/**
 * `/admin` 管理界面的**薄入口**。
 *
 * ## 核心思路：直接复用上游打包好的 `JetHubPage`
 *
 * 上游插件的浏览器端产物（`dsh-codearts-auth/client` → `lib/client/jet-hub.js`）
 * 是 esbuild 全量打包的 CJS，**只 external 了 `react` 与 `react-dom`**，并且
 * 以 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 形态发布：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 * ```
 *
 * 它的 `apply(ctx)` 会把整页 UI 组件注册进 `ctx.slots` 的 `settings.section`
 * 槽。于是复用只需三步，**不用重新实现任何界面**：
 *
 * 1. 页面里先定义 `window.__ModuleLoader__.load`，把那一行 `{id, factory}` 截下来；
 * 2. 调 `factory(require)` 拿到模块（`require` 只喂 react / react-dom）；
 * 3. 用一个**桩 ctx** 调它的 `apply()`，从 `slots.register` 里把
 *    `settings.section` 的组件捞出来，再用真实的 `rpcCall` 渲染。
 *
 * 第 3 步的桩 ctx 只需三个成员（`effect` / `slots` / `connection`）—— 这正是
 * 上游客户端的全部宿主依赖面。
 *
 * ## 为什么 UI 更新不需要改这里的代码
 *
 * 界面随上游 bundle 走：升级依赖 commit 后重新 `npm run build` 即可拿到新版
 * 界面。这里的代码只处理「装载 + 接线」，不含任何布局 —— 所以上游改布局
 * 不会被本仓库的拷贝拖住（这是选择复用而非自研的主要理由）。
 */

import * as React from "react"
import { createRoot } from "react-dom/client"
import { createPortal } from "react-dom"

/** 上游 bundle 通过 `__ModuleLoader__` 交出的一行。 */
const captured = globalThis.__JET_HUB_ROW__

/**
 * 上游的 `callManagementRpc(connection, channel, method, payload, signal)` 语义：
 * 以 `{ method, payload }` 的信封 POST 到 `/api/jet-hub`，响应是
 * `{ type:'server-response', rpcId, result }`，其中
 * `result = { ok:true, value }` 或 `{ ok:false, error }`。
 *
 * 这里直接按该协议发请求（等价于上游客户端经 `connection.rpc.call` 走的那条路，
 * 只是省掉 DSH 的中转层）。**必须**与上游 `unwrapRpcResult` 同语义：`ok` 为假
 * 时抛带 `code` 的 Error，因为界面按 `error.code` 与 message 做提示。
 */
async function rpcCall(method, payload, signal) {
  const response = await fetch("/api/jet-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
      method: "jet-hub",
      payload: { method, payload },
    }),
    signal,
  })
  if (!response.ok) throw new Error(`管理接口返回 HTTP ${response.status}`)
  const body = await response.json()
  const result = body?.result
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = new Error(result.error?.message ?? "Jet Hub 请求失败")
    error.code = result.error?.code
    throw error
  }
  throw new Error("管理接口返回了无法识别的响应")
}

/**
 * 从上游 bundle 的行里取出 `JetHubPage` 组件。
 *
 * @returns 组件；任何一步失败都抛出可读错误（而不是白屏）。
 */
function loadUpstreamPage() {
  if (captured === null || typeof captured !== "object" || typeof captured.factory !== "function") {
    throw new Error("上游 jet-hub 客户端 bundle 未先加载（upstream-jet-hub.js 缺失或加载失败）")
  }

  const upstream = captured.factory((name) => {
    if (name === "react") return React
    if (name === "react-dom") return { createPortal }
    throw new Error(`上游 bundle 请求了未预期的模块：${name}`)
  })

  let page = null
  // 桩 ctx：上游客户端的宿主依赖面只有这三个。
  upstream.apply({
    // `apply` 里用 effect 装了全局样式。真 DSH 会传入 disposer 语义的清理器，
    // 这里直接执行：本页面只加载一次，不需要撤销。
    effect: (body) => body(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        if (options?.name === "settings.section") page = component
        return () => {}
      },
    },
    // 上游 apply 只做注册，不会在此时发请求；给一个显式失败的替身，
    // 万一将来上游在 apply 期调用它，能立刻暴露而不是静默拿到 undefined。
    connection: {
      rpc: {
        async call() {
          throw new Error("本宿主不提供 connection.rpc.call，请经 rpcCall 直连 /api/jet-hub")
        },
      },
    },
  })

  if (page === null) throw new Error("上游未注册 settings.section，无法渲染管理界面")
  return page
}

const root = document.getElementById("admin-root")
try {
  const Page = loadUpstreamPage()
  // `close` 传 undefined：上游页头会据此**不渲染**「关闭」按钮
  // （`close ? <button…> : null`），这正合独立页面的形态。
  createRoot(root).render(React.createElement(Page, { rpcCall }))
} catch (error) {
  root.innerHTML = `<pre style="padding:24px;font:13px/1.6 ui-monospace,monospace;color:#b42318;white-space:pre-wrap">管理界面加载失败：${String(error?.message ?? error)}</pre>`
}

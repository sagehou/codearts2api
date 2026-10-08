/**
 * 端到端验证 `/admin` 真的能渲染出来。
 *
 * ## 为什么需要这个测试（而不是只靠 curl）
 *
 * 管理界面是「两个 script + 一个 shim」拼起来的，任何一环错位都**不会**
 * 让 HTTP 返回非 200：断掉只会得到一张白屏。故必须真的把脚本按页面顺序
 * 跑一遍、并断言渲染出了上游的界面结构。
 *
 * 这里用 jsdom 建立一个真正的 DOM，并**按 admin.html 的顺序**执行脚本：
 * ① 定义 `__ModuleLoader__` → ② 上游 bundle → ③ 本项目入口。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { startTestApp } from "./helpers.mjs"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")

/**
 * 在 jsdom 里按页面顺序加载三个文件，返回 window。
 *
 * @param origin - 真实服务地址；页面的 rpcCall 会打到它上面。
 */
function renderAdmin(origin) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="admin-root"></div></body></html>', {
    url: `${origin}/admin`,
    pretendToBeVisual: true,
    // `outside-only` 让我们显式控制执行，不自动跑内联脚本。
    runScripts: "outside-only",
  })
  const { window } = dom

  // 浏览器里 fetch / crypto 都在 window 上；jsdom 不是都提供，从 Node 借过去
  // （admin.js 的 rpcCall 要用 randomUUID）。
  //
  // ⚠️ 必须包一层把**相对 URL 解析成绝对**：浏览器里 `fetch('/api/jet-hub')` 会用
  //    文档地址补全，而 Node 的原生 fetch 遇到相对路径直接抛 `ERR_INVALID_URL`。
  //    不包这一层，页面会在加载账号时抛错（虽然本测试只断言外壳，但那属于
  //    「测试环境不如浏览器真实」，会掩盖真正的问题）。
  window.fetch = (input, init) => {
    const target = typeof input === "string" ? new URL(input, window.location.href).href : input
    return globalThis.fetch(target, init)
  }
  if (typeof window.crypto?.randomUUID !== "function") {
    Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true })
  }

  // ⚠️ 全部用 `window.eval` 执行：这样脚本运行在 **jsdom 自己的 realm** 里，
  //    `globalThis === window` —— 与真实浏览器一致。若改用 Node 的 `new Function`
  //    执行并传参，globalThis 仍是 Node 的，会出现「测试里失败、浏览器里正常」
  //    这类假阴性（本文件第一版就踩了这个坑）。
  const run = (file) => {
    window.eval(readFileSync(join(root, file), "utf8"))
  }

  // 按 admin.html 的顺序：① 定义 loader → ② 上游 bundle → ③ 本项目入口。
  // ⚠️ 第 ① 步不能省：上游 bundle 的第一句就调 `window.__ModuleLoader__.load`，
  //    缺了它直接抛 `Cannot read properties of undefined (reading 'load')`。
  window.eval(`window.__ModuleLoader__ = { load: function (row) { window.__JET_HUB_ROW__ = row; } };`)

  run("public/upstream-jet-hub.js")
  run("public/admin.js")
  return window
}

test("/admin 能渲染出上游 Jet Hub 界面", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const window = renderAdmin(app.origin)
  // React 并发渲染是异步的，且页面挂载后会立刻发几条 RPC，给足时间。
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const rootElement = window.document.getElementById("admin-root")
  const html = rootElement.innerHTML

  // ① 页面外壳渲染出来了（不是白屏、也不是错误提示）。
  assert.match(html, /dim-jh-page/, "应渲染上游 Jet Hub 页面外壳")
  assert.doesNotMatch(html, /管理界面加载失败/, "不应出现加载失败提示")

  // ② 页头与品牌。
  assert.match(html, /Jet Hub/, "页头应显示 Jet Hub")

  // ③ 左侧导航包含 14 个渠道及 aggregate 聚合设置面板。
  const labels = [...rootElement.querySelectorAll(".dim-jh-rail button")].map((button) => button.textContent.trim())
  for (const expected of [
    "CodeArts",
    "CodeBuddy",
    "WorkBuddy",
    "LobsterAI",
    "Qoder",
    "TRAE",
    "Cline",
    "Loomy",
    "Raccoon",
    "MiniMax Code",
    "ZCode",
    "OpenCode",
    "Gemini Code Assist",
    "聚合 (跨渠道)",
  ]) {
    assert.ok(
      labels.some((label) => label.includes(expected)),
      `渠道列表应包含 ${expected}，实际：${labels.join(" / ")}`,
    )
  }
  assert.equal(labels.length, 15, `导航应含 14 个渠道及 1 个聚合面板，实际 ${labels.length}`)

  // ④ 上游样式被注入（installJetHubStyles 走通了 document.head）。
  assert.ok(window.document.head.querySelectorAll("style").length >= 1, "应注入上游样式表")

  // ⑤ 网关入口按钮存在（用户要的「网关开启」入口）。
  assert.match(html, /dim-jh-headerActions/, "页头应有操作按钮区")
})

test("上游 bundle 只请求我们 shim 能提供的模块", () => {
  // 这条断言守住「复用」的前提：`web/admin.jsx` 里的 `captured.factory(require)`
  // 只认 react / react-dom。上游若引入**第三个** external（比如某个 UI 库），
  // factory 会抛「未预期的模块」，界面白屏 —— 那时得同步改 shim。
  //
  // ⚠️ 断言的是**子集**而不是精确集合：上游可以不再需要 react-dom。
  //    实际发生过（2026-10-03 升级）：新版上游把 react-dom 收进内部，
  //    bundle 只剩 `require("react")`，而界面照常渲染 —— 因为**挂载是我们的
  //    入口做的**（`web/admin.jsx` 的 createRoot / createPortal）。
  //    写死 `['react','react-dom']` 会让这种「上游做了减法」的升级误报失败。
  const bundle = readFileSync(join(root, "public/upstream-jet-hub.js"), "utf8")
  const required = [...new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
  const supported = ["react", "react-dom"]
  for (const name of required) {
    assert.ok(
      supported.includes(name),
      `上游 bundle 请求了未预期的模块 "${name}"（它只应请求 ${supported.join(" / ")}）。\n` +
        "这会让 web/admin.jsx 里的 factory(require) 抛错、/admin 白屏；" +
        "请在 web/admin.jsx 的 require 分支里补上它。",
    )
  }
  // 正面确认：至少要有 react，否则 bundle 不是我们认识的那个形态。
  assert.ok(required.includes("react"), `上游 bundle 应请求 react，实际：${required.join(", ")}`)
})

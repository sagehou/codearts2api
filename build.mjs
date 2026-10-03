/**
 * 构建 `/admin` 的前端产物。
 *
 * 产出两个文件到 `public/`：
 *
 * 1. `upstream-jet-hub.js` —— **直接拷贝**上游已打包好的浏览器产物
 *    （`dsh-codearts-auth/client`）。它只 external 了 react/react-dom，
 *    由页面用 script 标签先加载、把 `{id, factory}` 截留下来。
 *    这里刻意不重新打包它：上游 bundle 内部有大量自包含逻辑（图标、
 *    样式、表单），重打包只会引入漂移。
 *
 * 2. `admin.js` —— 本项目的薄入口（`web/admin.jsx`），把 react/react-dom
 *    与入口代码打成一个 IIFE。**不** external react：这是独立页面，
 *    没有宿主注入，必须自带。
 *
 * 注意：入口里**不能**用顶层 await（IIFE 格式不支持），所以上游 bundle
 * 用 script 标签顺序加载，而不是被入口 import 进来。
 */

import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(fileURLToPath(new URL(".", import.meta.url)))
const publicDirectory = join(root, "public")
mkdirSync(publicDirectory, { recursive: true })

// ── ① 拷贝上游浏览器产物 ──
// 用 createRequire 解析 `./client` 子路径导出，拿到上游 package.json 里
// 声明的实际路径（`./lib/client/jet-hub.js`），不硬编码内部布局。
const { createRequire } = await import("node:module")
const require = createRequire(import.meta.url)
const upstreamBundle = require.resolve("dsh-codearts-auth/client")
copyFileSync(upstreamBundle, join(publicDirectory, "upstream-jet-hub.js"))
console.log(`[build] 已拷贝上游客户端产物 → public/upstream-jet-hub.js`)

// ── ② 打包本项目的薄入口 ──
await build({
  entryPoints: [join(root, "web", "admin.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome100"],
  // utf8 而非默认的 ascii：上游 bundle 与我们的文案都是中文，转义成 \uXXXX
  // 会让产物体积翻倍、且无法用文本搜索核对。
  charset: "utf8",
  outfile: join(publicDirectory, "admin.js"),
  // 生产环境下压缩；默认保留可读性，便于「界面上看到什么、产物里就搜得到什么」。
  minify: process.env.NODE_ENV === "production",
  legalComments: "none",
  logLevel: "info",
})

console.log("[build] 完成：public/admin.js 与 public/upstream-jet-hub.js")

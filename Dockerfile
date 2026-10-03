# syntax=docker/dockerfile:1

# 基础镜像要满足两个条件：
# 1. Node ≥ 22.19（上游 `engines` 的下限，也是 `AbortSignal.any` 等 API 的前提）；
# 2. 带 pnpm —— git 依赖的 `prepare` 脚本会执行 `pnpm build:all`。
FROM node:22-slim

# git：npm 要从 gitee 克隆依赖；ca-certificates：TLS 根证书。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── pnpm：显式钉版本 ──
# 上游的 `prepare` 是 `pnpm build:all`，所以装依赖时**必须**有 pnpm 可用。
#
# ⚠️ 不用裸 `corepack enable`：那会让 corepack 用**它自己内置的默认版本**，
#    该默认值随 Node 镜像版本漂移（本仓库开发机上实测拿到 11.25.0，但别的
#    Node 小版本可能不同），构建因此不可复现。这里显式 `prepare --activate`
#    钉住版本，与开发机一致。
#
# ⚠️ 也不在 package.json 里写 `packageManager` 字段：npm 10+ 见到该字段指向
#    非 npm 的包管理器时会**拒绝执行 `npm install`**（提示本项目配置用 pnpm），
#    而本项目的安装走的就是 npm。故只在镜像里钉 pnpm。
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate \
  && pnpm --version

WORKDIR /app

# ── 依赖层：先只拷清单，让这一层能被缓存 ──
# ⚠️ 这里必须装到 devDependencies（默认行为，**不要**加 `--omit=dev`）：
#    前端 `public/admin.js` 由 esbuild + react 在镜像构建期产出，
#    而 `npm run build` 需要 esbuild 的二进制与 react 的源码作为**输入**。
#    （产出物自带 React 运行时，运行期**不需要** react —— 见 README。）
#
# ⚠️ 显式 `--include=dev` 不是多余的：若构建环境带着 `NODE_ENV=production`
#    （CI/平台常这么设），npm 会**默认跳过** devDependencies，于是 esbuild 与
#    react 装不上、`npm run build` 直接失败。显式写出来让这一层对
#    `NODE_ENV` 免疫（已实测：production 下不加这个参数就装不到 esbuild）。
#
# ⚠️ 上游插件同样是运行期依赖，它的 prepare 要跑 tsc。
#
# 💡 `sharp`（附件服务用来校验/缩放图片）是**原生包**，靠 optionalDependencies
#    分发平台二进制。lockfile 里已含 linux-x64 / linuxmusl-x64 等全部平台条目，
#    故 Debian 基底能直接装上，不需要额外 apt 依赖（预编译包自带 libvips）。
COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

# ── 源码与前端构建 ──
COPY . .
# public/admin.js 是构建产物，不入库；每次镜像构建都重生成，
# 保证前端与所锁定的上游 commit 一致。
RUN npm run build

# ── 运行 ──
# 本程序自己的状态目录（账号池、凭据、网关 API Key 都在这下面），
# 挂卷即可持久化；不挂则容器重启后账号会丢。
# ⚠️ 用 CODEARTS2API_HOME 而不是 DSH_HOME：后者是 DSH 的变量，本程序启动时
#    会把它覆盖成自己的目录，写在这里容易误导（也不生效）。
ENV CODEARTS2API_HOME=/data
ENV PORT=8080
# 插件网关的**监听地址**被上游硬编码为 127.0.0.1（不可经 env 改），所以容器外
# 无法直达它 —— 必须让本服务把 /v1/* 转发进来。开启后对外只需一个端口。
ENV PROXY_GATEWAY=1
# 网关仍是本机回环上的独立端口（由插件自己监听），仅容器内部使用。
ENV DSH_OPENAI_GATEWAY_PORT=8326

VOLUME ["/data"]
# 8080：管理界面 /admin 与 OpenAI 兼容接口 /v1/*（经反代）。
# 8326 不需要对外暴露。
EXPOSE 8080

CMD ["node", "src/index.js"]

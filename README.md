# codearts2api

把 [`deepseek-harness-codearts`](https://gitee.com/iJetLi/deepseek-harness-codearts)
的 **Jet Hub 多渠道账号管理** 与 **本机 OpenAI 网关** 搬到独立后端运行，
**不依赖 DSH 宿主**，用于后端 / 容器部署。

- `/admin` —— 上游 Jet Hub 设置页（**原样复用**，13 个渠道的增删改查 + 网关开关）
- `POST /api/jet-hub` —— Jet Hub 管理 RPC（上游实现的透传）
- `/v1/models`、`/v1/chat/completions` —— OpenAI 兼容接口（上游网关）

## 它是怎么做到的

上游插件本身就是一个 **cordis 插件**，入口是 `apply(ctx)`，宿主依赖面只有四个服务。
本项目提供这四个服务后即可直接 `ctx.plugin()` 装载它 —— **不 fork、不改上游代码**：

| 服务 | 本项目怎么做 | 为什么 |
| --- | --- | --- |
| `credentials` | **复用官方** `@deepseek-ai/dsh-credentials-local` | 写 `<home>/.credentials.yaml`；自己实现会重担格式/权限/原子写/锁，任何一处偏差都表现为**静默读不到凭据** |
| `commands` | 空对象 | 插件把它列在 `inject` 里但代码零调用；缺了会永久 pending |
| `connection` | 自实现注册表（`src/connection.js`） | Jet Hub 管理端点经此接入，请求原样透传 |
| `llm` | **真实** `@deepseek-ai/dsh-llm` 的 `LlmRuntime` | 网关与各渠道适配器都通过它发请求，不能替身 |

> ⚠️ 凭据服务**必须走 `ctx.plugin()`**，不能 `new LocalCredentialProvider(...)`：
> 载入既有凭据的逻辑在它的 `[Service.init]` 生成器里，只有被 cordis 作为插件
> 装载时才会执行。手动 `new` 出来的实例**不会读磁盘上的既有凭据**，且不报任何错
> —— 症状同样是「凭据未配置」（已实测）。

管理界面同理：上游的浏览器产物（`dsh-codearts-auth/client`）只 external 了
`react` / `react-dom`，本项目用**两个 script 标签 + 一个桩 ctx** 把它的
`JetHubPage` 组件捞出来直接渲染（见 `web/admin.jsx`）。因此**界面随上游走**，
本仓库不含任何布局代码，上游改版后重新 `npm run build` 即可。

## 快速开始

```bash
npm install          # 需要 pnpm 在 PATH 上（见下）
npm run build        # 生成 public/admin.js 与 public/upstream-jet-hub.js
npm start            # 默认 http://127.0.0.1:8080/admin
```

> ⚠️ `npm install` 会从 gitee 拉取上游并执行它的 `prepare`（`pnpm build:all`），
> 因为上游的 `lib/` **不入库**、必须现场编译。所以**先确保 pnpm 可用**：
> `corepack enable`（Node 自带）或 `npm i -g pnpm`。装不上时最典型的报错是
> `pnpm: command not found`。

打开 <http://127.0.0.1:8080/admin> 即可看到与 DSH 里一致的 Jet Hub 界面。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEARTS2API_HOME` | `~/.codearts2api` | **本程序自己的状态目录**：账号池、凭据、网关 Key 全在这里 |
| `PORT` | `8080` | 本服务端口（管理界面 + RPC + 可选反代） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PROXY_GATEWAY` | 关 | 置 `1` 时把 `/v1/*` 反代到插件网关（**容器部署必须开**） |
| `DSH_OPENAI_GATEWAY_PORT` | `8326` | 插件网关端口（只绑 `127.0.0.1`，见下） |
| `DSH_OPENAI_GATEWAY_ENABLED` | `1` | 置 `0/false/off/no` 则**强制停用**网关（面板开关会显示被 env 阻止，且无法再打开） |
| `DSH_OPENAI_GATEWAY_API_KEY` | 自动生成 | 网关 Bearer Key，优先于文件 |
| `LOG_LEVEL` | `info` | `silent` / `error` / `info` / `debug` |

### 状态目录：本程序独立，不跟随 DSH

本程序是**独立网关**，状态全放在自己的目录（默认 `~/.codearts2api`），
**不读写** `~/.dsh`。启动时会把 `DSH_HOME` 与 `DSH_JET_HUB_STATE_DIR` 两个
环境变量**覆盖**成这个目录（插件内部所有落盘点都读它们，这是让插件待在自家
目录的唯一办法），因此外层 shell 里已有的 `DSH_HOME`（DSH 自己导出的）不会
把我们的数据带进 DSH 的目录。

> ⚠️ 早期版本沿用了插件的判据（`DSH_HOME` → `~/.dsh`），于是在装过 DSH 的
> 机器上会把账号写进 `~/.dsh`，与 DSH 抢同一份状态 —— 且当时凭据文件名写的
> 是 `jet-hub/credentials.json`（臆造格式），而真实 DSH 用
> `.credentials.yaml`，于是界面一直提示「凭据未配置」。现已修正。

### 从已有的 DSH / 旧版本搬账号

新版本启动时用的是**空目录**，所以第一次跑起来看不到原有账号。两种搬法：

**方式 A：直接拷文件（推荐，最快）**

本程序的存储格式与 DSH **完全一致**（`jet-hub/state.json` + `.credentials.yaml`），
所以直接把两个文件拷过去即可（已实测：账号与凭据全部可读）：

```bash
mkdir -p ~/.codearts2api/jet-hub
cp ~/.dsh/jet-hub/state.json       ~/.codearts2api/jet-hub/state.json
cp ~/.dsh/.credentials.yaml        ~/.codearts2api/.credentials.yaml
chmod 600 ~/.codearts2api/.credentials.yaml      # 权限校验要求，否则启动即报错
```

> ⚠️ 别整目录拷：`~/.dsh` 里还有 DSH 自己的缓存与 records 段，只需上面两个文件。

**方式 B：走界面备份**

用 `/admin` 的「备份」导出 → 在目标实例「恢复」导入（自包含 JSON，凭据一并带走）。

> ⚠️ 无论哪种，**不要再让两个程序共用同一个目录**：它们对同一份状态各有假设，
> 互相覆盖时很难排查。

## 依赖怎么分：为什么 react 在 devDependencies

一个常见疑问：**界面要用 react，为什么它不算运行期依赖？**

因为 `/admin` 用的是**构建期打包**：`npm run build` 时 esbuild 把 react /
react-dom 与页面代码**一起打进 `public/admin.js`**（约 1.2MB，自带 React
运行时、无任何外部 `require`）。运行期（`node src/index.js`）**不加载
react**，只是把这份静态文件发给浏览器。

据此划分：

| 包 | 分类 | 谁在用 |
| --- | --- | --- |
| `@deepseek-ai/cordis`、`dsh-llm`、`dsh-credentials`、`dsh-credentials-local`、`dsh-codearts-auth` | `dependencies` | **服务器进程运行期**真正 `import` |
| `esbuild` | `devDependencies` | 只在 `npm run build` 时运行 |
| `react`、`react-dom` | `devDependencies` | 只在构建期作为**输入**被 esbuild 读取；产物已内联 |
| `jsdom` | `devDependencies` | 只在 `npm test` 里模拟浏览器 DOM |

> ⚠️ 唯一的坑：`npm run build` **需要** devDependencies。若构建环境里设了
> `NODE_ENV=production`，`npm install` 会默认跳过它们，构建直接失败。
> 故 Dockerfile 里显式写了 `npm install --include=dev`。

## 拿到网关地址与密钥

1. 打开 `/admin` → 页头 **「网关」** 按钮 → 显示实际监听地址、可复制 API Key、模型清单。
2. 或命令行：

```bash
KEY=$(curl -s -X POST http://127.0.0.1:8080/api/jet-hub \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"jet-hub","payload":{"method":"gateway.getEnabled","payload":{}}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['value']['apiKey']['value'])")
echo "$KEY"
```

模型 ID 形如 `provider/模型名`（如 `codearts/deepseek-v4.1-flash`、
`opencode/big-pickle`），**必须带渠道前缀**。

## 部署

### 方式一：本机直跑

```bash
PROXY_GATEWAY=1 PORT=8080 CODEARTS2API_HOME=/var/lib/codearts2api node src/index.js
```

此时一个端口同时提供 `/admin` 与 `/v1/*`，可直接挂反代（nginx/caddy）。

### 方式二：Docker

```bash
docker build -t codearts2api .
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  codearts2api
```

`CODEARTS2API_HOME=/data` 已由镜像设好并声明为 `VOLUME`；**不挂卷则容器重建后账号会丢**。

### 为什么容器里必须开 `PROXY_GATEWAY`

插件网关的监听地址在上游是**硬编码**的 `127.0.0.1`（`DEFAULT_GATEWAY_HOST`
不可经环境变量修改 —— 那是上游刻意的安全边界，避免被误暴露成公网服务）。
所以容器外**无法**直接访问 `8326`。开启 `PROXY_GATEWAY=1` 后，本服务把
`/v1/*` 透明转发到回环上的网关，于是对外只需暴露 8080。

反代**不碰 `Authorization`**：客户端仍须带网关的 Bearer Key，鉴权判定权始终
只在插件网关一处，不存在两套鉴权。

### nginx 参考（方式一直跑时）

```nginx
server {
  listen 443 ssl;
  server_name your-host;

  # 管理界面：建议加一层访问控制（本项目默认不带鉴权，见下）
  location / {
    proxy_pass http://127.0.0.1:8080;
  }

  # OpenAI 兼容接口：流式，必须关闭缓冲
  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;          # 否则 SSE 被攒起来再吐，客户端会超时
    proxy_read_timeout 600s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
  }
}
```

## ⚠️ 安全边界（务必先读）

1. **`/admin` 没有鉴权**（按需求如此）。它能看到并操作你的全部账号凭据，
   也会**明文回传网关 API Key**。**绝不要**把它直接暴露在公网 ——
   请在反代上加 Basic Auth / OAuth / IP 白名单。
2. **网关密钥**以明文存在 `<CODEARTS2API_HOME>/openai-gateway/api-key`（`0600`）。
   文件被改坏时上游会**明确报错**而不是悄悄换一个 —— 因为静默换钥会让所有
   已配置的客户端同时 401。恢复办法：删掉该文件重启（会重建），或改用
   `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。
3. **`/healthz` 刻意不含密钥**（只回开关、地址、模型数），可以安全地给监控用。

## ⚠️ 登录流程：远程部署需要一条 SSH 隧道

上游所有**回调式**登录（CodeArts / LobsterAI / TRAE / Loomy / Raccoon）都
硬编码绑 `127.0.0.1`，端口随机且必须 ≥10000（真实插件的要求）。因此在**远程
服务器**上部署时，浏览器授权后的回调会打到**你本机**，而不是服务器 ——
服务器上的登录流程会一直等不到回调。

**可行工作流**（不影响设备码类的渠道）：

1. 在 `/admin` 点「+ 新建账号」，把返回的 `loginUrl` 复制出来，
   读出其中的端口（形如 `...:19283/...`）；
2. 在**你本机**执行隧道：`ssh -L 19283:127.0.0.1:19283 user@your-server`
3. 再打开那个 `loginUrl` 完成授权。

**不受影响**的渠道（无需隧道）：`qoder` / `qodercn` / `cline`（设备码轮询）、
`buddy` / `workbuddy`（轮询）、`opencode`（可直接粘贴 `sk-` key）。
**远程部署的务实替代方案**：在本地机器登录好，然后用 `/admin` 的
**「备份」导出 → 在服务器上「恢复」导入**，账号与凭据一并搬过去。

> ⚠️ **导入备份是「整体替换」，不是合并**。若导出的那份备份里没有 OpenCode 的
> 匿名通道条目，导入后它会消失、`/v1/models` 随之变空（模型数 0）。
> **重启一次即可恢复**（插件启动时会自动补一条匿名通道）。
> 搬账号时如果想保留本机的 OpenCode 通道，就先在本机也加上它再导出。

## 已知边界

- **图片输入不可用**：网关需要宿主的附件服务（`ctx.attachments.saveImage`）把
  客户端 base64 落成附件。本项目未提供该服务，故收到图片会**明确报错**
  （「未装载附件服务」）而**不是静默丢图**。文本 / 工具调用 / 推理 / 流式全部正常。
- **网关关闭后**：`/v1/*` 会回 `502 gateway_unreachable` 并提示去 `/admin` 检查，
  而不是挂起或回 HTML 错误页。
- **`DSH_OPENAI_GATEWAY_ENABLED=0` 时**面板开关会被禁用并提示「已被环境变量停用」
  —— 这是上游的优先级设计（env > 面板），不是开关坏了。
- **端口冲突**（8326 被占用）：网关只记日志、跳过启动，不影响 `/admin`。

## 测试

```bash
npm test
```

覆盖：宿主装配（13 个 provider 注册、端点挂载）、`/admin` 真实渲染、
账号增删改查、备份往返、网关启停（含端口真实释放）、模型 / 供应商开关、
`/v1/*` 反代（含鉴权不被绕过与网关不可达时的错误信封）、SSE 流式。

## 目录结构

```
src/
  index.js        进程入口：装配 → 监听 → 优雅退出
  host.js         宿主装配（四个 seam + 装载插件）★核心
  （凭据用官方 @deepseek-ai/dsh-credentials-local，无自实现文件）
  connection.js   connection seam（管理端点注册表）
  server.js       HTTP：/admin、/api/jet-hub、/v1/* 反代、/healthz
  home.js         state home 解析（**自己的目录**，与 DSH 隔离）
  logger.js       cordis 日志 → stdout/stderr
  upstream.js     ★ 对上游的全部假设（契约常量 + RPC 信封），升级时只看这里
web/admin.jsx     /admin 的薄入口（复用上游 JetHubPage）
public/admin.html 页面外壳（两个 script + loader shim）
build.mjs         前端构建（拷贝上游产物 + 打包入口）
```

## 升级上游：照这个步骤做

依赖锁在某个 commit 上。下面是**实测验证过**的完整流程（含一个必须避开的坑）。

### 第 1 步：查上游最新 commit

上游仓库：<https://gitee.com/iJetLi/deepseek-harness-codearts>

```bash
git ls-remote https://gitee.com/iJetLi/deepseek-harness-codearts.git refs/heads/master
# 输出形如：6fc1f61523df915166dae20922d05689ae7eccba  refs/heads/master
#            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 这就是要用的 commit
```

如果你本地有 clone，也可以：

```bash
cd /path/to/deepseek-harness-codearts
git fetch origin && git log --oneline -5 origin/master          # 看新提交
git log --oneline <当前锁的commit>..origin/master               # 看这次更新了什么
git diff --stat <当前锁的commit>..origin/master -- src/ | tail  # 看改了哪些文件
```

### 第 2 步：更新依赖（⚠️ 这步有坑，别只改 package.json）

```bash
NEW=<第 1 步拿到的 commit>

npm install "dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git#$NEW" \
  --include=dev --no-audit --no-fund
```

> ⚠️ **必须用上面的写法（带包名与 `@` spec），不能只改 `package.json` 再 `npm install`。**
> 实测过：`package-lock.json` 里记着旧 commit 的 `resolved`，只改 `package.json`
> 的话普通 `npm install` 会**静默沿用 lock 里的旧 commit**（输出只说 `added 1 package`，
> 不报错），你以为升级了其实没有。上面的写法会让 npm 同时更新
> `package.json` 与 `package-lock.json`。
>
> 若已经踩坑，两个文件都改成新 commit 后 `rm -rf node_modules/dsh-codearts-auth && npm install`。
> 升级后务必核对一次：
>
> ```bash
> node -e "console.log(require('./package-lock.json').packages['node_modules/dsh-codearts-auth'].resolved)"
> # 末尾应是新 commit
> ```

`npm install` 会重新 clone 上游并跑它的 `prepare`（`pnpm build:all`）现场编译
`lib/` —— 所以**要确保 pnpm 可用**（`corepack enable`）。

### 第 3 步：重建前端产物（必做）

界面的 JS 是**上游产物的拷贝**，不重建就还是旧界面：

```bash
npm run build
```

### 第 4 步：测试

```bash
npm test
```

按失败信息分两种处理：

| 失败的是 | 说明 | 怎么办 |
| --- | --- | --- |
| `host.test.mjs` 的「13 个渠道」 | 上游**新增了渠道** | 打开 `tests/host.test.mjs`，把新渠道 id 加进 `EXPECTED_PROVIDERS` 数组（只改测试） |
| `admin-ui.test.mjs` 的「只 external react/react-dom」 | 上游客户端产物多了一个外部依赖 | 复用方式要调：见 `web/admin.jsx` 里 `captured.factory()` 的 `require` 分支 |
| `home-isolation.test.mjs` | 存储格式/隔离被改坏了 | 看具体断言，通常与 `src/home.js` 或凭据服务有关 |
| 其它 | 契约漂移 | 对照 `src/upstream.js` 顶部契约表 |

### 第 5 步：启动确认契约（关键一步）

```bash
npm start
```

启动日志里必须有这一行：

```
[codearts2api] 上游契约核对通过：/api/jet-hub, /api/jet-hub/captcha-carrier
```

**没有这行、或直接抛错**，就说明上游改了端点路径或装配方式 —— 错误信息会
告诉你去 `src/upstream.js` 改哪个常量：

```
上游插件未注册预期的管理端点 /api/jet-hub（实际注册：…）。
这通常意味着上游改了端点路径或装配方式 —— 请对照 src/upstream.js 顶部的契约表…
```

### 第 6 步：真机点一下（建议）

```bash
# 打开 http://127.0.0.1:8080/admin
# 1. 左侧 13 个渠道都在
# 2. 账号列表能读出 source（不是「凭据未配置」）
# 3. 点页头「网关」→ 开关能开关、能复制 Key
```

### 万一升级后出问题：回滚

```bash
npm install "dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git#<旧commit>" --include=dev
npm run build && npm test
```

> 💡 升级只会改 `package.json` / `package-lock.json` / `public/*.js`（产物）。
> **你的账号数据在 `~/.codearts2api`，与升级无关**。升级前想稳妥可以
> 在 `/admin` 里「备份」导出一份。

### 实测记录：一次真实的升级（2026-10-03）

写这份文档时正好上游有新版，于是**完整走了一遍上面的 6 步**（用来验证步骤本身可用）。

从 `784210d` 升到 `6fc1f61`（上游新增 zcode 双通道支持，改了
`jet-hub-rpc.ts` / `zcode-*.ts` / 客户端 `jet-hub.js` 共 19 个文件）：

| 步骤 | 结果 |
| --- | --- |
| 契约核对（路径 / 端点名 / inject） | **未变**，无需改动 |
| 代码改动 | **0 行** |
| `npm test` | 16/16 通过 |
| 启动 | 契约核对通过，13 个渠道，界面正常渲染 |
| 回滚命令 | 也验证过可用 |

> ℹ️ 本次演练后**已还原**到项目原本锁定的 `784210d`（本次只交付文档，
> 不替你决定升级）。要升到 `6fc1f61` 按上面步骤做即可。

### 当前锁定的版本

```bash
node -e "console.log(require('./package.json').dependencies['dsh-codearts-auth'])"
```

## 升级时需要改多少代码

我们与上游的**代码**耦合只有一处：

```js
import * as plugin from 'dsh-codearts-auth'   // src/host.js 唯一的一行
```

其余全靠 cordis 的注入机制与 HTTP 转发。因此上游常见的改动类型
（新增渠道、修协议、改额度逻辑、加模型、改 UI 布局）**都不需要动本仓库**：

| 上游改了什么 | 我们要改 | 为什么 |
| --- | --- | --- |
| 新增一个渠道（provider） | **0 行**（仅测试期望列表） | 我们不含任何渠道名单，界面与 `provider.status` 都是动态的 |
| 改某个渠道的协议/登录 | **0 行** | 逻辑全在上游 |
| 改界面布局 / 样式 | **0 行**（只需 `npm run build`） | 界面是上游产物的原样复用 |
| 改网关行为（/v1/*） | **0 行** | 网关是上游的，我们只转发 |
| 加 RPC 方法 | **0 行** | 我们的转发是通用透传，不枚举方法 |
| **改管理端点路径** | 1 个常量 | `src/upstream.js` |
| **改 RPC 信封 / 线协议** | 1 个函数 | `src/upstream.js` 的 `rpcEnvelope()` |
| **改客户端 loader 形态** | 可能 1~2 处 | `public/admin.html` + `web/admin.jsx` |
| **改 slot 名 `settings.section`** | 1 个常量 | `src/upstream.js` |
| **改插件 `inject` 列表** | `src/host.js` 的 provide | 少了服务插件会永久 pending |


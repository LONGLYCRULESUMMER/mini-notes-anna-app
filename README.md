# Mini Notes with LLM Summary — Anna App

一个完全基于 **Anna 本地开发模型**的 Mini Notes 应用：

- 笔记的创建 / 查看 / 删除全部通过 **Anna storage Host API**（`anna.storage.get` / `anna.storage.set`）持久化，不使用 localStorage / IndexedDB / 自建后端。
- 点击 **Summarize** 时，前端通过 **`anna.tools.invoke`** 调用本地 **Executa Tool**（Go 实现，JSON-RPC 2.0 over stdio）；Tool 内部发起 **reverse JSON-RPC `sampling/createMessage`** 向 host LLM（或本地 mock fixture）请求总结，并把结果返回 UI。
- summary **只来自 sampling 返回结果** —— 前端和 Tool 中都没有任何本地规则拼接。

核心链路：

```text
Anna App iframe
  -> AnnaAppRuntime.connect()
  -> anna.storage.get / anna.storage.set   （保存 / 读取 notes）
  -> anna.tools.invoke({tool_id, method:"summarize", args})
  -> 本地 Executa Tool 的 invoke（JSON-RPC over stdio）
  -> reverse JSON-RPC sampling/createMessage
  -> host LLM 或 --mock-sampling fixture
  -> summary 返回 UI 展示
```

---

## 项目结构

```
mini-notes-anna-app/
├── manifest.json                 # Anna App manifest（schema 2：permissions、required_executas、ui.*、dev）
├── index.html                    # Vite 入口（构建后进入 bundle/）
├── vite.config.ts                # 构建到 bundle/，SDK 保持 external 绝对路径导入
├── src/                          # 工程化前端源码（TypeScript）
│   ├── main.ts                   #   UI 逻辑 / 事件绑定 / 渲染
│   ├── anna.ts                   #   AnnaAppRuntime.connect() 封装
│   ├── notesStore.ts             #   笔记仓库 —— 只经 anna.storage.get/set 读写
│   ├── summarize.ts              #   anna.tools.invoke 调用封装
│   ├── config.ts                 #   TOOL_ID / STORAGE_KEY 常量（单一事实来源）
│   ├── style.css
│   └── sdk.d.ts                  #   host SDK 的类型声明
├── executas/
│   └── notes-summarizer/         # 本地 Executa Tool（Go，无第三方依赖）
│       ├── executa.json          #   {tool_id, type:"go"} —— anna-app dev 自动发现
│       ├── go.mod
│       └── main.go               #   initialize/describe/invoke/health/shutdown + reverse sampling
├── fixtures/
│   └── mock-sampling.jsonl       # anna-app executa dev --mock-sampling 用的 fixture
├── scripts/
│   ├── rpc-smoke.mjs             # 手动协议测试：伪 host 驱动 initialize/describe/invoke + 应答 sampling
│   └── build-binary.sh           # 本机（或 --all 全平台）二进制打包脚本
├── .github/workflows/release.yml # 三平台 Release assets 发布 workflow
└── bundle/                       # `npm run build` 生成的静态 bundle（不入库）
```

**Tool 身份一致性**：`tool-dev-mini-notes-summarizer` 在以下四处严格一致（改动时四处同改）：

1. `manifest.json` → `required_executas[].tool_id`
2. `manifest.json` → `ui.host_api.tools`（`required:<tool_id>`）
3. `executas/notes-summarizer/executa.json` → `tool_id`（`describe` 返回的 manifest `name` 同值）
4. `src/config.ts` → `TOOL_ID`（前端 `tools.invoke` 使用）

---

## 安装依赖

前置：Node 22+、Go 1.22+、[uv](https://docs.astral.sh/uv/)（`anna-app dev` 用它拉起本地 runtime bridge）。

```bash
npm install        # 安装 vite / typescript / @anna-ai/cli（提供 anna-app 命令）
```

无需 `anna-app login`、无需真实 LLM API key、无需云端数据库。

## 构建前端 bundle

```bash
npm run build      # vite build → bundle/（manifest ui.bundle.entry 指向 bundle/index.html）
```

SDK 以 `/static/anna-apps/_sdk/latest/index.js` 绝对路径 external 导入，由 host（本地 harness 或生产）在 iframe 同源下提供，构建时不打进 bundle。

## 校验 manifest

```bash
npm run validate   # → anna-app validate --strict
```

## 启动 UI harness（`anna-app dev --no-llm`）

```bash
npm run dev        # → anna-app dev --no-llm
# 或先构建再启动：
npm run dev:harness
```

打开输出的 dashboard 地址（默认 `http://localhost:5180/`），右侧是 RPC LOG：

1. **创建笔记**：输入文字点「添加」——空输入不可保存，保存后输入框清空，笔记带序号与时间戳。
2. **删除笔记**：点「删除」，列表立即更新。
3. **Summarize**：点击后前端照常发起 `anna.tools.invoke`。

### 为什么 `--no-llm` 下 Summarize 预期报 `[-32603] harness started with --no-llm`

UI harness（`anna-app dev --no-llm`）只用于验证 **App ↔ storage ↔ tools.invoke 的 wiring**。Tool 收到 invoke 后会发起 reverse `sampling/createMessage`，本地 bridge 把它代理到 harness 的 LLM 通道；由于 harness 以 `--no-llm` 启动，该通道被禁用，于是错误 `[-32603] harness started with --no-llm` 沿着 Tool → tools.invoke → UI 一路返回并显示在错误横幅里。

**这是 App 调试路径的预期结果**，恰好证明了 UI → `tools.invoke` → Executa → `sampling/createMessage` 的链路真实发生，**不代表后端 Tool 的 sampling 实现有问题**。后端 sampling 用下一节的 `--mock-sampling` 单独验证（两条路径按题目要求分开测试，不在 UI harness 中用 fixture 伪造最终 summary）。

## 单独测试后端 Executa sampling（`--mock-sampling`）

```bash
npm run executa:mock
# → anna-app executa dev --dir executas/notes-summarizer \
#     --mock-sampling fixtures/mock-sampling.jsonl \
#     --invoke summarize --args '{"notes":["明天跟客户 follow up","修复登录 bug","Workshop 内容想法"]}'
```

预期输出（截取）：

```
[executa] [mini-notes-summarizer] initialize: negotiated protocol v2, declaring sampling capability
  ✓ negotiated protocol 2.0
[executa] [mini-notes-summarizer] → reverse RPC sampling/createMessage id=…
[executa] [mini-notes-summarizer] ← sampling result id=… model=mock-model
{
  "data": {
    "summary": "(mock via sampling/createMessage) 今日待办：跟进客户、修复登录 bug，并整理 Workshop 内容想法。",
    "model": "mock-model",
    ...
  },
  "success": true
}
```

### 如何确认 `sampling/createMessage` 确实被 Tool 发起过（证据）

- **stderr 日志**：Tool 每次发起 reverse RPC 都会输出 `→ reverse RPC sampling/createMessage id=…`，收到应答输出 `← sampling result id=… model=…`（日志只写 stderr，stdout 仅 JSON-RPC 帧）。
- **summary 内容自证**：fixture 里的文本带 `(mock via sampling/createMessage)` 前缀，Tool 与前端均无该字符串 —— 返回它只可能来自 sampling 应答（`grep -r "mock via" src/ executas/` 可验证无硬编码）。
- **审计字段**：Tool 在 sampling 请求 `metadata.executa_invoke_id` 中携带当前 `invoke_id`，并在 invoke 结果 `data.invoke_id` 中回显，便于关联审计。
- **协议级证据**：`npm run test:rpc`（下节）里的伪 host 会拦截 Tool 发出的 `sampling/createMessage` 原始帧并断言其 messages / metadata。

交互式 REPL：`npm run executa:repl`（`describe` / `invoke summarize {...}` / `quit`）。

## 手动测试 Executa JSON-RPC（initialize / describe / invoke）

**方式一 —— 自动断言（推荐）：**

```bash
npm run test:rpc   # → node scripts/rpc-smoke.mjs
```

脚本以伪 host 身份 spawn Tool（`go run .`），依次驱动 `initialize`（断言 v2 + sampling capability）、`describe`（断言 name / display_name / version / description / host_capabilities / tools[].parameters[] / runtime）、`health`、`invoke summarize`（拦截并应答 reverse sampling，断言 summary 与注入文本完全一致）、`shutdown`。全部通过退出码为 0。对已构建的二进制测试：`RPC_SMOKE_BIN=dist/stage/<platform>/bin/tool-dev-mini-notes-summarizer npm run test:rpc`。

**方式二 —— 纯手工管道：**

```bash
cd executas/notes-summarizer
go run . <<'EOF' 2>/dev/null
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2.0","capabilities":{"sampling":{}}}}
{"jsonrpc":"2.0","id":2,"method":"describe"}
{"jsonrpc":"2.0","id":3,"method":"health"}
EOF
```

（手工管道下 `invoke summarize` 会阻塞等待 sampling 应答直至超时 —— 这正是「summary 只能来自 sampling」的体现；带 invoke 的完整手测请用方式一或 `--mock-sampling`。）

## 如何确认 notes 存储走的是 `anna.storage.*`

1. **RPC LOG（运行时证据）**：`anna-app dev --no-llm` dashboard 右侧日志中，App 启动即出现 `→ req storage.get {"key":"mini-notes/v1"}`；每次添加 / 删除出现 `→ req storage.set {"key":"mini-notes/v1","value":{…}}` 及 `← res ok`。
2. **代码证据**：[src/notesStore.ts](src/notesStore.ts) 是唯一的笔记读写入口，只调用 `this.anna.storage.get/set`；`grep -rn "localStorage\|indexedDB" src/` 无业务命中（仅注释说明不使用）。
3. **录制证据**：dashboard 右上角「⏺ record」可把会话录成 `fixtures/*.jsonl`，用 `npx anna-app fixture verify/summarize <file>` 检查 storage 调用计数。

本地无 login 时 harness 使用 **legacy in-memory `runtime_state`** 后端（启动日志 `storage backend legacy (in-memory runtime_state)`），仅用于验证 `get`/`set` 调用语义；刷新外层 dashboard 或重启 dev 后数据不保留，属预期。

## 如何确认 summary 走的是 `tools.invoke → Executa → sampling/createMessage`

1. UI harness 中点 Summarize：RPC LOG 出现 `→ req tools.invoke {"tool_id":"tool-dev-mini-notes-summarizer","method":"summarize","args":{"notes":[…]}}`，且 `--no-llm` 下返回 `[-32603] harness started with --no-llm`（sampling 通道被禁用的直接证据）。
2. `npm run executa:mock`：stderr 出现 reverse RPC 日志，且 summary 文本 == fixture 文本。
3. `npm run test:rpc`：协议级断言 Tool 发出了 `sampling/createMessage` 帧且 summary 与伪 host 注入一致。
4. 反向验证：前端不调用 `anna.llm.complete`、不 fetch 任何自建 HTTP API（`grep -rn "llm.complete\|fetch(" src/`）。

## 本机二进制打包

```bash
npm run package:binary        # → bash scripts/build-binary.sh（自动识别本机 os/arch）
bash scripts/build-binary.sh --all   # 交叉编译全部平台
```

脚本输出符合 [Anna binary distribution 规范](https://staging.anna.partners/developers/tools/executa-binary)的 archive（`dist/`）：

```
mini-notes-summarizer-darwin-arm64.tar.gz
├── manifest.json                        # archive root：name=tool_id、version、runtime.binary
└── bin/tool-dev-mini-notes-summarizer   # entrypoint（0o755；windows 为 .exe + .zip）
```

archive root 的 `manifest.json` 声明 `runtime.binary.entrypoint`（含 per-platform map）与 `permissions`；平台 key 使用 `darwin-arm64` / `darwin-x86_64` / `windows-x86_64`（另附 `linux-x86_64` 供 CI smoke）。打包后对本机平台自动跑 `describe` JSON-RPC 冒烟。

## GitHub Actions 发布

Workflow：[.github/workflows/release.yml](.github/workflows/release.yml)

**触发方式：**

- 推送 tag：`git tag v1.0.0 && git push origin v1.0.0`
- 手动：Actions → *Release Executa binaries* → **Run workflow**（填 tag 名）

**每次发布做什么：** 三平台 matrix（ubuntu-latest 上 Go 交叉编译）→ 先对同一份源码的本地原生构建做 **JSON-RPC smoke test**（`initialize` 断言 v2+sampling、`describe` 断言 manifest）→ 打包并校验 archive 结构（root 必须含 `manifest.json` 与 `bin/` entrypoint）→ 作为 **GitHub Release assets** 上传（workflow artifacts 仅为辅助产物）：

```
mini-notes-summarizer-darwin-arm64.tar.gz
mini-notes-summarizer-darwin-x86_64.tar.gz
mini-notes-summarizer-windows-x86_64.zip
```

## 概念关系速览

| 概念 | 本仓库对应物 | 关系 |
|---|---|---|
| **manifest**（App） | `manifest.json` | 声明 App 的权限、依赖的 Executa（`required_executas`）、UI bundle 与 host_api ACL；`anna-app dev` / 发布端都用同一套校验 |
| **bundle** | `bundle/`（`npm run build` 产物） | manifest `ui.bundle.entry` 指向的静态 SPA，在 Anna 的沙箱 iframe 中运行，经 Runtime SDK 调 Host API |
| **executas** | `executas/notes-summarizer/` | App 捆绑的 stdio 插件；bundle 经 `tools.invoke` 按 `tool_id` 路由到它 |
| **Anna storage / APS KV** | `anna.storage.get/set`（key `mini-notes/v1`） | Host API 的 per-(user, App) KV。生产走 APS（Postgres + 配额 + etag）；本地无 login 用 legacy in-memory `runtime_state` 验证同一套调用 |
| **sampling** | Tool 内 `sampling/createMessage` | Executa 协议 v2 的 reverse RPC：插件借用 host 的 LLM，无需自带 API key；模型选择 / 计费 / 配额由 host 管理 |
| **binary archive** | `scripts/build-binary.sh` 产物 | Executa 的发布形态：archive root 放 `manifest.json`（`runtime.binary.entrypoint` 等），Agent 按平台 key 拉取对应 asset 安装 |

## 明确不包含

无真实 Anna 账号 / login / LLM key / 云端 APS；不要求 legacy runtime_state 跨重启保留；无代码签名与公证；无编辑 / 搜索 / 标签等扩展功能（均为题目明确不要求项）。

## License

MIT

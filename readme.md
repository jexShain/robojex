# RoboJex

常驻、自我发起、元学习的开源 Agent 框架。主 Agent **只编排不干活**——观察桌面与任务板，把工作派给 sub-agent（hermes / claude-code 等），自己保持上下文干净并持续进化（使命 / 评分 / 记忆三文件自演化）。

```
┌─────────────┐  ws://127.0.0.1:7600   ┌──────────────┐  spawn   ┌───────────────┐
│  ceo-core    │ ◄──────────────────────► │  takeoverd    │          │ sub-agents     │
│  LLM 决策循环 │      屏幕事件/模式/注入    │  屏幕+键鼠+热键 │ ◄───────  │ hermes/claude  │
└──────┬──────┘                          └──────────────┘          └───────────────┘
       │ :7610 webhook(外部系统唤醒)        viewer/index.html(浏览器实时观看)
       ▼
  任务板(board.sqlite)· 审计 · 预算 · ToolScout · Tentacles
```

## 快速入门（二进制，3 步）

**前置**：无。二进制内嵌 Node 22 运行时，裸机可跑（连 git 都不需要）。

**1. 下载解压** —— [Releases](https://github.com/jexShain/robojex/releases) 取对应平台包（linux / macos / win × x64 / arm64）:

```bash
unzip robojex-linux-x64.zip && cd robojex
```

包内：`robojex-ceo`、`robojex-takeoverd`、`skills/`（框架手册）、`viewer/`。

**2. 配置模型** —— 编辑 `runtime/config.json`（密钥只存在这里，该目录不入库）:

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的密钥",
  "patrolModel": "deepseek-v4-flash",
  "decideModel": "deepseek-v4-flash",
  "budgetMode": "budgeted",
  "dailyTokens": 2000000
}
```

**3. 启动**（先写一句使命，`runtime/MISSION.md`）:

```markdown
# MISSION
维护本机文档仓库:每天检查变更,发现错别字就派 hermes 修复。
```

```bash
./robojex-takeoverd &          # 桌面守护进程，默认 :7600，启动即 observe（安全）
./robojex-ceo                  # Jex 循环，默认 60s 一个决策节拍
```

看到 `ceo-core running (Ctrl+C to stop)` 即表示已启动。浏览器打开 `viewer/index.html` 可实时观看。停止：Ctrl+C（会先杀干净所有 sub-agent）。

## 桌面接管模式

`Shift+Ctrl` 热键循环切换，每次启动固定回到 **observe**：

| 模式 | 行为 |
|---|---|
| `observe` | 只看不动：1fps 截屏（pHash 去重），注入被代码级禁用 |
| `assist` | 半接管：AI 可注入键鼠，人类活动立即抢占 |
| `full` | 完全接管 |

硬底线（任何模式）：`rm -rf`、`sudo` 硬阻断；人类输入永远优先。本地 Chrome 开调试端口（如 `--remote-debugging-port=9222`）时 takeoverd 自动接入 CDP，Jex 可直接驱动浏览器。

## 配置参考(`runtime/config.json`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` / `apiKey` | — | OpenAI 兼容接口(必填) |
| `patrolModel` / `decideModel` | — | 巡逻用便宜模型、决策用强模型(可相同) |
| `budgetMode` | `burn` | `burn` 无限烧 / `budgeted` 按 `dailyTokens` 日预算(按日滚动,全部 LLM 调用记账) |
| `tickMs` | `60000` | 决策节拍间隔 |
| `takeoverUrl` | `ws://127.0.0.1:7600` | takeoverd 地址 |
| `webhookPort` | `7610` | Tentacles webhook 端口 |

环境变量:`ROBOJEX_RUNTIME` 指定运行目录(默认 `./runtime`);`--install-service` 生成 systemd 用户单元。

> 推理型模型(如 DeepSeek v4)可用:内部各环节 token 预算已按推理模型调好。

## 内置能力

- **ToolScout**:首次启动自动扫描/验证系统工具,用户级自安装(npm/pip,绝不 sudo),`TOOLS.md` 一行式清单进上下文,完整手册按需注入;缺 apt 包只排队到 `PENDING_INSTALLS.md`。
- **Tentacles(触手)**:`runtime/tentacles/` 放 JSON spec 或 `.mjs` 插件即可接入任意 API/硬件;支持 OpenAPI 导入、硬件自动扫描(串口/摄像头/HID);密钥只写环境变量名。外部系统 `POST http://主机:7610/t/<触手名>` 可唤醒 jex。
- **元学习**:`MISSION.md`/`RUBRIC.md`/`MEMORY.md` 由审计器改写并做 git 快照(git 缺失时自动降级)。

## 从源码运行(开发)

要求 Node ≥ 22.14(内置 node:sqlite)。

```bash
npm ci
npx tsc -b packages/ceo-core packages/takeoverd
npx vitest run                          # 全量测试
node packages/takeoverd/dist/index.js --port 7600 &
node packages/ceo-core/dist/index.js
```

打包发布:打 `v*` tag,GitHub Actions 自动出五平台单文件二进制并挂 Release。

## 架构文档

原始需求与逐条落地对照见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

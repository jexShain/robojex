# RoboJex Desktop — ChatGPT 级桌面 AI 系统 SPEC

> 状态：定稿（2026-08-21，全自主通宵模式）。对标：ChatGPT 最新桌面版。
> 目标：界面效果超越 ChatGPT 桌面版，产品完成度对标 ChatGPT 桌面版。

## 0. 定位

RoboJex 不只是聊天软件，是一个**常驻桌面的人工智能系统**：
- **Chat 模式**：与 RoboJex 直接对话（DeepSeek 流式，含思考流）——ChatGPT 级体验
- **Agent 模式**：jex 编排循环自主工作（任务板、巡逻、派发 sub-agent）——超越 ChatGPT 的差异化
- **自主挡位（Autonomy Gears）**：用户选择 jex 的"活跃度"，低挡省 token，高挡强自主
- 后期插件小功能（本 spec 预留 plugin 骨架，不实现）

## 1. 架构

```
Electron App (packages/electron)
├─ main process
│  ├─ 内嵌 ceo-core（in-process，动态 import dist）
│  │  ├─ ApiServer :7620（HTTP + WS，已有）
│  │  ├─ ChatService（新增：流式直聊 + 会话持久化）
│  │  ├─ GearService（新增：自主挡位）
│  │  └─ SchedulerLoop（已有：jex 编排循环，挡位感知）
│  ├─ 窗口管理 / 托盘 / 全局快捷键 / 单实例 / 窗口状态持久化
│  └─ preload 安全桥接（contextBridge）
└─ renderer (packages/web，完全重写)
```

- **单进程桌面应用**：Electron main 直接运行 ceo-core（node:sqlite 在 Electron 43 内置 Node 可用）。Linux 专属能力（takeoverd/X11/bash spawn）在 Windows/macOS 优雅降级。
- **开发模式**：vite :5173 proxy /api → :7620；ceo-core 可独立 `jexd` 运行（WSL 内），Electron 加载 localhost:5173。
- **直连模式兜底**：renderer 无法连 WS 时仍可纯前端直连 DeepSeek（用户可在设置里关闭"本地网关"，输入自己的 key）。默认走本地网关（key 不进 renderer）。

## 2. 后端新增（ceo-core）

### 2.1 ChatService — 流式直聊 + 会话持久化

- SQLite（runtimeDir/chat.sqlite，WAL）：
  - `conversations(id TEXT PK, title TEXT, created_at INT, updated_at INT, pinned INT DEFAULT 0, gear TEXT, model TEXT, archived INT DEFAULT 0)`
  - `messages(id TEXT PK, conv_id TEXT, role TEXT('user'|'assistant'|'system'), content TEXT, reasoning TEXT, model TEXT, tokens_in INT, tokens_out INT, created_at INT, error TEXT)`
- API：
  - `GET /api/conversations` → 列表（updated_at 倒序，带 lastMessage 预览、messageCount）
  - `POST /api/conversations` `{title?}` → 新建
  - `PATCH /api/conversations/:id` `{title?, pinned?, archived?}` → 更新
  - `DELETE /api/conversations/:id` → 删除（连带消息）
  - `GET /api/conversations/:id/messages` → 消息列表
  - `POST /api/chat/stream` `{conversationId, text, model?, gear?, mode:'chat'|'agent'}` → **SSE 流**
    - SSE 事件：`meta`(convId,msgId,model)、`reasoning`(delta)、`content`(delta)、`usage`(tokens)、`done`、`error`(message)
    - 流式转发 DeepSeek `delta.reasoning_content` 与 `delta.content`；中断支持（`POST /api/chat/stop`，AbortController）
    - 完成后异步生成会话标题（首轮对话后，patrol 槽，≤20 字）
    - `mode:'agent'` 时：文本同时 push 进 jex 事件队列（保留旧编排能力），仍走直聊流回复
  - 消息级操作：`DELETE /api/messages/:id`、`POST /api/conversations/:id/regenerate`（截断到上一条 user 消息重发）
- **旧 `/api/chat`（loop 路由）保留**，标记 legacy，仅 agent 面板用。

### 2.2 GearService — 自主挡位（用户核心新需求）

5 挡，一次切换全局生效（config.autonomyGear + 内存热更）：

| 挡位 | 名 | tick | 行为 | 决策 max_tokens | patrol 频率 |
|---|---|---|---|---|---|
| 0 | dormant 休眠 | 停 | 不巡逻不决策，只响应直聊；jex「睡着了」 | — | 关 |
| 1 | eco 省电 | 5min | 极省 token：只看关键事件，动作保守 | 2048 | 每 5 tick |
| 2 | balanced 均衡 | 60s | 默认：正常自主，平衡成本 | 4096 | 每 tick |
| 3 | focused 专注 | 30s | 主动推进任务板，愿意 spawn，深入思考 | 8192 | 每 tick |
| 4 | turbo 狂暴 | 15s | 最大自主：自我发起任务、自我审计、全速燃烧 | 16384 | 每 tick |

- 每挡一套**提示词**（人格 + 自主度 + 花销纪律）——核心就是"多种提示词"：
  - dormant: 系统几乎不注入，chat 仍可用轻量人格
  - eco: 「你是省电模式的 jex……除非事件紧急否则选择 none……」
  - balanced: 默认编排人格（现行为）
  - focused: 「主动寻找可推进的任务……优先 spawn 并行……」
  - turbo: 「全速模式……自我发起任务、审计自己、优化 MISSION……」
- API：`GET /api/gear`（当前挡位+说明+花费统计）、`PUT /api/gear {gear}`（热切换：改 config.json + loop.setTick + 注入挡位提示词）
- WS 广播 `{t:'gear', gear}`；挡位切换写入 chat 流（system 消息）
- 直聊模式的 chat 也按挡位注入不同人格 system prompt（低挡冷静简短，高挡主动详细）

### 2.3 其他后端

- `GET /api/models` → 代理 DeepSeek /models（缓存 10min）
- 预算面板数据：`GET /api/usage?days=7` → 按日 token 花费（chat + loop 合计）
- config.json 默认写入用户提供的 key / deepseek-v4-flash
- 设置 API 已有（GET/PUT /api/settings），补热更：gear/tickMs 即时生效

## 3. 前端完全重写（packages/web）

### 3.1 布局（ChatGPT 桌面版结构，超越之）

```
┌──────────────────────────────────────────────────────┐
│ ⚡ RoboJex   [Chat|Agent 板|活动|思考流]   🔍  ⚙  ☀ │  ← 顶栏 44px
├──────────┬──────────────────────────────┬───────────┤
│ + 新对话  │                              │           │
│ 🔍 搜索   │        消息流                │  详情面板  │
│ ──────── │   (user 右 / jex 左          │  (可折叠)  │
│ 📌 置顶   │    思考折叠条                │  任务卡    │
│ 今天      │    markdown+代码块+复制)     │  花费表    │
│ 昨天      │                              │  挡位仪表  │
│ 更早      ├──────────────────────────────┤           │
│ ──────── │ 输入区：挡位/模型/发送/停止    │           │
│ 🤖 jex 状态灯（挡位色）                  │           │
└──────────┴──────────────────────────────┴───────────┘
```

- 三列均响应式：窄窗口侧栏自动收成图标栏（260px→64px），详情面板可关
- 侧栏会话：分组（置顶/今天/昨天/近 7 天/更早）、悬停操作（置顶/重命名/删除）、右键菜单
- 空状态：品牌化欢迎页（渐变 orb + 示例提示词卡片）
- 命令面板 Ctrl+K：搜会话/切挡位/切视图/切主题

### 3.2 聊天体验（逐项对标 ChatGPT 并超越）

- 流式渲染：SSE 增量、光标闪烁、自动滚动（用户上滚则暂停，"回到底部"浮标）
- **思考流**：reasoning_content 折叠条「已思考 Xs」，流式期间展开实时滚动，完成后折叠可再展开
- Markdown：GFM、表格、代码高亮 + 代码块头部（语言 + 复制按钮）、链接卡片、任务列表
- 消息操作：复制 / 重新生成 / 编辑重发（user）/ 删除；token 用量角标
- 输入区：自适应高度（1→10 行）、Enter 发送 / Shift+Enter 换行、/ 命令菜单、@ 提及挡位、停止按钮（流式中）、字数与预估 token
- 失败处理：错误气泡 + 重试按钮；断网提示
- 会话标题自动生成；重命名内联编辑
- Agent 模式消息：jex 编排动作渲染成时间线卡片（spawn/任务完成），与直聊消息同流

### 3.3 视图

- **Chat**（默认）：如上
- **Agent 板**：任务树/看板（todo/running/done/blocked 泳道或树）、进度环、verdict 徽章、新建任务、验收
- **活动**：cycle 心跳流、预算燃料表、事件流（屏幕/工具/webhook）
- **思考流**：jex decide 层的 reasoning 轨迹（从 cycle 事件抽取）+ 当前挡位大仪表盘
- **设置**（模态）：API（baseUrl/key 掩码/模型选择）、挡位详细说明、预算模式、主题、快捷键说明、关于

### 3.4 视觉与动效（超越 ChatGPT 的点）

- 设计 token：CSS 变量体系（色板/间距/圆角/阴影/动效曲线），深色为默认（AI 产品感），浅色完整适配
- 主色：电光紫→青渐变（品牌 orb），中性色阶对标 ChatGPT 的暖灰
- 动效：侧栏会话项 stagger 入场、消息淡入上滑、思考条展开弹性、挡位切换仪表指针缓动、视图切换交叉淡入、按钮涟漪、骨架屏加载
- 全局：focus ring 无障碍、reduced-motion 媒体查询降级、滚动条自定义、文字选中色
- 字体：Geist Variable（已装）+ Geist Mono；中文回退 PingFang/微软雅黑

### 3.5 状态管理

- 保留 generation-based WS 重连（connection.ts 模式），新增：
  - conversationsStore（列表 + 当前会话消息，乐观更新）
  - chatStreamStore（SSE 流状态机：idle|streaming|stopping|error）
  - gearStore、settingsStore、themeStore（已有基础）
- Electron 感知：window.robojex（platform、窗口控制、托盘状态）

## 4. Electron 壳（packages/electron）

- main.js 完整化（TypeScript 化可选，保持 .js 亦可）：
  - 单实例锁（second-instance → 聚焦已有窗口）
  - 窗口状态持久化（electron-store 或自写 JSON：x/y/w/maximized）
  - 托盘：菜单（显示/隐藏、新建对话、挡位快切、退出）、关闭行为可选（托盘 or 退出）
  - 全局快捷键：`Alt+Space` 快速提问小窗（mini widget，复用 WidgetApp）、`Ctrl+Shift+J` 呼出/隐藏主窗（T8：已显示且聚焦时再按隐藏到托盘）
  - 原生菜单（macOS 必需）：File/Edit/View/Window/Help
  - 启动流程：app.ready → 起内嵌 ceo-core（或连外部）→ 起 UI；状态页（后端启动中/失败重试）
  - 安全：contextIsolation、sandbox、CSP、禁用 navigation、permission handler
  - 打包：electron-builder 配 NSIS + dmg + AppImage；web dist + ceo-core dist 打进 asar

## 5. 测试与验收

- vitest 单测：ChatService（持久化/SSE/标题生成 fake LLM）、GearService（切换热更/提示词选择）、会话分组逻辑、chatStream 状态机
- Playwright e2e（mock 后端 + 真 UI）：加载、会话 CRUD、流式渲染（fake SSE）、思考折叠、挡位切换、视图切换、主题切换、设置、快捷键、响应式断点；全截图
- 真链路冒烟：WSL 起 ceo-core + 真 DeepSeek key，一问一答流式 + 挡位切换 + 标题生成
- 验收：npm test 全绿；e2e 全绿；electron:dev 手动冒烟清单全过

## 6. 里程碑（通宵）

1. M1 后端：ChatService + GearService + models/usage API + 测试
2. M2 前端：设计 token + 布局骨架 + 聊天核心（流式/思考/markdown）
3. M3 前端：会话管理 + 挡位 UI + Agent 板/活动/思考流 + 设置
4. M4 Electron 壳 + 打包路径
5. M5 e2e + 真链路 + 截图验收 + commit

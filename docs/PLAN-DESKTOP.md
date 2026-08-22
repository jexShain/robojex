# RoboJex Desktop 实施计划（通宵执行）

依据：docs/SPEC-DESKTOP.md。所有命令经 WSL：`wsl -d Ubuntu -- bash -lc "cd ~/ai/robojex && …"`。

## 现状结论（侦察）

- 后端 ApiServer(:7620) WS `/api/events` + REST 骨架健全；llm.ts 无流式；聊天无持久化
- 前端：connection.ts 重连模式与 boardModel/agendaModel/activityModel/thinkingModel（含测试）可保留；ChatStream/Markdown/InputBar/Sidebar/SettingsView/AppFrame/CSS 需重写或大改
- SettingsView 引用未安装的 @preact/signals（构建即坏）——必须重写
- Electron main.js 样板，prod loadFile 路径错误，无托盘/快捷键/单实例

## 契约先行（主会话亲手写，禁止 agent 改）

**文件所有权**（agent 间不得越界）：

| 归属 | 文件/目录 |
|---|---|
| 主会话 | `packages/web/src/state/types.ts`、`state/store.tsx`（骨架）、`state/tokens.css` 新设计系统、`package.json` 依赖 |
| BE agent | `packages/ceo-core/src/**`（chat-store.ts、chat-service.ts、gears.ts、api.ts 扩展、llm.ts 流式）+ `packages/ceo-core/test/**` |
| FE-CHAT agent | `packages/web/src/chat/**`、`src/sidebar/**`、`src/chat/*.css` |
| FE-VIEWS agent | `packages/web/src/views/**`、`src/details/**`、`src/frame/**`、对应 css |
| EL agent | `packages/electron/**` |
| 集成/测试 agent | `e2e/`、`scripts/`，只读 src |

## 任务分解

### T0 主会话：契约 + 依赖（先行）
1. `npm i marked dompurify highlight.js`（WSL）
2. 重写 `state/types.ts`：新帧（`gear`、`chat_delta`…）+ Conversation/Message/ChatStreamState/GearDef 类型
3. `state/store.tsx`：会话/流式/挡位 reducer 骨架（含 API 客户端函数，后端契约按 SPEC）
4. 新 `styles/tokens.css`：完整双主题 token（修漂移：所有引用 token 必须存在）
5. config.json 写入新 key/默认模型

### T1 BE agent：ChatService + GearService
1. `chat-store.ts`：SQLite conversations/messages（迁移、CRUD、分组查询）
2. `llm.ts`：`chatStream(slot, messages, opts)` — fetch SSE 解析 reasoning_content/content，AbortSignal，usage 回传
3. `gears.ts`：5 挡定义（tick/maxTokens/patrolEvery/systemPrompt×2[loop+chat]）、`setGear` 热切换（config 持久化 + loop.setTickMs + 广播）
4. `chat-service.ts`：SSE 端点编排（建消息→流→落库→标题生成→usage 记账）；regenerate/stop/delete；`mode:'agent'` 时 push 进 loop
5. `api.ts`：挂载 `/api/conversations*`、`/api/chat/stream`、`/api/chat/stop`、`/api/gear`、`/api/models`、`/api/usage`；hello 帧加 `gear`
6. loop.ts：挡位感知（tick 热更、patrol 频率、decide maxTokens、挡位 system prompt 前缀）
7. 测试：chat-store CRUD/流式 fake、gears 切换/提示词、API 集成（vitest，fake LLM）

### T2 FE-CHAT agent：ChatGPT 级聊天核心
1. `chat/Markdown.tsx`：marked + DOMPurify + highlight.js；代码块头部（语言/复制/换行开关）、表格/标题/引用/任务列表、链接安全
2. `chat/ChatStream.tsx`：流式消息（reasoning 折叠条实时滚动→完成折叠）、光标、stick-to-bottom+回到底部浮标、消息操作（复制/重生成/编辑重发/删除）、token 角标、错误重试、CycleCard 保留融入
3. `chat/InputBar.tsx`：自适应高度、IME 安全、/命令（扩展 /gear /model /theme）、@挡位快捷、停止按钮、草稿
4. `sidebar/Sidebar.tsx`：新对话、搜索（标题+内容过滤）、分组（置顶/今天/昨天/7天/更早）、悬停操作、右键菜单、jex 状态灯（挡位色+呼吸）、连接状态
5. `chat/EmptyState.tsx`：品牌 orb 动画 + 示例提示卡
6. 对应 `chat.css`/`sidebar.css`（只用 tokens.css 变量）

### T3 FE-VIEWS agent：工作台视图 + 设置
1. `frame/AppFrame.tsx`：新布局（顶栏 44px：logo/视图 tabs/搜索/挡位速切/主题/设置；三列响应式收展；命令面板 Ctrl+K）
2. `views/SettingsView.tsx`：完全重写（React！）：AI 提供商/模型选择（/api/models）/预算/挡位详细表/连接/关于（真版本号）
3. `views/GearPanel`（思考流视图升级）：挡位仪表盘（大表盘+指针缓动）+ decide reasoning 轨迹 + 花费表（/api/usage）
4. BoardView/AgendaView/ActivityFeed：接入新 store、修死代码（Agenda drag 持久化 PATCH /api/task 补 dueAt/scheduledAt）、视觉对齐新 token
5. `frame/HudBar.tsx`：顶栏化改造，挡位/心跳/预算/时钟
6. 对应 css（views.css/frame.css 拆分）

### T4 EL agent：Electron 壳
1. main.js：单实例锁、窗口状态持久化、托盘（显示/新建对话/挡位/退出）、全局快捷键（Alt+Space 迷你窗→/widget、Ctrl+Shift+J 主窗）、原生菜单、外链 shell.openExternal、CSP、permission handler、启动编排（内嵌 ceo-core try/catch 降级外部）
2. preload.js：窗口控制/平台/托盘 API 暴露
3. electron-builder.yml + package.json scripts：修 prod 路径（vite outDir → electron 消费）、NSIS/dmg/AppImage、asar 配置
4. 冒烟：WSLg 下 electron:dev 启动截图

### T5 集成 + 测试 agent（主会话统筹）
1. `npm run build` + `tsc` 全绿
2. vitest 全绿（修基线遗留 1 失败）
3. Playwright e2e 新脚本 `e2e/desktop.spec.mjs`：16+ 场景（加载/会话 CRUD/流式 fake SSE/思考折叠/挡位切换/四视图/主题/设置/命令面板/响应式/快捷键）全截图到 e2e-screenshots/
4. 真链路：WSL 起 ceo-core + 真 key，curl 流式验证 + 标题生成 + 挡位热切
5. 截图人工审查（主会话读图）→ 修视觉问题循环
6. 全绿后 commit + 更新 TODO.md

## 执行顺序与并行

```
T0(主) ──┬─→ T1(BE)  ────────────┐
         ├─→ T2(FE-CHAT) ────────┤→ T5 集成测试 → 修环 → commit
         ├─→ T3(FE-VIEWS) ───────┤
         └─→ T4(EL) ─────────────┘
```
T1-T4 全并行（文件所有权隔离）；各自完成即自测（tsc + 相关 vitest）。T5 由主会话统筹 + 测试 agent 执行。

## 验收标准（全部满足才算完成）

- [ ] vitest ≥ 基线（314 过，含新增 chat/gear 测试）
- [ ] Playwright e2e 全绿 + 截图无视觉缺陷
- [ ] 真流式一问一答（reasoning 折叠 + 内容 markdown + 标题自动生成）
- [ ] 5 挡切换热生效（tick 变化 + 提示词变化 + UI 表盘/状态灯联动）
- [ ] 会话 CRUD + 分组 + 搜索 + 置顶全可用
- [ ] 深浅主题完整无 token 漂移（grep 校验脚本）
- [ ] Electron dev 启动成功（WSLg 截图）
- [ ] TODO.md 更新 + git commit

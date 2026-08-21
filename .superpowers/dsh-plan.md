# RoboJex × DeepSeek Harness 重构设计简报(契约冻结版)

源参考:/media/xzx/_dde_home/app/deepseek-harness(MIT,搬运需留署名注释)。
目标仓库:/media/xzx/_dde_home/app/rbj(分支 master,HEAD e476a67)。Node≥22.14 ESM TS strict,node:sqlite,测试 vitest(node22 跑),注释英文,不跑 lint。
哲学:DSH 的**视觉/交互/操作逻辑**照搬,架构自建(不引 Cordis/插件系统)。React 18 + Vite 6 仅用于 packages/web,产物静态文件随发布包分发;core 二进制继续 esbuild+pkg 单文件。

## 冻结的对外协议(core 新增 HTTP+WS 服务,默认 :7620,config.apiPort)

### HTTP
- `GET /api/state` → `{ tasks:[{id,title,status,resultSummary,createdAt}], budget:{mode,dailyTokens,spentToday,line}, mode:"observe"|"assist"|"full", mission, rubric, memory, chat:[{from,ts,text}] (最近100条,内存 ring), version }`
- `POST /api/chat` body `{text}` → 202;text 非空≤16KB;即时 loop.push(`chat: ${text}`) 并广播 chat_out(from:user)
- `POST /api/mode` body `{mode}` → core 经 takeover WS 转发 `{t:"ctrl",op:"set_mode",mode}`,成功 202,无效 400
- `GET /` 及静态 → 生产模式 serve packages/web/dist(vite 产物,打包时嵌入发布目录 web/);开发模式 CORS 放开(vite dev 5173 代理 /api→7620)

### WS /api/events(server→client 帧,JSON)
`{t:"hello",state}` 连接即推;`{t:"chat_out",from:"user"|"jex",text,ts}`;`{t:"tasks",tasks}`(任务板变化);`{t:"cycle",wake,cost,actions:[...]}`(每决策周期);`{t:"mode",mode}`;`{t:"budget",line}`。
client→server:`{t:"chat",text}`(等同 POST)。
重连:客户端 generation 制(指数退避 1s→16s,重连后收 hello 全量重建)——抄 DSH ConnectionController 逻辑。

### core 循环改动(loop.ts)
- 新事件源:chat 文本直接进事件队列(`chat: <text>`),patrol 系统提示补一句:user chat always requires act。
- decide 动作新增 `{"type":"reply","text":"..."}`:走 chat 出口广播 chat_out(from:jex),计入 actions trace;reply 不 spawn、不占任务板。
- 每周期结束广播 cycle 帧;任务板变更广播 tasks(orchestrator 回填处挂钩子)。

## packages/web(视觉克隆规格)

### 样式(直接抄 DSH 文件,顶部加 MIT 署名注释)
- 拷 `packages/client/ui-theme/src/styles/design-platform.css` 全文(--dsw-static-* + body[data-ds-dark-theme] 的 --dsw-alias-*/--dsw-specific-* 全套)
- 拷 `base.css` 的字体/缓动变量(--dsw-font-family、--ds-font-family-code、--ds-ease-in-out、--ds-transition-duration*)
- 主题:light/dark/system 三态,body[data-ds-dark-theme] 切换,localStorage 持久化,system 听 prefers-color-scheme

### 布局(AppFrame 克隆)
- CSS Grid:`sidebar 260px | minmax(0,1fr) | details`;viewport<900px sidebar 塌成 56px rail(logo/折叠/新任务图标列);details 默认 0 宽可拖;拖拽 pointer-capture+rAF 节流
- Sidebar:任务列表(title+status 圆点:done=green-500/running=blue-450/pending=neutral-400)、底部预算行+模式 chip(observe=amber/assist=blue/full=red)+主题三立方体按钮
- Center:聊天流+输入栏
- Details:选中任务详情(resultSummary/runs 日志)、MISSION/RUBRIC/MEMORY 只读视图、takeover 屏幕预览(ws://host:7600 截图流,沿用现 viewer 逻辑)

### 聊天流(视觉克隆)
- 用户气泡右对齐 --dsw-specific-bubble;jex 回复全宽 markdown
- markdown:轻量渲染器(段落/代码块/行内代码/粗斜体/列表/链接),代码块 --dsw-alias-markdown-code-block + 头部语言标签;流式不做(我们的 reply 一次性到),保留光标动画在等待回复时
- cycle 帧→「决策卡片」:wake/cost/actions 摘要,折叠态一行
- 任务状态变化→内联 toast 行

### 输入栏(交互克隆)
- textarea 自增高(≤8 行);Enter 提交、Shift+Enter 换行、IME composing 期 Enter 不提交;↑↓ 历史导航(会话内存);Esc 清空
- 斜杠命令菜单:`/` 触发浮层(320px max,分组),实现:/mode observe|assist|full、/tasks、/mission <text>(写入 MISSION.md?否——POST /api/mission 新增,core 端 auditor 补丁)、/budget、/help
  - 协议补一条:`POST /api/mission` body `{text}` → 追加(不覆盖)MISSION.md 并广播 chat_out(from:system)
- 发送后禁用至收到 chat_out(jex)或 30s 超时

### 状态管理
零库:useReducer + Context 一个 store(state 帧驱动:hello/chat_out/tasks/cycle/mode/budget 各 reducer 分支)。不许引 zustand/redux。

## packages/cli(jex 终端客户端)
- bin 名 `jex`;`jex [--url http://127.0.0.1:7620]`
- 提示符 `jex› `(blue-450 ANSI 38;2;86;134;254),用户输入回显 `you› `(neutral-500)
- readline REPL:WS 连 /api/events;斜杠命令同 web(/mode /tasks /mission /budget /help);Ctrl+C 一次中断等待中的回复、连按两次退出;Ctrl-D 退出
- 非交互管道:`echo "..." | jex --once` 发一条收一条退出(脚本/测试用)

## 验收
- core:api.ts+loop 改动 vitest 全绿(新测试:chat 入队、reply 广播、state 帧、mode 代理、mission 追加)
- web:vite build 产物 <400KB gzip 总量;浏览器手测三布局断点+两主题+完整对话
- cli:jex --once 对真 core 冒烟
- 发布:三二进制 + web/ 静态目录入 zip;远程 10.10.7.69 实测对话

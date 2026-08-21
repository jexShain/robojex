# Board v2 契约冻结(任务树 + 日程)

仓库 /media/xzx/_dde_home/app/rbj(master,含 v0.2.1 全部)。Node≥22.14 ESM TS strict,vitest(node22),注释英文,不跑 lint。DSH token 体系沿用(packages/web/src/styles/tokens.css)。目标:多级任务树看板 + 时刻/按日日程视图(Web 炫酷动态、CLI 接近 GUI),CEO 可按时派活。

## 数据模型(board.sqlite `tasks` 原地 ALTER 迁移,老库无损)
新增列(全部可空,老行为不变):
- `parent_id TEXT` — 父任务 id;NULL=根。层级不限深度;epic=有子节点的根,深度即级别。
- `scheduled_at INTEGER` — 计划开始(epoch ms)
- `due_at INTEGER` — 截止(epoch ms)

TaskRecord 增字段:parentId/scheduledAt/dueAt(ISO 字符串出 API?否——**epoch ms 数字**出 API,前端本地格式化;ContextAssembler 文本用人类可读)。

不变量:子任务完成不自动完成父;blocked 冒泡仅展示层计算(前端/CLI 自行算"子有 blocked 则父标警示")。

## API 变更
- `GET /api/state`:tasks[] 每项含 id/title/status/resultSummary/createdAt + **parentId/scheduledAt/dueAt**;新增 `now`(服务器 epoch ms,供时钟对齐)。
- `POST /api/task` `{title, parentId?, scheduledAt?, dueAt?}` → 202 创建(todo 状态),广播 tasks 帧;title 非空≤200B,时间字段校验有限数字;非法 400。
- tasks 帧(已有):负载自动带新字段。
- 其余端点不动。

## decide 循环(loop.ts)
- spawn 动作可选字段:`"parent"`(任务 id,须存在于板,否则忽略并日志)、`"scheduledAt"`/`"dueAt"`(ISO 8601,解析失败忽略+日志)。解析成功传 board.create。
- 系统提示 spawn 描述补这三个可选字段一句。
- ContextAssembler 的 board 块:每任务行加 `[sched HH:MM|MM-DD HH:MM][due …]`(有则显示)与 `↳parent` 缩进树形(深度≤2 层缩进),让模型看得到树与时间压力。

## Web(packages/web)
视图切换:侧栏底部或顶部分段控件 **Chat / Board / Agenda**(状态存 localStorage)。

### Board 视图(任务树看板,炫酷动态)
- 横向树:根在左、子向右,节点=圆角卡(title+状态点+sched/due 徽标),层间距 24px、同层 12px;
- 连接线:SVG 三次贝塞尔(deepseek-450 渐变描边),节点进场连接线 stroke-dashoffset 画线动画 300ms;
- 展开/折叠:子节点 collapse 高度+透明度过渡;有子节点的卡显示 `▸/▾` 与子数徽标;
- running 节点:状态点 pulse 动画+卡外发光(box-shadow deepseek-400/40%);blocked 红色描边;done 整卡 60% 透明+划线标题;
- 空态/单任务退化为纵向列表(无连线);
- 顶部工具条:筛选(全部/进行中/今日到期)+ 展开全部/折叠全部;
- 数据驱动:hello/tasks 帧即重渲染(CSS transition 自动补间)。

### Agenda 视图(日程)
- 两模式:Day(单日时刻表)/ Days(7 日);
- Day:24h 竖轴(默认视口滚到当前小时),小时格线(整点实线/半点虚线),任务块 top=(schedAt-当日0点)/86400*100%、高=max(30min,(dueAt-schedAt)),无 due 默认 30min;scheduledAt 落在当日的任务;now 红线(60s 心跳推进)+右侧今日待办(无 schedAt 任务,点击看板跳转);
- Days:7 列,列头 DD ddd,块竖排按时刻,跨日任务在起日渲染至 due;今日列高亮;
- 任务块:状态色左边条(done 绿/running 蓝 pulse/blocked 红/todo 中性),hover 浮起+显示 resultSummary tooltip。

### 通用
- 全部用现有 --dsw-* token;动画尊重 prefers-reduced-motion(降级为无动画);
- 不新增任何 npm 依赖(不引 d3/React Flow——手写 SVG+CSS)。

## CLI(packages/cli)
- `/board`:ANSI 树(├─ └─),缩进=层级;`●` 状态色(done 绿32/running 蓝94+闪烁?不用闪,用亮蓝/blocked 红31/todo 灰90);行尾 `⏱09:30 ⏳12:00`(sched/due,当日显 HH:MM 非当日显 MM-DD HH:MM);根节点汇总 `N tasks · X done · Y running`;
- `/agenda [YYYY-MM-DD]`(默认今日):两段——上半时刻条(每小时一行 `09 ─` 有任务则 `09:30─10:30 │ title [status]`),下半"无时间任务"列表;
- 对话机制升级:等待回复时 braille spinner(⠋⠙⠹⠸⠼⠴⠦⠧ 120ms,收到 chat_out/cycle 停)+回复前空行分隔;tasks 帧到达且非当前等待上下文时打一行 toast `✓ task done: <title>`(不刷屏,节流 1s);
- `/help` 更新;纯函数渲染器(boardRender/agendaRender/spinner)导出可测。
- 远程时钟:state.now 已给;CLI 渲染用本地时间即可(误差容忍)。

## 验收
- core:TDD——迁移(旧库 ALTER 后旧任务新字段 null)、树创建/查询、POST /api/task 202/400、spawn parent/schedule 解析(合法/非法/父不存在)、board 上下文含 sched 文本;
- web:tsc 净、vite build ≤ 上版+30KB、浏览器实测三视图+帧驱动更新+两主题;
- cli:渲染器快照测试 + --once 回归;
- 发布:tag v0.3.0 五平台;远程(有桌面,DISPLAY=:0)部署:takeoverd 真截图、浏览器开 :7620 实测三视图、CLI /board /agenda 跨机跑通。

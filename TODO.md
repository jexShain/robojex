# robojex TODO

## 2026-08-20 · batch2/batch3 代码审查与修复（进行中）

审查范围：T3 任务树、T4 日程缩放/拖拽、T7 思考流、T8 Electron、app.css 追加段。

### 发现的问题（修复清单）

**编译错误（tsc --noEmit 失败，8 个）**
- [ ] AppFrame: `view === 'activity'` 与 ViewId 联合类型无交集 —— activity 视图自 batch1 起从未注册，恢复为第 5 个视图
- [ ] ActivityFeed: 从 store 具名导入不存在的 `activityItems`（应走 useStore）
- [ ] AgendaView: BASE_HOUR_H 未使用
- [ ] ThinkingStream: useMemo / decidingPlaceholder / showDeciding 未使用（半接线的死功能）
- [ ] thinkingModel: CycleAction 导入未使用

**功能性 bug**
- [ ] agendaModel.treeDepth 只在根任务里找父节点 → 孙辈深度恒为 0（缩进失效）
- [ ] agendaModel.blocksForDay：子任务同时出现在顶层列表和父块 childBlocks（重复渲染）；孙辈在跳过顶层后彻底消失 → 改为递归构建
- [ ] agendaModel/dayColumns：`from0 + i*DAY_MS` 在 DST 回退时区会重复/跳日 → addDaysLocal（dayStartOf 锚定）
- [ ] AgendaView 拖拽数学：yToTime 收到 24h 轨道高而非缩放视口高 → zoom≠24 时落点全错
- [ ] AgendaView 滚动：scrollHours 与原生 scrollTop 双轨不同步（标签消失/空白）；wheel 未 preventDefault 双重滚动 → 原生滚动为唯一真源
- [ ] AgendaView 拖拽 ghost 用 clientY 定位（视口坐标 ≠ 轨道坐标），且放在了滚动容器而非轨道内
- [ ] AgendaView zoom≠24 时小时行 CSS height 固定 56px、半点线 28px → 行高内联 + half 线 50%
- [ ] BoardView ghost 消失定时器：340ms 内再次换布局时 cleanup 只清 timer 不清旧 ghost → 残影永久停留
- [ ] BoardView 内联 animationDelay 覆盖 stagger 类；CSS `.board-card[class*=rj-stagger]` 用不存在的 rj-fade-slide-in 且顶掉了入场动画
- [ ] CSS 引用的 @keyframes 全部缺失：rj-celebrate / rj-fade-slide-in / rj-fade-in / rj-dot-pulse / rj-slide-in-up（celebrate、stagger、chat 入场、conn 脉冲全是空操作）
- [ ] CSS 类未定义：.rj-stagger-1..6、.rj-pulse-dot、.rj-animate-in
- [ ] CSS `.vsw.active button` 选择器错误（.vsw 本身就是 button）
- [ ] CSS `.agenda-block` 追加的 transition 顶掉了 top/height/transform 补间 → 合并完整列表
- [ ] CSS `.ts-main:has(+ .ts-detail)` 光标逻辑反了（展开才显示 pointer）
- [ ] thinkingModel 模块级 nextId：每次 transcript 变更重建全部步骤、id 漂移 → 展开状态丢失 → 确定性 id + useMemo 派生
- [ ] ThinkingStream 自动滚动无"贴底"守卫（用户上翻被强拉到底）
- [ ] activityModel.ingestFrame：每个 tasks 帧把所有 done/blocked 任务重发一遍（feed 刷屏）→ 只在状态迁移时发
- [ ] connection.eventsUrl：Electron file:// 下 host 为空 → `ws:///api/events` 连不上；fetch('/api/…') 同理 → 空回退 127.0.0.1:7620
- [ ] boardModel 孤儿清扫 O(n²) 全表扫描 → 只需从名义父节点摘除
- [ ] electron-builder 无入口（根 package.json 缺 "main"）→ 打包产物起不来
- [ ] electron main.js 未拒绝 window.open（加载远程 dev URL 的基本加固）

**测试**
- [ ] 新增：agenda 树分组/深度/去重、addDaysLocal、boardModel childIndex/allChildrenDone/subtreeRunning/junction、thinkingModel 转换
- [ ] dayColumns 期望值改用 addDaysLocal（tz 稳健）
- [ ] 全量 vitest + tsc 通过（原 224 例 + 新增）

### 备注
- 技术栈澄清：web 端是 React 18（useReducer+Context），不是 preact/signals；新代码与既有模式一致，无需迁移。
- `--rj-*` 设计令牌未定义但 var() 均带 fallback，功能不受影响（报告里说明，不强行补令牌表）。

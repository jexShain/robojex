# RoboJex CEO Agent 框架设计(robojex)

日期:2026-08-18
状态:已确认(用户逐项选定关键决策,六节设计全部通过)

## 0. 目标与非目标

构建一个开源 agent 框架,原生提供**常驻、自发起、自带元学习的 CEO 循环**:

- CEO agent 只负责编排和维护自己的上下文,实际任务交给子 agent 框架(hermes、claude-code 等,以"说明书"形式集成,无头 CLI 调用)
- 桌面接管:内置浏览器通道(CDP)+ 远程桌面式本地服务(截图+键鼠注入),三模式(全接管/半接管/纯观察),Shift+Ctrl 循环切换
- 无视权限类安全边界(用户自有机器,全权授权),但保留防自杀硬底线
- 预算双模式:burn(耗尽 token 为止)/ budgeted(AI 感知预算自己收敛循环次数)

**非目标**:跨平台(首发仅 Linux/X11);不做人脸/声纹等生物识别;不做多用户隔离。

## 1. 已确认的关键决策

| 决策点 | 选择 |
|---|---|
| MVP 优先级 | 内核最小版与接管最小版并行,尽速打通端到端 |
| 语言 | TypeScript / Node.js ≥20(hermes 走 CLI 子进程集成) |
| 接管模式语义 | 三模式:全接管 / 半接管(高危动作人审批) / 纯观察(屏幕学习);Shift+Ctrl 循环切换 |
| LLM 接入 | OpenAI 兼容单协议(base_url+api_key,指向任意 provider) |
| 自发起种子 | MISSION.md 目标文件 + 屏幕观察双源 |
| 进程拓扑 | 三进程隔离:ceo-core / takeoverd / viewer(静态页) |

## 2. 总体架构与进程契约

```
┌─ ceo-core(常驻)─────────────────────────────┐
│ LLMClient(双槽:patrol 便宜 / decide 强)     │
│ AgentOrchestrator(subprocess 池)            │
│ TaskBoard(SQLite) Auditor BudgetGovernor    │
└──────────────┬──────────────────────────────┘
               │ WS localhost(JSON 信令)
┌──────────────▼──────────────────────────────┐      ┌─ 子 agent ────┐
│ takeoverd(守护,:7600)                       │─────▶│ hermes -p …   │
│ ScreenPipeline(X11抓帧→phash→diff→推流)      │      │ claude -p …   │
│ InputInjector(xdotool) HotkeyWatcher        │      └───────────────┘
│ ModeStateMachine ─ CdpChannel(puppeteer)    │     (由 ceo-core 派生)
└──────────────┬──────────────────────────────┘
               │ WS(帧流+控制+审批+消息,单端口)
        viewer 浏览器查看页
```

- takeoverd 是唯一对外端口,ceo-core 与人都是其 WS 客户端
- 信令三类:控制帧(ceo→takeoverd)、事件帧(takeoverd→ceo)、媒体帧(takeoverd→viewer)
- takeoverd 无 LLM、无持久状态;重启回退观察模式
- **崩溃降级链**:takeoverd 崩→CEO 降级纯 CLI(屏幕工具不可用);任何组件崩溃,接管自动降级为只读观察(安全默认)

## 3. CEO 主循环

**唤醒源**(500ms 窗口合并去抖):tick(默认 60s 兜底)、screen_diff(phash 超阈+关键区 OCR 变化)、agent_done(子进程退出带回 stdout)、human(查看页消息/审批)、mode_changed(热键)。

**循环体**:
1. BudgetGovernor:burn 直通;budgeted 查余额,<10% 降 patrol-only,<0% 纯观察不调 LLM
2. ContextAssembler 组装硬上限 ~8K tokens:MISSION.md 全文 + RUBRIC.md + 任务板每卡一行摘要 + 新事件 + MEMORY.md top-N。**子 agent 完整输出永不进 CEO 上下文**,只进压缩后的一行摘要
3. 分层决策:patrol 先跑,`{"action":"none"}` 即结束(美分级开销);有信号才升级 decide 出多动作决策
4. 动作派发:spawn / steer(杀+修正重派) / takeover(半接模式下高危挂审批) / message / mission_update
5. 审计:每次决策记 trace(上下文摘要+决策+结果);每 20 次决策用 decide 模型复盘
6. 睡眠至下一唤醒

## 4. 三模式接管状态机

```
观察(OBSERVE)⇄ 半接(ASSIST)⇄ 全接(FULL)   Shift+Ctrl 循环
```

- **观察**:1fps 低频截图,phash+OCR 产 screen_diff 学习信号;输入注入通道代码级禁用(不注册 injector 回调,非开关)
- **半接**:低危动作(移动/滚动/普通打字)直通;高危(回车提交/删除/支付页/新站表单)挂审批卡,60s 超时默认拒。**人动输入设备瞬间抢占**(输入事件按 /dev/input 时间戳判定优先级:人>AI)
- **全接**:直通;仅 `rm -rf`/`sudo`/支付域硬编码黑名单仍拦(防自杀底线,独立于权限边界)
  高危判定归属:takeoverd 内置规则表(动作类型 × 目标域名/控件类),CEO 在动作信令里也可显式标注 `risk:"high"` 提级。半接/全接模式下截图按需(CEO 决策时请求),不持续推流;仅查看页打开时向人推帧。
- **热键**:X11 XGrabKey(或 evdev 回退,需 input 组);任何模式下永远生效
- **CDP 优先**:网页任务优先浏览器通道(DOM 快照代替截图,快且省);桌面注入仅用于本地应用

## 5. 子 agent 编排层

- 说明书 = `skills/*.md`(hermes.md/claude-code.md…):教 CEO 调用方式、擅长领域、失败模式;按需单篇加载,不全量常驻
- `AgentOrchestrator.spawn(framework, prompt, timeout, budget_hint)`:无头执行(`hermes -p "<p>" --yolo` / `claude -p "<p>" --dangerously-skip-permissions`);stdout 尾 2KB+exit code 为结果;cheap 模型压成一行摘要进任务板,**全文落盘** `runtime/runs/<id>.log`
- 并发默认 2(可配);wall-clock 超时默认 30min;孤儿清理(CEO 重启后杀 ppid=1 残留)
- steer = 杀 + 带修正 prompt 重派,attempts 记录在任务卡

## 6. 元学习(审计器自我更新)

三层可改写文件,全部进决策上下文:
- `MISSION.md`:目标与偏好(种子+屏幕观察推断)
- `RUBRIC.md`:审计标准,每条 = 触发条件+期望结果+权重(可进化的审计机制)
- `MEMORY.md`:事实记忆 top-N 摘要

**复盘循环**:每 20 次决策攒 trace 批,decide 模型逐条按 RUBRIC 打分 → 找低分决策模式 → 输出 RUBRIC/MEMORY 修订(diff 格式)+ MISSION 偏差建议。应用修订前自动 git commit 当前版本(进化可回溯,改坏可回滚)。

## 7. 预算控制

- `burn`:无节制跑到 token 光/进程被杀
- `budgeted`:`daily_token_budget` 配置,LLM usage 记账;余额感知写入决策上下文,AI 自行收敛循环次数

## 8. 目录结构

```
robojex/
├─ package.json(tsconfig, npm workspaces monorepo)
├─ packages/ceo-core/
├─ packages/takeoverd/
├─ packages/viewer/
├─ skills/                    # 框架说明书
└─ runtime/(gitignore)
   ├─ board.sqlite            # tasks(id,title,status,priority,assignee,attempts,result_summary)
   ├─ traces.sqlite           # decisions(id,ts,context_digest,actions,cost)
   ├─ MISSION.md RUBRIC.md MEMORY.md
   ├─ runs/<id>.log
   └─ shots/
```

## 9. 错误处理

LLM 超时指数退避×3 后本轮放弃;子 agent 卡死超时杀+标 blocked;SQLite 全 WAL;CEO 由 systemd/supervisor 拉起(`--install-service`);takeoverd 崩溃 CEO 降级纯 CLI。

## 10. 测试策略

- ModeStateMachine:纯状态机单测
- takeoverd 截图/注入:Xvfb 虚拟显示集成测试
- CEO 循环端到端:假 LLM(fixture 响应)+ stub 子 agent 脚本,验证 种子 MISSION → 决策 → spawn → 审计 → 改 RUBRIC 全链

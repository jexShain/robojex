# PLAN-SUPERHUMAN — 通宵打磨计划（2026-08-22 夜 → 08-23 晨）

> 目标：全面超越 deepseek-harness（dsh）。dsh 是被动 harness；robojex 要成为**自主管家**——自己找活、派活、验收、沉淀经验，"像一个会思考和评判任务完成度的人"。每轮 = 实现 + 单测 + 活体验证 + commit。

## 对标差距图（dsh 有 → robojex 缺）

| # | 能力 | dsh 位置 | robojex 现状 | 动作 |
|---|---|---|---|---|
| A | 输出尾保留+spill 落盘（64KB 内存尾保留、溢出全量落盘、增量读） | subprocess-local/spawn.ts OutputCollector | 8KB 头部截断（丢尾部=丢错误） | R1 移植 |
| B | 超时库（clampTimeout/deadline 融合单信号/idleWatchdog） | util/timeout | 散落的 setTimeout | R2 自研 mini 版 |
| C | 终止升级链（SIGTERM→3s 宽限→SIGKILL+进程树观测） | subprocess-local/spawn.ts | 直接 SIGKILL/taskkill | R1 移植 |
| D | 工具结果渲染契约（[stderr] 分段、[exit code: N] 恒末尾、截断带落盘路径） | shell/tool-bash/render.ts | `$ cmd\nexit=N\nout` 平铺 | R1 移植 |
| E | 重复调用渐强提醒（3/5/8 次同调用注入提醒不否决） | guard/repeat-tool-reminder | 无（死循环烧 token 风险） | R4 自研 |
| F | 上下文确定性裁剪（head/middle/tail 按 code point） | compaction/tool-result-pruner | 无治理，board 大了就撑爆 | R5 自研 |
| G | 后台任务注册表（job_start/output/kill/list+并发上限+级联取消） | jobs/jobs-local | 无（长任务只能 spawn 子代理） | R6 自研 |
| H | 沙箱三档（read-only/workspace-write/danger-full-access+升级审批） | sandbox/* | policy butler/conservative+硬黑名单（已强） | R13 映射增强 |
| I | thinking 模型 reasoning 只在工具轮回传（省 token） | llm-deepseek/serialize.ts | 历史里全丢（已省但丢上下文） | R3 评估优化 |
| J | 稳定错误码（AUTH/RATE_LIMIT/QUOTA/CONTEXT/SERVER）+错误归一化 | llm-deepseek/adapter.ts | 字符串错误 | R3 自研 |
| K | 并行工具调度（isConcurrencySafe+按模型顺序提交） | agent-loop/tool-calls.ts | tool_call fire-and-forget | R14 评估 |
| L | 流空闲看门狗（300s 无 chunk 判死） | llm-deepseek idleWatchdog | 无（挂起风险） | R2 自研 120s |
| M | durable session 事件日志（逐 chunk 落盘可重放） | core/session | traces.sqlite 部分覆盖 | R15 评估 |

## robojex 已领先项（保持+强化）

管家自循环（boot recon/patrol/decide/reflect）、agent-scout 收编外部代理、任务板+验收闭环、主动简报、直聊工具接地（dsh 无）、双语桌面应用、甘特指挥中心。

## "像人一样思考与评判"自创超越线

| # | 能力 | 动作 |
|---|---|---|
| N | 验收智能化：verify 强制证据链（note 须引 tool 实测输出）、无据 pass 打回、fail 自动重派（attempts<2） | R7 |
| O | 经验驱动调度：reflect 统计各代理 verdict 历史→能力画像 STATS.md→decide 派活参考"X 擅长文件任务" | R8 |
| P | 任务分解：decide 新动作 plan{goal,steps[]}→一键生成 parent 子任务树带排程 | R9 |
| Q | 心跳自检：tickN 停滞>3×tick 无 cycle→强制唤醒+自诊断 | R10 |
| S | 直聊工具面扩展：接地循环放行 jobs/board/memory 查询（"我的任务怎么样了"直答） | R11 |

## 执行轮次（每轮一 commit，通宵循环）

- **R1 终端执行器精英化**（A+C+D）：OutputCollector 尾保留+spill、升级链+宽限、渲染契约
- **R2 超时治理**（B+L）：mini timeout 库、chatStream idleWatchdog、terminal deadline 融合
- **R3 LLM 健壮化**（I+J）：稳定错误码分类、空响应重试、errorMessage 归一化
- **R4 防死循环**（E）：repeat tool_call 检测渐强提醒+强制 reflect
- **R5 上下文治理**（F）：board/events/tool 结果确定性裁剪
- **R6 后台任务 jobs**（G）：job_start/output/kill/list + 级联取消
- **R7 验收证据链**（N）：verify 证据强制、自动重派
- **R8 经验驱动调度**（O）：STATS.md 画像注入 decide
- **R9 任务分解 plan 动作**（P）：子任务树批量生成
- **R10 心跳自检**（Q）：停滞检测自恢复
- **R11 直聊工具面扩展**（S）：jobs/board/memory 进接地循环
- **R12 全面回归+打包**：e2e/probe/browser-use 全扫、0.1.5 落桌面
- **R13+ 视时间**：H 沙箱映射、K 并行调度、M durable session、prompt 调优轮

## 每轮纪律

vitest 全绿 + tsc 0 错 + 活体验证（能活体就活体）+ TODO.md 记账 + commit（不 push 到明早统一 push 或每轮 push 均可）。

## 深夜取舍记录（02:0x，明晨汇报口径）

- **H 沙箱三档（read-only/workspace-write/danger）→ 不移植**：robojex 的安全模型是"政策+硬黑名单+提权拦截"（butler/conservative 两档 × 删除/系统目录/敏感路径/提权四条红线 × terminal/jobs/file 三通道共享 commandBlackline），比 dsh 的文件系统沙箱更贴合"最大自主但两条红线"的用户需求；landlock/bwrap 在 WSL 也不可用。
- **K 并行工具调度 → 不移植**：decide 是 JSON 单协议逐动作（0-3/周期），并行度由周期节奏+spawn 并发帽 4 提供；dsh 的 isConcurrencySafe 滚动池是为原生 function-calling 连发设计的，移植收益为零。
- **M durable session 逐块重放 → 不移植**：任务板/战绩/聊天/traces 四处 SQLite+账本已持久化，循环队列瞬时是特性（重启=重新观察世界），不是缺陷。

## 收官记录（08-23 凌晨，R1–R75 全线完成）

- **dsh 对标**：A–G/I/J/L 全部移植或自研落地；H/K/M 明确不移植（见上文取舍，理由成立未变）。
- **超越线**：N–S 全落地后又加 5 轮管家自省（R71 决策回放 / R72 静默跳拍 / R73 催办封顶 / R74 经验入聊+中文 2-gram / R75 reflect 去重）——全部由浸泡中管家自己的 MEMORY 审计驱动，"能评判自己完成度的人"初具雏形。
- **效率硬证据**：R72+R75 后 42 分钟浸泡仅烧 20.5k（旧基线同窗 ~117k，省 ~83%）；重复教训落账归零。
- **活体验证**：agentmode（一句话→decide→任务板 + 深夜自动排程白天）✓、gpu-grounding（最初幻觉 bug 场景闭合：记忆增强 + 一枪命中真输出）✓、ws-live 4/4 ✓。
- **交付**：Windows 0.1.7-final（R71–R75）双产物已落桌面（自省静默版）；vitest 615/615、e2e 22/22。

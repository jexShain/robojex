# RoboJex 管家模式 SPEC（butler）

> 背景：用户实测反馈——不想"人驱动 AI"（聊天→AI 让人 /jex），要**机器人管家**：
> 开机即侦察系统 → 自我发现可用代理工具 → 自编排甘特图任务板 → 派活 →
> 按挡位定时验收 → 空闲自我总结反思。用户只看动态任务板 + 思考日志。
> 自主性最大化：**除删除文件与修改系统关键配置外，全部放开**。

## 1. 安全策略（policy）

`config.json` 增 `policy: "butler" | "conservative"`，**默认 butler**。

| | butler（默认，管家） | conservative（现状） |
|---|---|---|
| 工具门控 | 等效 full：写类直通，无审批 | assist：写类 needs-approval |
| 硬黑名单（两策略恒拦） | rm/rmdir/del/shred/Remove-Item、sudo、敏感路径（/etc、/usr、/bin、/sbin、C:\Windows、C:\Program Files、注册表命令 reg）、config.json 自身 | 同左 |
| takeover 语义 | observe/assist/full 仍管**桌面注入**（takeoverd 在时） | 同现状 |

- `loop.gateForTools()`：policy=butler → 恒返回 'full'（黑名单在 manager 层拦，不再靠挡人审批）。
- manager 的 observe/assist 分支在 butler 下不生效（直接 full 路径），黑名单检查提前到 full 路径同样执行。
- 既有 `guardPaths`（敏感路径）与 rm -rf/sudo 硬阻断不动，且**新增**：terminal 工具命令解析首 token 命中删除类命令 → 拒绝；write_file/patch 的目标路径落在系统目录 → 拒绝。

## 2. Agent 侦察（agent-scout）

新文件 `src/agent-scout.ts`：

- 已知 agent CLI 清单（每项：探测名列表、prompt 模板 `{prompt}`、一行能力描述、详手册 ≤800 字符）：
  claude/claude-code、hermes、opencode、omp、codex、aider、gemini、qwen、goose、crush（模板不全的用 `<bin> --help 生成`占位 + LLM 补手册——复用 ToolScout 的手册生成管线）。
- `probe()`：which 逐个探测（Windows 下 where / Get-Command；PATH + 常见安装位 ~/.local/bin、npm global、~/.opencode/bin 等）。
- 探测成功：① orchestrator.cmds[fw] = 模板 ② AgentRegistry 注册（含手册）③ 汇总写 `runtime/AGENTS.md`（一行式清单，decide 常驻注入，模式同 TOOLS.md）④ push 事件 `agents discovered: <names>` 唤醒首个 decide。
- `assembleAndStart`：与 ToolScout 首扫并行后台跑一次；之后由 jex 自己的 toolscout/agent 动作刷新。

## 3. 启动即醒（boot recon）

`assembleAndStart`：start() 后 ~3 秒安排 `runOnce("boot: 刚启动——盘点系统与可用代理，更新对环境的认知；若无待办则建立今日目标")`。不等第一个完整 tick。Electron 桌面双击 → 3 秒后 jex 已在工作。

## 4. 管家提示词（gears.ts loopPrompt 重写）

统一管家人格 + 挡位差异（自主度/花销纪律），核心内容：

- 你是 RoboJex，用户的常驻机器人管家。你不亲自干活：观察（patrol）→ 决策（decide）→ **派活给代理**（AGENTS.md 里的可用仆人）→ **验收** → 沉淀经验。
- 任务板即甘特图：spawn 时给 dueAt/scheduledAt 排程；没有就绪任务的空闲周期选择：`reflect`（总结经验）/ 补验收 / 优化 MISSION。
- **spawn 必须带 accept（验收标准）**：一句可客观判定的成功判据。
- 完成的任务必须 verify：用只读工具核实产出，verdict pass/fail；fail → 记录原因并决定重派/放弃（写入任务 resultSummary）。
- 挡位语气：eco 极简少动 / balanced 稳健经营 / focused 主动推进 / turbo 自我发起+自审+全速。

chatPrompt（直聊人格）同步微调为管家口吻（我是管家，可以替你派活——直接说事即可，不用 /jex 前缀的引导改为自然语言承诺）。

## 5. 反思动作（reflect）

decide 动作集新增 `{type:'reflect', text}`：
- 校验 text 非空（≤4KB）。
- 效果：`MEMORY.md` 追加带时间戳条目（`## YYYY-MM-DD HH:mm` + text）——管家的经验本； auditor 快照照旧（改写前 git 快照已有）。
- push 事件 `reflected: <前 80 字>`（进活动流，用户可见"AI 在总结"）。

## 6. 验收闭环强化

- **spawn 兜底**：decide 给的 spawn 无 accept 时，acceptance 兜底 = prompt 前 80 字 + "（jex 须在完成后用只读工具 verify 并给出 verdict）"——保证每个任务都有验收线。
- **dueAt 复查（task_due 泵）**：事件泵（现有 due_spawn 同层）每 tick 扫板上 `scheduledAt<=now` 的 running 任务到期（dueAt 已过且未 done/blocked）→ push `task due: <title> — 检查进度，催办或重派`。挡位决定 tick 频率，自然实现"按挡位定时检查任务完成情况"。

## 7. UI 指挥中心（packages/web）

- 新视图 `command`（指挥中心）设为**默认**：左 2/3 甘特任务板（BoardView 升级：dueAt/scheduledAt 时间带、进度环、verdict 徽章、状态泳道），右 1/3 实时思考日志流（decide reasoning 轨迹 + cycle 事件 + reflect 条目，复用 Activity 数据源但突出思考）。
- Chat 保留（顶栏切换），用户"交代事情"仍走聊天或任务板快捷新建。
- 顶栏挡位快切已有；侧栏 jex 状态卡显示当前 policy（butler/conservative 徽标）。

## 8. 验收

- vitest 全绿（新策略矩阵/agent-scout 探测/reflect 动作/task_due 泵/提示词快照）；tsc 0 错。
- 活体：起真服务 → 3s 内首周期日志 → AGENTS.md 生成（WSL 有 claude? 无——探测到 hermes? 也无 → 清单为空也正常，事件仍发）→ /jex 派活无审批直通（butler）→ 删除类命令被拒 → reflect 写 MEMORY → 到期任务被催。
- e2e/probe 回归全绿；Electron 重打包回桌面。

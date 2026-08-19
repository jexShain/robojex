# RoboJex 原始需求文档

> 本文档记录项目从构思到发布的全部原始需求(按提出顺序),以及每条需求的落地状态。需求原文为中文口语,此处按原意整理;落地决策与需求有出入处均已标注。

## 一、框架本体(robojex,初名 rbj)

**定位**:一个开源 agent 框架——常驻、自我发起、元学习的「CEO 循环」。

| # | 需求 | 落地 |
|---|---|---|
| 1 | CEO 不亲自干活:主 agent 只做编排与决策,把工作派给 sub-agent,自己的上下文保持干净 | ✅ AgentOrchestrator 派发;sub-agent 完整输出**永不**进入 CEO 上下文,只回填一行摘要到任务板 |
| 2 | 常驻、自我发起:没有用户指令也要自己找活干 | ✅ SchedulerLoop 定时 patrol(屏幕/任务板/webhook 事件)→ 自主 decide 下一动作 |
| 3 | 元学习:从执行结果中改进自己 | ✅ MISSION.md / RUBRIC.md / MEMORY.md 三文件自演化;审计器在改写前做 git 快照(历史可回溯);LLM 审计生成改进补丁 |
| 4 | 「忽略安全边界」(原始原话) | ⚠️ 部分采纳:执行侧不做额外说教式限制,**但保留两条不可协商硬底线**——`rm -rf` 与 `sudo` 在所有模式下硬阻断;人类操作永远优先于 AI(输入抢占)。理由:前者不可逆,后者是远程裸机部署的基本安全要求 |
| 5 | 双预算模式:token 无限燃烧,或按日预算控制 | ✅ budgetMode: `burn` / `budgeted`(dailyTokens,按日滚动);**所有** LLM 调用(巡逻/决策/摘要/审计/ToolScout/触手手册)全部记账,含失败重试 |
| 6 | 桌面控制:远程桌面式服务 | ✅ takeoverd 守护进程(WebSocket :7600):屏幕采集(pHash 去重、OCR 可选)、键鼠注入、模式状态机、热键 |
| 7 | 内置浏览器:CDP 接管本机 Chrome | ✅ 本地 Chrome 调试端口可用时自动接入;CEO 通过 `cdp` 动作驱动浏览器(仅非 observe 模式) |
| 8 | 三种接管模式:完全接管 / 半接管 / 屏幕学习观察 | ✅ `observe`(只看不碰,注入代码级禁用)→ `assist`(半接管)→ `full`(完全接管),Shift+Ctrl 热键循环切换;**每次启动固定落在 observe** |
| 9 | 自带 hermes / claude-code 手册,让这些现成 agent 干活 | ✅ `skills/hermes.md`、`skills/claude-code.md`;spawn 决策时按提及注入对应手册;CEO 只做编排 |
| 10 | 屏幕学习:观察理解屏幕内容 | ✅ observe 模式 1fps 轮询截图 + pHash 去重;OCR(opt-in)文本进事件流 |
| 11 | 人类优先 | ✅ 人类键鼠活动检测到即抢占(输入静默期判定),AI 注入暂停 |

## 二、ToolScout(自主工具侦察)

| # | 需求 | 落地 |
|---|---|---|
| 1 | 自主发现系统上的工具 | ✅ 首次启动后台扫描 101 个候选工具,逐个验证可用性 |
| 2 | 自测试 | ✅ 每个工具真实执行探针命令,验证版本/可用,失败即弃 |
| 3 | 自安装(用户级,不动系统) | ✅ npm `-g` / pip `--user` 自动装;需要 apt/sudo 的**绝不执行**,只排入 `PENDING_INSTALLS.md` 等人来装 |
| 4 | 一行简介进默认上下文,完整手册按需加载 | ✅ TOOLS.md(一行式清单)常驻 CEO 上下文;spawn 时提及的工具注入 ≤800 字符手册 |

## 三、Tentacles(百宝箱触手)

| # | 需求 | 落地 |
|---|---|---|
| 1 | 插件式连接器,对接各种 API、接口、硬件 | ✅ 双层:`runtime/tentacles/` 下 JSON spec(声明式)+ `.mjs` 插件(过程式) |
| 2 | 自优化 | ✅ 每个触手由 LLM 生成使用手册,探测结果反哺;CEO 经 `tentacle_call` 直接调用 |
| 3 | 用户对接外部服务要简单 | ✅ OpenAPI 文档一键导入(校验后仅 http(s));硬件自动扫描(lsusb / 串口 / 摄像头 / HID)注册为触手 |
| 4 | 外部系统能唤醒 CEO | ✅ webhook 服务器(:7610)`POST /t/<name>` 路由进 CEO 事件队列,懒启动 |
| 5 | 密钥安全 | ✅ spec 只存环境变量**名**,不存值;Authorization 自动补 Bearer;请求/响应 64KB 截断 |

## 四、发布与验证

| # | 需求 | 落地 |
|---|---|---|
| 1 | 推 GitHub 开源 | ✅ `jexShain/robojex`,master 默认分支(main 已删) |
| 2 | Win/Mac/Linux 三平台打包二进制 | ✅ 单文件二进制(linux/macos/win × x64/arm64,共 5 target):esbuild 零依赖捆包 + pkg;better-sqlite3 → node:sqlite 迁移后才真正达成零 native 依赖 |
| 3 | 在测试机上验证 | ✅ 10.10.7.69(UOS,无 node、无 git、无 X 的裸机)二进制部署:takeoverd 降级常驻、CEO 真模型(DeepSeek)完整跑通 patrol→decide→spawn→done |
| 4 | 无 git 裸机也要能跑 | ✅ git 缺失全程降级(内嵌历史禁用 + 警告),不崩溃 |
| 5 | GitHub Actions 自动发布 | ✅ 打 `v*` tag → 五平台构建 + 测试 + 挂 Release;v0.1.0 已发布并实测 |

## 附:测试机验证记录(v0.1.0)

- 环境:UOS Desktop 20(Deepin),x86_64,内核 4.19,无 node / git / DISPLAY / xinput / xprintidle / tesseract
- takeoverd:`listening on :7600, mode=observe` 常驻,所有外部命令缺失均降级不崩
- robojex-ceo:DeepSeek 真模型驱动完整循环;任务板终态 `[{"title":"Hello Agent","status":"done","resultSummary":"…remote fake Hermes completed."}]`
- git 缺失场景启动崩溃 → 修复(`8932e60`)后重验通过

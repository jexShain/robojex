# i18n 术语表 / Glossary

维护规则：新增词条时 zh.ts 与 en.ts 必须同步加 key（`test/i18n.test.ts` 断言两字典 key 集合完全一致）。本表是翻译的权威术语对照，改词先改这里。

| 中文 | English | 说明 |
| --- | --- | --- |
| 管家 | Butler | 管家模式 = Butler mode（写类工具直通） |
| 保守 | Conservative | 保守模式 = Conservative mode（写类工具需审批） |
| 挡位 | Gear | 自主挡位 = autonomy gear |
| 指挥中心 | Command Center | 默认视图（甘特板 + 思考日志） |
| 对话 | Chat | 视图名 |
| 任务板 | Board | 视图名（不译 Task Board，用 Board） |
| 日历 | Calendar | 视图名（Agenda 视图） |
| 活动 | Activity | 视图名 |
| 驾驶舱 | Cockpit | 挡位驾驶舱视图 |
| 思考流 | Thinking Stream | reasoning 轨迹面板 |
| 思考日志 | Think log | 指挥中心右侧日志 |
| 甘特 | Gantt | widget 标签页 |
| 挡位名：休眠 | Dormant | 😴 |
| 挡位名：省电 | Eco | 🌱 |
| 挡位名：均衡 | Balanced | ⚖️ |
| 挡位名：专注 | Focused | 🎯 |
| 挡位名：狂暴 | Turbo | 🚀 |
| 直连 | Direct | 浏览器直连模式 / Direct chat（直连会话标题） |
| 本地网关 | Local Gateway | 连接模式之一 |
| 回执 | receipt | 命令回执 = command receipt（/lang 等本地回显） |
| 置顶 | Pin / Pinned | 会话分组 📌 |
| 近 7 天 | Last 7 days | 会话分组 |
| 更早 | Older | 会话分组 |
| 泳道：待办 / 进行中 / 受阻 / 已完成 | To do / In progress / Blocked / Done | 指挥中心泳道 |
| 派发 | Spawn / dispatched | jex 派发子代理 |
| 验收 | Verify | verdict 语义 |
| 反思 | Reflection / reflect | decide 动作 |
| 未排程 | Unscheduled | 甘特未排程区 |
| 已排程 | scheduled | 时间带计数 |
| 时间带 | Timeline | 指挥中心 7 天横带 |
| 预算燃料 | Budget fuel | 驾驶舱预算条 |
| 今日消耗 | Today's usage | 用量图 |
| 常驻 AI | resident AI | 品牌副标 |
| 常驻桌面 AI 系统 | resident desktop AI | 顶栏品牌 title |
| 新对话 | New chat | |
| 会话 | Conversation | 命令面板分组 |
| 动作 | Actions | 命令面板分组 |
| 主题：浅色 / 深色 / 跟随系统 | Light / Dark / System | |
| 语言：中文 / 英文 / 跟随系统 | Chinese / English / System | |
| 思考中… / 已思考 Xs | Thinking… / Thought for Xs | 聊天思考折叠条 |
| 回到底部 | Back to bottom | |
| 编辑并重发 | Edit & resend | |
| 重新生成 | Regenerate | |
| 停止生成 | Stop generating | |
| 已暂存 | Staged | 日历拖拽改期（等后端端点） |
| 进度环 | rings | widget 标签页 |
| 已连接 / 连接中 / 重连中 | Live / Connecting… / Reconnecting… | WS 状态 |
| 心跳 | heartbeat | HUD/侧栏呼吸点 |

## 不翻的内容（边界）

- 命令 token：`/gear`、`/lang`、`/jex` 等斜杠命令本身与参数枚举（zh|en|system、dormant…）。
- 后端推送文本：`reflected:`、`chat_out` 内容、任务标题、模型名、verdict 原值（pass/partial/fail/unchecked）。
- 技术量纲：tok、tick、ms、fps、WS、OCR、Gantt 几何标签。
- SettingsView.tsx / settings.css 由设置视图自治（同样使用 i18n 契约）。

## 基建备忘

- 存储：`localStorage['robojex-lang']` = `'zh' | 'en' | 'system'`（缺省 system）。
- `system` → `navigator.language` 以 `zh` 开头则 zh，否则 en。
- 当前语言镜像到 `document.documentElement.dataset.lang`（CSS 选择器 `[data-lang='en']` 可用）。
- 非 React 桥：`i18n/event.ts` 的 `langSnapshot()` / `setLangPref()` / `translate()` / `fill()`。
- 插值：字典值里的 `{n}` `{name}` 等 token 用 `fill(t(key), { n, name })` 填充。

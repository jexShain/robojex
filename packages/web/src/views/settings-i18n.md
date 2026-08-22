# settings-i18n — SettingsView 新增 i18n key 清单

SettingsView 的全部文案走本地字典 `S{zh,en}`（key 与未来全局字典一致）。
主会话合并时把下表三列并入 `src/i18n/zh.ts` / `en.ts`，然后把组件内的本地字典切换为 `t()` 即可（key 不变）。
共 156 个 key（zh 156 / en 156）。

| key | zh | en |
| --- | --- | --- |
| `settings.title` | 设置 | Settings |
| `settings.close` | 关闭 | Close |
| `settings.loading` | 加载设置中… | Loading settings… |
| `settings.unavailable` | 设置不可用 — 检查后端连接后重试 | Settings unavailable — check the backend connection and retry |
| `settings.loadFailed` | 加载设置失败 | Failed to load settings |
| `settings.saveFailed` | 保存失败 | Save failed |
| `settings.saved` | 已保存，部分项重启后端后生效 | Saved — some items apply after a backend restart |
| `settings.savedLocal` | 直连设置已保存（仅本机浏览器） | Direct settings saved (this browser only) |
| `settings.savedPrefs` | 已清除 {n} 项本地偏好，重载页面后完全生效 | Cleared {n} local prefs — fully applies after a reload |
| `settings.convsCleared` | 已清除全部会话（{n} 个） | Cleared all conversations ({n}) |
| `settings.convsClearFailed` | 清除会话失败 | Failed to clear conversations |
| `settings.saving` | 保存中… | Saving… |
| `settings.save` | 保存 | Save |
| `settings.dirty` | ● 有未保存的修改 | ● Unsaved changes |
| `settings.clean` | 无未保存修改 | No unsaved changes |
| `settings.restartNote` | 重启视图后生效 | applies after the view restarts |
| `settings.desktopBadge` | 桌面版 | Desktop |
| `settings.nav.general` | 通用 | General |
| `settings.nav.appearance` | 外观 | Appearance |
| `settings.nav.chat` | 聊天 | Chat |
| `settings.nav.butler` | 管家 | Butler |
| `settings.nav.provider` | 连接 | Connection |
| `settings.nav.data` | 数据 | Data |
| `settings.nav.shortcuts` | 快捷键 | Shortcuts |
| `settings.nav.about` | 关于 | About |
| `settings.general.title` | 通用 | General |
| `settings.general.desc` | 语言、启动行为与桌面版选项。 | Language, startup behavior and desktop options. |
| `settings.general.lang` | 语言 | Language |
| `settings.general.lang.zh` | 中文 | 中文 |
| `settings.general.lang.en` | English | English |
| `settings.general.lang.system` | 跟随系统 | Follow system |
| `settings.general.langHint` | 界面语言即时切换 | UI language switches instantly |
| `settings.general.startView` | 启动时打开 | Open on launch |
| `settings.general.startView.last` | 记忆上次视图 | Remember last view |
| `settings.general.startView.command` | 总是指挥中心 | Always Command Center |
| `settings.general.startView.chat` | 总是对话 | Always Chat |
| `settings.general.startViewHint` | 下次打开界面时生效 | Applies the next time the view opens |
| `settings.general.desktop` | 桌面版行为 | Desktop behavior |
| `settings.general.desktopHint` | 由桌面壳配置决定，只读展示 | Determined by the desktop shell — read-only |
| `settings.general.autostart` | 开机自启 | Launch at login |
| `settings.general.autostart.v` | 未启用 | Off |
| `settings.general.closeBehavior` | 关闭按钮 | Close button |
| `settings.general.closeBehavior.v` | 隐藏到托盘 | Hide to tray |
| `settings.appearance.title` | 外观 | Appearance |
| `settings.appearance.desc` | 主题、密度与字号，即时生效。 | Theme, density and font size — instant. |
| `settings.appearance.theme` | 主题 | Theme |
| `settings.appearance.theme.light` | 浅色 | Light |
| `settings.appearance.theme.dark` | 深色 | Dark |
| `settings.appearance.theme.system` | 跟随系统 | Follow system |
| `settings.appearance.themeHint` | 与顶栏主题按钮同源 | Same source as the top-bar theme button |
| `settings.appearance.density` | 界面密度 | Density |
| `settings.appearance.density.cozy` | 舒适 | Comfortable |
| `settings.appearance.density.compact` | 紧凑 | Compact |
| `settings.appearance.densityHint` | 紧凑模式收窄设置卡片间距 | Compact tightens settings-card spacing |
| `settings.appearance.fontSize` | 字号 | Font size |
| `settings.appearance.fontSize.default` | 默认 | Default |
| `settings.appearance.fontSize.large` | 大 | Large |
| `settings.appearance.fontSizeHint` | 设置界面即时生效，全局排版待后续接入 | Instant inside settings; global type pending |
| `settings.chat.title` | 聊天 | Chat |
| `settings.chat.desc` | 默认模型、默认挡位与输入行为。 | Default model, default gear and input behavior. |
| `settings.chat.model` | 默认模型 | Default model |
| `settings.chat.modelHint` | 立即生效（存于本机，新会话使用） | Immediate (stored locally; used by new chats) |
| `settings.chat.modelEmpty` | 列表为空 — 后端 /api/models 未返回（仍可经 /model 命令设置） | List empty — /api/models returned nothing (set via /model anyway) |
| `settings.chat.modelCount` | 共 {n} 个可用模型 | {n} models available |
| `settings.chat.gear` | 默认挡位 | Default gear |
| `settings.chat.gearHint` | 热切换：立即改变 jex 自主频率 | Hot switch: retimes the jex loop instantly |
| `settings.chat.enterSend` | Enter 发送 | Enter to send |
| `settings.chat.enterSend.on` | 开 · Enter 发送，Shift+Enter 换行 | On · Enter sends, Shift+Enter newline |
| `settings.chat.enterSend.off` | 关 · Enter 换行，Ctrl+Enter 发送 | Off · Enter newline, Ctrl+Enter sends |
| `settings.chat.enterSendHint` | 输入栏接入后生效 | Applies once the input bar wires it up |
| `settings.butler.title` | 管家 | Butler |
| `settings.butler.desc` | jex 的自主策略与挡位表。 | jex's autonomy policy and gear table. |
| `settings.butler.policy` | 自主策略 | Autonomy policy |
| `settings.butler.policy.butler` | 管家模式 | Butler mode |
| `settings.butler.policy.butler.desc` | 最大自主（黑名单制）：白名单外皆可做，仅黑名单动作需审批 | Max autonomy (blacklist): everything allowed except blacklisted actions |
| `settings.butler.policy.conservative` | 保守模式 | Conservative |
| `settings.butler.policy.conservative.desc` | 写操作需审批：改动文件 / 执行命令前先问你 | Writes need approval: file changes / commands ask first |
| `settings.butler.policyHint` | 保存后热生效，无需重启 | Hot-applies on save — no restart needed |
| `settings.butler.gears` | 自主挡位表 | Autonomy gears |
| `settings.butler.gear.name` | 挡位 | Gear |
| `settings.butler.gear.tick` | 决策间隔 | Tick |
| `settings.butler.gear.desc` | 说明 | Description |
| `settings.butler.gear.cost` | 花销 | Cost |
| `settings.butler.gear.stopped` | 停 | stopped |
| `settings.butler.more.title` | 如何提高自主性 | How to raise autonomy |
| `settings.butler.more.body` | 安装更多代理 CLI（claude-code / opencode / omp 等）即可扩展 jex 可驱动的执行器 — 重启后会被自动发现并纳入派发池；挡位越高，jex 越愿意自我发起任务。 | Install more agent CLIs (claude-code / opencode / omp …) to widen the executor pool jex can drive — they are auto-discovered on restart; the higher the gear, the more jex self-initiates. |
| `settings.provider.title` | 连接 | Connection |
| `settings.provider.desc` | 连接模式、LLM 凭据、模型与预算。 | Connection mode, LLM credentials, models and budget. |
| `settings.provider.mode` | 连接模式 | Connection mode |
| `settings.provider.mode.gateway` | 本地网关 | Local gateway |
| `settings.provider.mode.gateway.desc` | 默认 · key 由后端保管 | Default · backend holds the key |
| `settings.provider.mode.direct` | 浏览器直连 | Browser direct |
| `settings.provider.mode.direct.desc` | 兜底 · 输入自己的 key | Fallback · bring your own key |
| `settings.provider.modeHint` | 直连时由渲染进程直接请求 DeepSeek，不经过本地服务 | Direct mode calls DeepSeek from the renderer, bypassing the local service |
| `settings.provider.direct.baseUrl` | 直连 Base URL | Direct base URL |
| `settings.provider.direct.baseUrlHint` | OpenAI 兼容端点（POST /chat/completions） | OpenAI-compatible endpoint (POST /chat/completions) |
| `settings.provider.direct.apiKey` | 直连 API Key | Direct API key |
| `settings.provider.direct.apiKeySaved` | sk-…（已保存 — 重新输入可覆盖） | sk-… (saved — retype to override) |
| `settings.provider.direct.apiKeyHint` | key 仅存本机浏览器、直连时不经过本地服务 | Key lives in this browser only; never sent through the local service |
| `settings.provider.direct.model` | 直连模型 | Direct model |
| `settings.provider.direct.modelHint` | 留空沿用当前聊天模型（{model}） | Empty follows the current chat model ({model}) |
| `settings.provider.direct.note` | 兜底模式取舍：会话与消息仅存于本页、刷新后丢失；会话列表 / 挡位等后端功能不可用，仅聊天流可用。 | Fallback tradeoffs: conversations live in this page only and die on refresh; backend features (list / gears) are unavailable — chat streaming still works. |
| `settings.provider.gateway` | 本地网关 | Local gateway |
| `settings.provider.gatewayHint` | key 由后端保管，界面只显示掩码 | Backend holds the key; the UI shows a mask only |
| `settings.provider.baseUrl` | API Base URL | API base URL |
| `settings.provider.baseUrlHint` | LLM 提供商端点 | LLM provider endpoint |
| `settings.provider.apiKey` | API Key | API key |
| `settings.provider.apiKeyCurrent` | 当前：{key} — 留空保持不变 | Current: {key} — leave empty to keep |
| `settings.provider.apiKeyWillSubmit` | 将提交新 key | A new key will be submitted |
| `settings.provider.apiKeyRule` | 仅当以 sk- 开头才会在保存时提交 | Only keys starting with sk- are submitted on save |
| `settings.provider.apiKeyNone` | 未设置 | not set |
| `settings.provider.modelSlots` | 后端模型两槽 | Backend model slots |
| `settings.provider.modelSlotsHint` | 巡逻 / 决策使用的模型（重启后端后生效） | Models used for patrol / decide (applies after backend restart) |
| `settings.provider.patrolModel` | 巡逻模型 | Patrol model |
| `settings.provider.decideModel` | 决策模型 | Decide model |
| `settings.provider.budget` | 预算 | Budget |
| `settings.provider.budget.burn` | burn 不设限 | burn unlimited |
| `settings.provider.budget.burn.desc` | 不设限燃烧 | No cap |
| `settings.provider.budget.budgeted` | budgeted 按日封顶 | budgeted daily cap |
| `settings.provider.budget.budgeted.desc` | 按日封顶 | Daily token cap |
| `settings.provider.dailyTokens` | 每日 token 上限 | Daily token cap |
| `settings.provider.dailyTokensOk` | budgeted 模式下生效的正整数 | Positive integer, effective in budgeted mode |
| `settings.provider.dailyTokensBad` | 请输入正整数（token 数） | Enter a positive integer (tokens) |
| `settings.provider.connState` | 后端连接状态 | Backend connection |
| `settings.provider.connStateHint` | 由后端配置决定，只读展示 | Determined by backend config — read-only |
| `settings.provider.takeoverUrl` | takeover URL | takeover URL |
| `settings.provider.apiPort` | API 端口 | API port |
| `settings.provider.apiHost` | API 主机 | API host |
| `settings.provider.ws` | WS 状态 | WS state |
| `settings.data.title` | 数据 | Data |
| `settings.data.desc` | 会话存储与本地偏好。 | Conversation storage and local prefs. |
| `settings.data.storage` | 会话存储 | Conversation storage |
| `settings.data.storageBody` | 会话与消息保存在本机 chat.sqlite（由本地服务管理），不经任何云端。 | Conversations and messages live in the local chat.sqlite (managed by the local service) — never in any cloud. |
| `settings.data.clearConvs` | 清除全部会话 | Delete all conversations |
| `settings.data.clearConvs.confirm` | 确认清除 {n} 个会话？再点一次执行 | Delete {n} conversations? Click again to confirm |
| `settings.data.clearConvs.running` | 清除中… | Deleting… |
| `settings.data.clearConvsHint` | 逐条删除服务端全部会话，不可恢复 | Deletes every server-side conversation, one by one — irreversible |
| `settings.data.clearPrefs` | 清 UI 本地偏好 | Clear UI local prefs |
| `settings.data.clearPrefsHint` | 清除主题 / 密度 / 直连等本地设置（保留语言） | Clears theme / density / direct-mode prefs (keeps language) |
| `settings.shortcuts.title` | 快捷键 | Shortcuts |
| `settings.shortcuts.desc` | 标注（桌面版）的仅在桌面端生效，其余为界面内快捷键。 | Rows marked (Desktop) only apply to the desktop shell; the rest work in-app. |
| `settings.shortcuts.cmdk` | 命令面板 | Command palette |
| `settings.shortcuts.esc` | 关闭弹层 | Close overlay |
| `settings.shortcuts.newline` | 换行 | Newline |
| `settings.shortcuts.history` | 输入历史 | Input history |
| `settings.shortcuts.slash` | 命令菜单（输入 / 触发） | Command menu (type /) |
| `settings.shortcuts.at` | 挡位提及（输入 @ 触发） | Gear mention (type @) |
| `settings.shortcuts.altSpace` | 迷你问答窗（桌面版） | Mini ask window (Desktop) |
| `settings.shortcuts.showMain` | 显示主窗（桌面版） | Show main window (Desktop) |
| `settings.shortcuts.newChat` | 新对话（桌面版菜单） | New chat (Desktop menu) |
| `settings.about.title` | 关于 | About |
| `settings.about.desc` | 常驻桌面的人工智能系统：直聊（DeepSeek 流式）+ jex 编排循环（任务板 / 巡逻 / 派发 sub-agent）+ 自主挡位。 | A resident desktop AI: direct chat (DeepSeek streaming) + the jex orchestration loop (task board / patrol / sub-agent dispatch) + autonomy gears. |
| `settings.about.version` | 版本 | Version |
| `settings.about.model` | 当前模型 | Current model |
| `settings.about.github` | GitHub 仓库 | GitHub repository |
| `settings.about.spec` | 桌面版规格文档 | Desktop spec |

// packages/web/src/views/SettingsView.tsx — ChatGPT-style settings center.
// Left category nav (general / appearance / chat / butler / provider / data /
// shortcuts / about) + right grouped form cards. Two storage tiers:
//  · server settings (baseUrl / masked key / model slots / budget / policy)
//    — draft + dirty patch via PUT /api/settings, save button lights up
//  · renderer prefs (lang / start view / density / font size / enter-send /
//    direct mode) — localStorage, applied instantly, no save round-trip
// Copy is bilingual through a local dict S{zh,en} keyed by the eventual
// `settings.*` i18n keys (see views/settings-i18n.md); useT().lang picks the
// side. Esc and backdrop click close; toast reports save results.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../state/api'
import { useStore } from '../state/store'
import type { Settings } from '../state/types'
import { Icon, gearIcon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { gearsOrFallback } from './gearDefs'
import { setThemePref, themeSnapshot, THEME_EVENT } from '../state/theme'
import type { ThemePref } from '../state/theme'
import { useT } from '../i18n'
import '../styles/settings.css'

/* ───────────────────── local i18n (merge target: src/i18n) ─────────────────────
 * Every key here is a future `settings.*` entry in the global dictionaries.
 * SEN is typed as Record<keyof typeof SZH, string> so a missing English line
 * is a compile error. Mirrored in views/settings-i18n.md. */

const SZH = {
    'settings.title': '设置',
    'settings.close': '关闭',
    'settings.loading': '加载设置中…',
    'settings.unavailable': '设置不可用 — 检查后端连接后重试',
    'settings.loadFailed': '加载设置失败',
    'settings.saveFailed': '保存失败',
    'settings.saved': '已保存，部分项重启后端后生效',
    'settings.savedLocal': '直连设置已保存（仅本机浏览器）',
    'settings.savedPrefs': '已清除 {n} 项本地偏好，重载页面后完全生效',
    'settings.convsCleared': '已清除全部会话（{n} 个）',
    'settings.convsClearFailed': '清除会话失败',
    'settings.saving': '保存中…',
    'settings.save': '保存',
    'settings.dirty': '● 有未保存的修改',
    'settings.clean': '无未保存修改',
    'settings.restartNote': '重启视图后生效',
    'settings.desktopBadge': '桌面版',

    'settings.nav.general': '通用',
    'settings.nav.appearance': '外观',
    'settings.nav.chat': '聊天',
    'settings.nav.butler': '管家',
    'settings.nav.provider': '连接',
    'settings.nav.data': '数据',
    'settings.nav.shortcuts': '快捷键',
    'settings.nav.about': '关于',

    'settings.general.title': '通用',
    'settings.general.desc': '语言、启动行为与桌面版选项。',
    'settings.general.lang': '语言',
    'settings.general.lang.zh': '中文',
    'settings.general.lang.en': 'English',
    'settings.general.lang.system': '跟随系统',
    'settings.general.langHint': '界面语言即时切换',
    'settings.general.startView': '启动时打开',
    'settings.general.startView.last': '记忆上次视图',
    'settings.general.startView.command': '总是指挥中心',
    'settings.general.startView.chat': '总是对话',
    'settings.general.startViewHint': '下次打开界面时生效',
    'settings.general.desktop': '桌面版行为',
    'settings.general.desktopHint': '由桌面壳配置决定，只读展示',
    'settings.general.autostart': '开机自启',
    'settings.general.autostart.v': '未启用',
    'settings.general.closeBehavior': '关闭按钮',
    'settings.general.closeBehavior.v': '隐藏到托盘',

    'settings.appearance.title': '外观',
    'settings.appearance.desc': '主题、密度与字号，即时生效。',
    'settings.appearance.theme': '主题',
    'settings.appearance.theme.light': '浅色',
    'settings.appearance.theme.dark': '深色',
    'settings.appearance.theme.system': '跟随系统',
    'settings.appearance.themeHint': '与顶栏主题按钮同源',
    'settings.appearance.density': '界面密度',
    'settings.appearance.density.cozy': '舒适',
    'settings.appearance.density.compact': '紧凑',
    'settings.appearance.densityHint': '紧凑模式收窄设置卡片间距',
    'settings.appearance.fontSize': '字号',
    'settings.appearance.fontSize.default': '默认',
    'settings.appearance.fontSize.large': '大',
    'settings.appearance.fontSizeHint': '设置界面即时生效，全局排版待后续接入',

    'settings.chat.title': '聊天',
    'settings.chat.desc': '默认模型、默认挡位与输入行为。',
    'settings.chat.model': '默认模型',
    'settings.chat.modelHint': '立即生效（存于本机，新会话使用）',
    'settings.chat.modelEmpty': '列表为空 — 后端 /api/models 未返回（仍可经 /model 命令设置）',
    'settings.chat.modelCount': '共 {n} 个可用模型',
    'settings.chat.gear': '默认挡位',
    'settings.chat.gearHint': '热切换：立即改变 jex 自主频率',
    'settings.chat.enterSend': 'Enter 发送',
    'settings.chat.enterSend.on': '开 · Enter 发送，Shift+Enter 换行',
    'settings.chat.enterSend.off': '关 · Enter 换行，Ctrl+Enter 发送',
    'settings.chat.enterSendHint': '输入栏接入后生效',
    'settings.chat.notify': '管家系统通知',
    'settings.chat.notify.on': '开 · 简报落在未打开的会话时弹系统通知',
    'settings.chat.notify.off': '关 · 仅用会话徽标提醒',
    'settings.chat.notifyHint': '仅桌面版生效（浏览器环境自动跳过）',

    'settings.butler.title': '管家',
    'settings.butler.desc': 'jex 的自主策略与挡位表。',
    'settings.butler.policy': '自主策略',
    'settings.butler.policy.butler': '管家模式',
    'settings.butler.policy.butler.desc': '最大自主（黑名单制）：白名单外皆可做，仅黑名单动作需审批',
    'settings.butler.policy.conservative': '保守模式',
    'settings.butler.policy.conservative.desc': '写操作需审批：改动文件 / 执行命令前先问你',
    'settings.butler.policyHint': '保存后热生效，无需重启',
    'settings.butler.gears': '自主挡位表',
    'settings.butler.gear.name': '挡位',
    'settings.butler.gear.tick': '决策间隔',
    'settings.butler.gear.desc': '说明',
    'settings.butler.gear.cost': '花销',
    'settings.butler.gear.stopped': '停',
    'settings.butler.more.title': '如何提高自主性',
    'settings.butler.more.body':
      '安装更多代理 CLI（claude-code / opencode / omp 等）即可扩展 jex 可驱动的执行器 — 重启后会被自动发现并纳入派发池；挡位越高，jex 越愿意自我发起任务。',

    'settings.provider.title': '连接',
    'settings.provider.desc': '连接模式、LLM 凭据、模型与预算。',
    'settings.provider.mode': '连接模式',
    'settings.provider.mode.gateway': '本地网关',
    'settings.provider.mode.gateway.desc': '默认 · key 由后端保管',
    'settings.provider.mode.direct': '浏览器直连',
    'settings.provider.mode.direct.desc': '兜底 · 输入自己的 key',
    'settings.provider.modeHint': '直连时由渲染进程直接请求 DeepSeek，不经过本地服务',
    'settings.provider.direct.baseUrl': '直连 Base URL',
    'settings.provider.direct.baseUrlHint': 'OpenAI 兼容端点（POST /chat/completions）',
    'settings.provider.direct.apiKey': '直连 API Key',
    'settings.provider.direct.apiKeySaved': 'sk-…（已保存 — 重新输入可覆盖）',
    'settings.provider.direct.apiKeyHint': 'key 仅存本机浏览器、直连时不经过本地服务',
    'settings.provider.direct.model': '直连模型',
    'settings.provider.direct.modelHint': '留空沿用当前聊天模型（{model}）',
    'settings.provider.direct.note':
      '兜底模式取舍：会话与消息仅存于本页、刷新后丢失；会话列表 / 挡位等后端功能不可用，仅聊天流可用。',
    'settings.provider.gateway': '本地网关',
    'settings.provider.gatewayHint': 'key 由后端保管，界面只显示掩码',
    'settings.provider.baseUrl': 'API Base URL',
    'settings.provider.baseUrlHint': 'LLM 提供商端点',
    'settings.provider.apiKey': 'API Key',
    'settings.provider.apiKeyCurrent': '当前：{key} — 留空保持不变',
    'settings.provider.apiKeyWillSubmit': '将提交新 key',
    'settings.provider.apiKeyRule': '仅当以 sk- 开头才会在保存时提交',
    'settings.provider.apiKeyNone': '未设置',
    'settings.provider.modelSlots': '后端模型两槽',
    'settings.provider.modelSlotsHint': '巡逻 / 决策使用的模型（重启后端后生效）',
    'settings.provider.patrolModel': '巡逻模型',
    'settings.provider.decideModel': '决策模型',
    'settings.provider.thinking': '思考模式',
    'settings.provider.thinking.on': '开 · 模型先推理再作答，思考过程显示在聊天气泡里（更慢、更耗 token）',
    'settings.provider.thinking.off': '关 · 直接作答（默认，更快更省）',
    'settings.provider.budget': '预算',
    'settings.provider.budget.burn': 'burn 不设限',
    'settings.provider.budget.burn.desc': '不设限燃烧',
    'settings.provider.budget.budgeted': 'budgeted 按日封顶',
    'settings.provider.budget.budgeted.desc': '按日封顶',
    'settings.provider.dailyTokens': '每日 token 上限',
    'settings.provider.dailyTokensOk': 'budgeted 模式下生效的正整数',
    'settings.provider.dailyTokensBad': '请输入正整数（token 数）',
    'settings.provider.connState': '后端连接状态',
    'settings.provider.connStateHint': '由后端配置决定，只读展示',
    'settings.provider.takeoverUrl': 'takeover URL',
    'settings.provider.apiPort': 'API 端口',
    'settings.provider.apiHost': 'API 主机',
    'settings.provider.ws': 'WS 状态',

    'settings.data.title': '数据',
    'settings.data.desc': '会话存储与本地偏好。',
    'settings.data.storage': '会话存储',
    'settings.data.storageBody': '会话与消息保存在本机 chat.sqlite（由本地服务管理），不经任何云端。',
    'settings.data.clearConvs': '清除全部会话',
    'settings.data.clearConvs.confirm': '确认清除 {n} 个会话？再点一次执行',
    'settings.data.clearConvs.running': '清除中…',
    'settings.data.clearConvsHint': '逐条删除服务端全部会话，不可恢复',
    'settings.data.clearPrefs': '清 UI 本地偏好',
    'settings.data.clearPrefsHint': '清除主题 / 密度 / 直连等本地设置（保留语言）',

    'settings.shortcuts.title': '快捷键',
    'settings.shortcuts.desc': '标注（桌面版）的仅在桌面端生效，其余为界面内快捷键。',
    'settings.shortcuts.cmdk': '命令面板',
    'settings.shortcuts.views': '切换视图（指挥中心→驾驶舱）',
    'settings.shortcuts.esc': '关闭弹层',
    'settings.shortcuts.newline': '换行',
    'settings.shortcuts.history': '输入历史',
    'settings.shortcuts.slash': '命令菜单（输入 / 触发）',
    'settings.shortcuts.at': '挡位提及（输入 @ 触发）',
    'settings.shortcuts.altSpace': '迷你问答窗（桌面版）',
    'settings.shortcuts.showMain': '显示主窗（桌面版）',
    'settings.shortcuts.newChat': '新对话（桌面版菜单）',

    'settings.about.title': '关于',
    'settings.about.desc': '常驻桌面的人工智能系统：直聊（DeepSeek 流式）+ jex 编排循环（任务板 / 巡逻 / 派发 sub-agent）+ 自主挡位。',
    'settings.about.version': '版本',
    'settings.about.model': '当前模型',
    'settings.about.github': 'GitHub 仓库',
    'settings.about.spec': '桌面版规格文档',
}
type SKey = keyof typeof SZH
const SEN: Record<SKey, string> = {
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.loading': 'Loading settings…',
  'settings.unavailable': 'Settings unavailable — check the backend connection and retry',
  'settings.loadFailed': 'Failed to load settings',
  'settings.saveFailed': 'Save failed',
  'settings.saved': 'Saved — some items apply after a backend restart',
  'settings.savedLocal': 'Direct settings saved (this browser only)',
  'settings.savedPrefs': 'Cleared {n} local prefs — fully applies after a reload',
  'settings.convsCleared': 'Cleared all conversations ({n})',
  'settings.convsClearFailed': 'Failed to clear conversations',
  'settings.saving': 'Saving…',
  'settings.save': 'Save',
  'settings.dirty': '● Unsaved changes',
  'settings.clean': 'No unsaved changes',
  'settings.restartNote': 'applies after the view restarts',
  'settings.desktopBadge': 'Desktop',

  'settings.nav.general': 'General',
  'settings.nav.appearance': 'Appearance',
  'settings.nav.chat': 'Chat',
  'settings.nav.butler': 'Butler',
  'settings.nav.provider': 'Connection',
  'settings.nav.data': 'Data',
  'settings.nav.shortcuts': 'Shortcuts',
  'settings.nav.about': 'About',

  'settings.general.title': 'General',
  'settings.general.desc': 'Language, startup behavior and desktop options.',
  'settings.general.lang': 'Language',
  'settings.general.lang.zh': '中文',
  'settings.general.lang.en': 'English',
  'settings.general.lang.system': 'Follow system',
  'settings.general.langHint': 'UI language switches instantly',
  'settings.general.startView': 'Open on launch',
  'settings.general.startView.last': 'Remember last view',
  'settings.general.startView.command': 'Always Command Center',
  'settings.general.startView.chat': 'Always Chat',
  'settings.general.startViewHint': 'Applies the next time the view opens',
  'settings.general.desktop': 'Desktop behavior',
  'settings.general.desktopHint': 'Determined by the desktop shell — read-only',
  'settings.general.autostart': 'Launch at login',
  'settings.general.autostart.v': 'Off',
  'settings.general.closeBehavior': 'Close button',
  'settings.general.closeBehavior.v': 'Hide to tray',

  'settings.appearance.title': 'Appearance',
  'settings.appearance.desc': 'Theme, density and font size — instant.',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.theme.light': 'Light',
  'settings.appearance.theme.dark': 'Dark',
  'settings.appearance.theme.system': 'Follow system',
  'settings.appearance.themeHint': 'Same source as the top-bar theme button',
  'settings.appearance.density': 'Density',
  'settings.appearance.density.cozy': 'Comfortable',
  'settings.appearance.density.compact': 'Compact',
  'settings.appearance.densityHint': 'Compact tightens settings-card spacing',
  'settings.appearance.fontSize': 'Font size',
  'settings.appearance.fontSize.default': 'Default',
  'settings.appearance.fontSize.large': 'Large',
  'settings.appearance.fontSizeHint': 'Instant inside settings; global type pending',

  'settings.chat.title': 'Chat',
  'settings.chat.desc': 'Default model, default gear and input behavior.',
  'settings.chat.model': 'Default model',
  'settings.chat.modelHint': 'Immediate (stored locally; used by new chats)',
  'settings.chat.modelEmpty': 'List empty — /api/models returned nothing (set via /model anyway)',
  'settings.chat.modelCount': '{n} models available',
  'settings.chat.gear': 'Default gear',
  'settings.chat.gearHint': 'Hot switch: retimes the jex loop instantly',
  'settings.chat.enterSend': 'Enter to send',
  'settings.chat.enterSend.on': 'On · Enter sends, Shift+Enter newline',
  'settings.chat.enterSend.off': 'Off · Enter newline, Ctrl+Enter sends',
  'settings.chat.enterSendHint': 'Applies once the input bar wires it up',
  'settings.chat.notify': 'Butler system notifications',
  'settings.chat.notify.on': 'On · OS notification when a briefing lands in an unopened conversation',
  'settings.chat.notify.off': 'Off · in-app conversation badges only',
  'settings.chat.notifyHint': 'Desktop shell only (browsers skip it automatically)',

  'settings.butler.title': 'Butler',
  'settings.butler.desc': "jex's autonomy policy and gear table.",
  'settings.butler.policy': 'Autonomy policy',
  'settings.butler.policy.butler': 'Butler mode',
  'settings.butler.policy.butler.desc': 'Max autonomy (blacklist): everything allowed except blacklisted actions',
  'settings.butler.policy.conservative': 'Conservative',
  'settings.butler.policy.conservative.desc': 'Writes need approval: file changes / commands ask first',
  'settings.butler.policyHint': 'Hot-applies on save — no restart needed',
  'settings.butler.gears': 'Autonomy gears',
  'settings.butler.gear.name': 'Gear',
  'settings.butler.gear.tick': 'Tick',
  'settings.butler.gear.desc': 'Description',
  'settings.butler.gear.cost': 'Cost',
  'settings.butler.gear.stopped': 'stopped',
  'settings.butler.more.title': 'How to raise autonomy',
  'settings.butler.more.body':
    'Install more agent CLIs (claude-code / opencode / omp …) to widen the executor pool jex can drive — they are auto-discovered on restart; the higher the gear, the more jex self-initiates.',

  'settings.provider.title': 'Connection',
  'settings.provider.desc': 'Connection mode, LLM credentials, models and budget.',
  'settings.provider.mode': 'Connection mode',
  'settings.provider.mode.gateway': 'Local gateway',
  'settings.provider.mode.gateway.desc': 'Default · backend holds the key',
  'settings.provider.mode.direct': 'Browser direct',
  'settings.provider.mode.direct.desc': 'Fallback · bring your own key',
  'settings.provider.modeHint': 'Direct mode calls DeepSeek from the renderer, bypassing the local service',
  'settings.provider.direct.baseUrl': 'Direct base URL',
  'settings.provider.direct.baseUrlHint': 'OpenAI-compatible endpoint (POST /chat/completions)',
  'settings.provider.direct.apiKey': 'Direct API key',
  'settings.provider.direct.apiKeySaved': 'sk-… (saved — retype to override)',
  'settings.provider.direct.apiKeyHint': 'Key lives in this browser only; never sent through the local service',
  'settings.provider.direct.model': 'Direct model',
  'settings.provider.direct.modelHint': 'Empty follows the current chat model ({model})',
  'settings.provider.direct.note':
    'Fallback tradeoffs: conversations live in this page only and die on refresh; backend features (list / gears) are unavailable — chat streaming still works.',
  'settings.provider.gateway': 'Local gateway',
  'settings.provider.gatewayHint': 'Backend holds the key; the UI shows a mask only',
  'settings.provider.baseUrl': 'API base URL',
  'settings.provider.baseUrlHint': 'LLM provider endpoint',
  'settings.provider.apiKey': 'API key',
  'settings.provider.apiKeyCurrent': 'Current: {key} — leave empty to keep',
  'settings.provider.apiKeyWillSubmit': 'A new key will be submitted',
  'settings.provider.apiKeyRule': 'Only keys starting with sk- are submitted on save',
  'settings.provider.apiKeyNone': 'not set',
  'settings.provider.modelSlots': 'Backend model slots',
  'settings.provider.modelSlotsHint': 'Models used for patrol / decide (applies after backend restart)',
  'settings.provider.patrolModel': 'Patrol model',
  'settings.provider.decideModel': 'Decide model',
  'settings.provider.thinking': 'Thinking mode',
  'settings.provider.thinking.on': 'On · the model reasons before answering; reasoning shows in the chat bubble (slower, more tokens)',
  'settings.provider.thinking.off': 'Off · answer directly (default — faster and cheaper)',
  'settings.provider.budget': 'Budget',
  'settings.provider.budget.burn': 'burn unlimited',
  'settings.provider.budget.burn.desc': 'No cap',
  'settings.provider.budget.budgeted': 'budgeted daily cap',
  'settings.provider.budget.budgeted.desc': 'Daily token cap',
  'settings.provider.dailyTokens': 'Daily token cap',
  'settings.provider.dailyTokensOk': 'Positive integer, effective in budgeted mode',
  'settings.provider.dailyTokensBad': 'Enter a positive integer (tokens)',
  'settings.provider.connState': 'Backend connection',
  'settings.provider.connStateHint': 'Determined by backend config — read-only',
  'settings.provider.takeoverUrl': 'takeover URL',
  'settings.provider.apiPort': 'API port',
  'settings.provider.apiHost': 'API host',
  'settings.provider.ws': 'WS state',

  'settings.data.title': 'Data',
  'settings.data.desc': 'Conversation storage and local prefs.',
  'settings.data.storage': 'Conversation storage',
  'settings.data.storageBody': 'Conversations and messages live in the local chat.sqlite (managed by the local service) — never in any cloud.',
  'settings.data.clearConvs': 'Delete all conversations',
  'settings.data.clearConvs.confirm': 'Delete {n} conversations? Click again to confirm',
  'settings.data.clearConvs.running': 'Deleting…',
  'settings.data.clearConvsHint': 'Deletes every server-side conversation, one by one — irreversible',
  'settings.data.clearPrefs': 'Clear UI local prefs',
  'settings.data.clearPrefsHint': 'Clears theme / density / direct-mode prefs (keeps language)',

  'settings.shortcuts.title': 'Shortcuts',
  'settings.shortcuts.desc': 'Rows marked (Desktop) only apply to the desktop shell; the rest work in-app.',
  'settings.shortcuts.cmdk': 'Command palette',
  'settings.shortcuts.views': 'Switch view (command → cockpit)',
  'settings.shortcuts.esc': 'Close overlay',
  'settings.shortcuts.newline': 'Newline',
  'settings.shortcuts.history': 'Input history',
  'settings.shortcuts.slash': 'Command menu (type /)',
  'settings.shortcuts.at': 'Gear mention (type @)',
  'settings.shortcuts.altSpace': 'Mini ask window (Desktop)',
  'settings.shortcuts.showMain': 'Show main window (Desktop)',
  'settings.shortcuts.newChat': 'New chat (Desktop menu)',

  'settings.about.title': 'About',
  'settings.about.desc': 'A resident desktop AI: direct chat (DeepSeek streaming) + the jex orchestration loop (task board / patrol / sub-agent dispatch) + autonomy gears.',
  'settings.about.version': 'Version',
  'settings.about.model': 'Current model',
  'settings.about.github': 'GitHub repository',
  'settings.about.spec': 'Desktop spec',
}

const S: { zh: Record<SKey, string>; en: Record<SKey, string> } = { zh: SZH, en: SEN }

/* ───────────────────── renderer-local pref helpers (pure) ───────────────────── */

export type StartView = 'last' | 'command' | 'chat'
export type Density = 'cozy' | 'compact'
export type FontSizePref = 'default' | 'large'

export const STARTVIEW_KEY = 'robojex-startview'
export const DENSITY_KEY = 'robojex-density'
export const FONTSIZE_KEY = 'robojex-fontsize'
export const ENTERSEND_KEY = 'robojex-enter-send'

/** All robojex-* localStorage keys this UI writes. 'robojex-lang' is excluded
 * from clears on purpose (language survives a prefs reset). */
export const LOCAL_PREF_KEYS: readonly string[] = [
  STARTVIEW_KEY,
  DENSITY_KEY,
  FONTSIZE_KEY,
  ENTERSEND_KEY,
  api.NOTIFY_SYS_KEY,
  'robojex-theme',
  'robojex-model',
  'robojex-direct',
]

export function parseStartView(raw: string | null): StartView {
  return raw === 'command' || raw === 'chat' ? raw : 'last'
}

export function parseDensity(raw: string | null): Density {
  return raw === 'compact' ? 'compact' : 'cozy'
}

export function parseFontSize(raw: string | null): FontSizePref {
  return raw === 'large' ? 'large' : 'default'
}

/** Enter sends by default ('0' = off → Enter newlines, Ctrl+Enter sends). */
export function parseEnterSend(raw: string | null): boolean {
  return raw !== '0'
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    // best-effort
  }
}

/** Apply density + font-size to body dataset (idempotent). */
export function applyBodyPrefs(density: Density, fontsize: FontSizePref): void {
  document.body.dataset.density = density
  document.body.dataset.fontsize = fontsize
}

/** Remove every robojex-* key except the language pref; returns how many
 * were removed. Pure w.r.t. the storage object passed (tests inject a map). */
export function clearLocalPrefs(
  storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage,
  extraKeys: readonly string[] = LOCAL_PREF_KEYS,
): number {
  let n = 0
  for (const k of extraKeys) {
    if (storage.getItem(k) !== null) {
      storage.removeItem(k)
      n++
    }
  }
  return n
}

/* ───────────────────── static data ───────────────────── */

const GITHUB_URL = 'https://github.com/jexShain/robojex'
const SPEC_URL = `${GITHUB_URL}/blob/master/docs/SPEC-DESKTOP.md`
const TECH_STACK = 'React 18 · TypeScript · Vite · Electron · ceo-core (Node.js) · DeepSeek API'

type SecId = 'general' | 'appearance' | 'chat' | 'butler' | 'provider' | 'data' | 'shortcuts' | 'about'

const SECTIONS: { id: SecId; icon: IconName; labelKey: SKey }[] = [
  { id: 'general', icon: 'settings', labelKey: 'settings.nav.general' },
  { id: 'appearance', icon: 'sun', labelKey: 'settings.nav.appearance' },
  { id: 'chat', icon: 'message', labelKey: 'settings.nav.chat' },
  { id: 'butler', icon: 'scale', labelKey: 'settings.nav.butler' },
  { id: 'provider', icon: 'zap', labelKey: 'settings.nav.provider' },
  { id: 'data', icon: 'database', labelKey: 'settings.nav.data' },
  { id: 'shortcuts', icon: 'terminal', labelKey: 'settings.nav.shortcuts' },
  { id: 'about', icon: 'gauge', labelKey: 'settings.nav.about' },
]

const SHORTCUTS: { keys: string[]; descKey: SKey }[] = [
  { keys: ['Ctrl', 'K'], descKey: 'settings.shortcuts.cmdk' },
  { keys: ['Ctrl', '1–6'], descKey: 'settings.shortcuts.views' },
  { keys: ['Esc'], descKey: 'settings.shortcuts.esc' },
  { keys: ['Shift', 'Enter'], descKey: 'settings.shortcuts.newline' },
  { keys: ['↑', '↓'], descKey: 'settings.shortcuts.history' },
  { keys: ['/'], descKey: 'settings.shortcuts.slash' },
  { keys: ['@'], descKey: 'settings.shortcuts.at' },
  { keys: ['Alt', 'Space'], descKey: 'settings.shortcuts.altSpace' },
  { keys: ['Ctrl', 'Shift', 'J'], descKey: 'settings.shortcuts.showMain' },
  { keys: ['Ctrl', 'N'], descKey: 'settings.shortcuts.newChat' },
]

/** Grouped form card (module-level so React keeps the subtree mounted —
 * an inline component would remount inputs on every keystroke). */
function Card({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="st-card">
      <div className="st-card-head">
        <span className="st-card-title">{title}</span>
        {desc ? <span className="st-card-desc">{desc}</span> : null}
      </div>
      <div className="st-card-body">{children}</div>
    </div>
  )
}

interface Draft {
  baseUrl: string
  patrolModel: string
  decideModel: string
  budgetMode: 'burn' | 'budgeted'
  dailyTokens: string
  policy: 'butler' | 'conservative'
  thinking: boolean
}

/** Direct-connection draft — localStorage-backed, kept separate from the
 * backend Draft so it stays editable while the gateway is unreachable. */
interface DirectDraft {
  mode: 'gateway' | 'direct'
  baseUrl: string
  model: string
}

type Toast = { tone: 'ok' | 'err'; msg: string } | null

export function SettingsView({ onClose }: { onClose(): void }) {
  const store = useStore()
  const { state } = store
  const { lang, pref: langPref, setPref: setLangPref } = useT()
  const s = useCallback(
    (key: SKey): string => (lang === 'en' ? S.en : S.zh)[key],
    [lang],
  )
  const fmt = (key: SKey, vars: Record<string, string | number>): string =>
    s(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))

  const [sec, setSec] = useState<SecId>('general')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Draft>({
    baseUrl: '',
    patrolModel: '',
    decideModel: '',
    budgetMode: 'burn',
    dailyTokens: '',
    policy: 'butler',
    thinking: false,
  })
  const [directDraft, setDirectDraft] = useState<DirectDraft>(() => ({
    mode: state.direct.mode,
    baseUrl: state.direct.baseUrl,
    model: state.direct.model,
  }))
  const [directKeyInput, setDirectKeyInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<Toast>(null)

  /* renderer-local prefs — instant apply, no save round-trip */
  const [startView, setStartView] = useState<StartView>(() => parseStartView(readPref(STARTVIEW_KEY)))
  const [density, setDensity] = useState<Density>(() => parseDensity(readPref(DENSITY_KEY)))
  const [fontsize, setFontsize] = useState<FontSizePref>(() => parseFontSize(readPref(FONTSIZE_KEY)))
  const [enterSend, setEnterSend] = useState<boolean>(() => parseEnterSend(readPref(ENTERSEND_KEY)))
  const [notifySys, setNotifySys] = useState<boolean>(() => api.readNotifySys())
  const [themePref, setThemePrefState] = useState<ThemePref>(() => themeSnapshot().pref)

  /* data-section state */
  const [clearArmed, setClearArmed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearArmedTimer = useRef<number | null>(null)

  const showToast = useCallback((tone: 'ok' | 'err', msg: string) => {
    setToast({ tone, msg })
    window.setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 4000)
  }, [])

  // Load settings (+ model list) on mount.
  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getSettings()
      .then((sv) => {
        if (!alive) return
        setSettings(sv)
        setDraft({
          baseUrl: sv.baseUrl,
          patrolModel: sv.patrolModel,
          decideModel: sv.decideModel,
          budgetMode: sv.budgetMode,
          dailyTokens: String(sv.dailyTokens),
          policy: sv.policy ?? 'butler',
          thinking: sv.thinking ?? false,
        })
      })
      .catch((err: unknown) => {
        if (alive) showToast('err', `${s('settings.loadFailed')}：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    void store.refreshModels()
    return () => {
      alive = false
      if (clearArmedTimer.current !== null) window.clearTimeout(clearArmedTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // density / font-size prefs live on body dataset (settings cards react
  // instantly; other surfaces can adopt the same attributes later)
  useEffect(() => {
    applyBodyPrefs(density, fontsize)
  }, [density, fontsize])

  // Theme pref stays in sync with every switch path (this modal, the top-bar
  // toggle re-reads on section open, slash commands / palette via the event).
  useEffect(() => {
    const onTheme = (): void => setThemePrefState(themeSnapshot().pref)
    window.addEventListener(THEME_EVENT, onTheme)
    return () => window.removeEventListener(THEME_EVENT, onTheme)
  }, [])

  // Re-read the theme pref whenever the appearance section opens — covers
  // top-bar toggles that happened while the modal was closed.
  useEffect(() => {
    if (sec === 'appearance') setThemePrefState(themeSnapshot().pref)
  }, [sec])

  // Esc closes (focus lives inside the modal, so the keydown lands here).
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const tokensNum = Number(draft.dailyTokens)
  const tokensValid =
    draft.budgetMode === 'burn' || (Number.isInteger(tokensNum) && tokensNum > 0)
  const apiKeyReady = apiKeyInput.trim().startsWith('sk-')

  // Minimal dirty patch — only fields that actually changed.
  const patch = useMemo<Partial<Settings>>(() => {
    const p: Partial<Settings> = {}
    if (!settings) return p
    if (draft.baseUrl.trim() !== settings.baseUrl) p.baseUrl = draft.baseUrl.trim()
    if (apiKeyReady) p.apiKey = apiKeyInput.trim()
    if (draft.patrolModel.trim() !== settings.patrolModel) p.patrolModel = draft.patrolModel.trim()
    if (draft.decideModel.trim() !== settings.decideModel) p.decideModel = draft.decideModel.trim()
    if (draft.budgetMode !== settings.budgetMode) p.budgetMode = draft.budgetMode
    if (draft.budgetMode === 'budgeted' && tokensValid && tokensNum !== settings.dailyTokens) {
      p.dailyTokens = tokensNum
    }
    if ((settings.policy ?? 'butler') !== draft.policy) p.policy = draft.policy
    if ((settings.thinking ?? false) !== draft.thinking) p.thinking = draft.thinking
    return p
  }, [settings, draft, apiKeyInput, apiKeyReady, tokensNum, tokensValid])

  // Direct-mode dirty patch — same minimal-diff idea against localStorage.
  const directPatch = useMemo<Partial<api.DirectPrefs>>(() => {
    const p: Partial<api.DirectPrefs> = {}
    if (directDraft.mode !== state.direct.mode) p.mode = directDraft.mode
    if (directDraft.baseUrl.trim() !== state.direct.baseUrl) p.baseUrl = directDraft.baseUrl.trim()
    if (directDraft.model.trim() !== state.direct.model) p.model = directDraft.model.trim()
    if (directKeyInput.trim()) p.apiKey = directKeyInput.trim()
    return p
  }, [directDraft, directKeyInput, state.direct])

  const dirty = Object.keys(patch).length > 0 || Object.keys(directPatch).length > 0
  const canSave = dirty && tokensValid && !saving && !loading

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    // direct prefs persist to localStorage FIRST — the fallback must stay
    // configurable even when the gateway (and its REST save) is unreachable
    if (Object.keys(directPatch).length > 0) {
      store.setDirectPrefs(directPatch)
      const next = { ...state.direct, ...directPatch }
      setDirectDraft({ mode: next.mode, baseUrl: next.baseUrl, model: next.model })
      setDirectKeyInput('')
    }
    if (Object.keys(patch).length === 0) {
      showToast('ok', s('settings.savedLocal'))
      setSaving(false)
      return
    }
    api
      .putSettings(patch)
      .then(() => api.getSettings())
      .then((sv) => {
        setSettings(sv)
        setDraft({
          baseUrl: sv.baseUrl,
          patrolModel: sv.patrolModel,
          decideModel: sv.decideModel,
          budgetMode: sv.budgetMode,
          dailyTokens: String(sv.dailyTokens),
          policy: sv.policy ?? 'butler',
          thinking: sv.thinking ?? false,
        })
        setApiKeyInput('')
        showToast('ok', s('settings.saved'))
      })
      .catch((err: unknown) => {
        showToast('err', `${s('settings.saveFailed')}：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setSaving(false))
  }

  /* ── instant pref setters ── */
  const pickStartView = (v: StartView): void => {
    setStartView(v)
    writePref(STARTVIEW_KEY, v)
  }
  const pickDensity = (v: Density): void => {
    setDensity(v)
    writePref(DENSITY_KEY, v)
    applyBodyPrefs(v, fontsize)
  }
  const pickFontsize = (v: FontSizePref): void => {
    setFontsize(v)
    writePref(FONTSIZE_KEY, v)
    applyBodyPrefs(density, v)
  }
  const toggleEnterSend = (): void => {
    const next = !enterSend
    setEnterSend(next)
    writePref(ENTERSEND_KEY, next ? '1' : '0')
  }
  const toggleNotifySys = (): void => {
    const next = !notifySys
    setNotifySys(next)
    writePref(api.NOTIFY_SYS_KEY, next ? '1' : '0')
  }
  const pickTheme = (v: ThemePref): void => {
    setThemePref(v) // event bridge — same source as /theme and the palette
    setThemePrefState(v)
  }

  /* ── data section actions ── */
  const armClearConvs = (): void => {
    if (clearArmedTimer.current !== null) window.clearTimeout(clearArmedTimer.current)
    setClearArmed(true)
    // disarm after 6s so a stray click can't wait forever
    clearArmedTimer.current = window.setTimeout(() => setClearArmed(false), 6000)
  }

  const clearAllConversations = (): void => {
    if (!clearArmed || clearing) return
    setClearing(true)
    setClearArmed(false)
    api
      .listConversations()
      .then(async (convs) => {
        let failed = 0
        for (const c of convs) {
          try {
            await api.deleteConversation(c.id)
          } catch {
            failed++
          }
        }
        await store.refreshConversations()
        if (failed > 0) throw new Error(`${failed}`)
        showToast('ok', fmt('settings.convsCleared', { n: convs.length }))
      })
      .catch((err: unknown) => {
        showToast(
          'err',
          `${s('settings.convsClearFailed')}：${err instanceof Error ? err.message : String(err)}`,
        )
      })
      .finally(() => setClearing(false))
  }

  const clearUiPrefs = (): void => {
    const n = clearLocalPrefs()
    setStartView(parseStartView(readPref(STARTVIEW_KEY)))
    setDensity(parseDensity(readPref(DENSITY_KEY)))
    setFontsize(parseFontSize(readPref(FONTSIZE_KEY)))
    setEnterSend(parseEnterSend(readPref(ENTERSEND_KEY)))
    setNotifySys(api.readNotifySys())
    applyBodyPrefs(parseDensity(readPref(DENSITY_KEY)), parseFontSize(readPref(FONTSIZE_KEY)))
    showToast('ok', fmt('settings.savedPrefs', { n }))
  }

  const gears = gearsOrFallback(state.gears)
  const models = state.models.includes(state.model) || !state.model
    ? state.models
    : [state.model, ...state.models]
  const convCount = state.conversations.length

  /* Card is module-level; titles/descs arrive pre-translated via s()/fmt() */

  return (
    <div
      className="st-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="st-modal"
        data-testid="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={s('settings.title')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        ref={(el) => el?.focus()}
      >
        <div className="st-head">
          <span className="st-title">
            <Icon name="settings" size={14} /> {s('settings.title')}
          </span>
          <button
            type="button"
            className="st-close"
            title={`${s('settings.close')} (Esc)`}
            aria-label={s('settings.close')}
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="st-body">
          <nav className="st-nav" data-testid="settings-nav" aria-label={s('settings.title')}>
            {SECTIONS.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`st-nav-item${sec === it.id ? ' active' : ''}`}
                data-testid="settings-nav-item"
                data-sec={it.id}
                onClick={() => setSec(it.id)}
              >
                <span className="st-nav-icon">
                  <Icon name={it.icon} size={14} />
                </span>
                <span>{s(it.labelKey)}</span>
              </button>
            ))}
          </nav>

          <div className="st-content">
            {sec === 'general' ? (
              <section className="st-section" data-testid="settings-section" data-sec="general">
                <h3>{s('settings.general.title')}</h3>
                <p className="st-desc">{s('settings.general.desc')}</p>
                <Card title={s('settings.general.lang')} desc={s('settings.general.langHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.general.lang')}>
                    {(
                      [
                        ['zh', 'settings.general.lang.zh'],
                        ['en', 'settings.general.lang.en'],
                        ['system', 'settings.general.lang.system'],
                      ] as const
                    ).map(([v, key]) => (
                      <button
                        key={v}
                        type="button"
                        className={`st-chip${langPref === v ? ' on' : ''}`}
                        role="radio"
                        aria-checked={langPref === v}
                        data-testid={`settings-lang-${v}`}
                        onClick={() => setLangPref(v)}
                      >
                        {s(key)}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title={s('settings.general.startView')} desc={s('settings.general.startViewHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.general.startView')}>
                    {(
                      [
                        ['last', 'settings.general.startView.last'],
                        ['command', 'settings.general.startView.command'],
                        ['chat', 'settings.general.startView.chat'],
                      ] as const
                    ).map(([v, key]) => (
                      <button
                        key={v}
                        type="button"
                        className={`st-chip${startView === v ? ' on' : ''}`}
                        role="radio"
                        aria-checked={startView === v}
                        data-testid={`settings-startview-${v}`}
                        onClick={() => pickStartView(v)}
                      >
                        {s(key)}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title={s('settings.general.desktop')} desc={s('settings.general.desktopHint')}>
                  <div className="st-kv">
                    <span className="k">
                      {s('settings.general.autostart')}
                      <span className="st-badge">{s('settings.desktopBadge')}</span>
                    </span>
                    <span className="v">{s('settings.general.autostart.v')}</span>
                  </div>
                  <div className="st-kv">
                    <span className="k">
                      {s('settings.general.closeBehavior')}
                      <span className="st-badge">{s('settings.desktopBadge')}</span>
                    </span>
                    <span className="v">{s('settings.general.closeBehavior.v')}</span>
                  </div>
                </Card>
              </section>
            ) : sec === 'appearance' ? (
              <section className="st-section" data-testid="settings-section" data-sec="appearance">
                <h3>{s('settings.appearance.title')}</h3>
                <p className="st-desc">{s('settings.appearance.desc')}</p>
                <Card title={s('settings.appearance.theme')} desc={s('settings.appearance.themeHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.appearance.theme')}>
                    {(
                      [
                        ['light', 'settings.appearance.theme.light'],
                        ['dark', 'settings.appearance.theme.dark'],
                        ['system', 'settings.appearance.theme.system'],
                      ] as const
                    ).map(([v, key]) => (
                      <button
                        key={v}
                        type="button"
                        className={`st-chip${themePref === v ? ' on' : ''}`}
                        role="radio"
                        aria-checked={themePref === v}
                        data-testid={`settings-theme-${v}`}
                        onClick={() => pickTheme(v)}
                      >
                        {s(key)}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title={s('settings.appearance.density')} desc={s('settings.appearance.densityHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.appearance.density')}>
                    {(
                      [
                        ['cozy', 'settings.appearance.density.cozy'],
                        ['compact', 'settings.appearance.density.compact'],
                      ] as const
                    ).map(([v, key]) => (
                      <button
                        key={v}
                        type="button"
                        className={`st-chip${density === v ? ' on' : ''}`}
                        role="radio"
                        aria-checked={density === v}
                        data-testid={`settings-density-${v}`}
                        onClick={() => pickDensity(v)}
                      >
                        {s(key)}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title={s('settings.appearance.fontSize')} desc={s('settings.appearance.fontSizeHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.appearance.fontSize')}>
                    {(
                      [
                        ['default', 'settings.appearance.fontSize.default'],
                        ['large', 'settings.appearance.fontSize.large'],
                      ] as const
                    ).map(([v, key]) => (
                      <button
                        key={v}
                        type="button"
                        className={`st-chip${fontsize === v ? ' on' : ''}`}
                        role="radio"
                        aria-checked={fontsize === v}
                        data-testid={`settings-fontsize-${v}`}
                        onClick={() => pickFontsize(v)}
                      >
                        {s(key)}
                      </button>
                    ))}
                  </div>
                </Card>
              </section>
            ) : sec === 'chat' ? (
              <section className="st-section" data-testid="settings-section" data-sec="chat">
                <h3>{s('settings.chat.title')}</h3>
                <p className="st-desc">{s('settings.chat.desc')}</p>
                <Card title={s('settings.chat.model')} desc={s('settings.chat.modelHint')}>
                  <select
                    className="st-input"
                    value={state.model}
                    onChange={(e) => store.setModel(e.target.value)}
                  >
                    {models.length === 0 ? <option value={state.model}>{state.model}</option> : null}
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="st-hint">
                    {state.models.length === 0
                      ? s('settings.chat.modelEmpty')
                      : fmt('settings.chat.modelCount', { n: models.length })}
                  </span>
                </Card>
                <Card title={s('settings.chat.gear')} desc={s('settings.chat.gearHint')}>
                  <div className="st-gear-grid">
                    {gears.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={`st-gear-card${state.gear === g.id ? ' current' : ''}`}
                        onClick={() => void store.changeGear(g.id)}
                        aria-pressed={state.gear === g.id}
                      >
                        <span className="sg-emoji">
                          <Icon name={gearIcon(g.id)} size={18} />
                        </span>
                        <span className="sg-name">{g.name}</span>
                        <span className="sg-id">{g.id} · L{g.level}</span>
                        <span className="sg-desc">{g.desc}</span>
                        <span className="sg-meta">
                          <span>{g.cost}</span>
                          <span>{g.tickMs > 0 ? `${g.tickMs / 1000}s/tick` : s('settings.butler.gear.stopped')}</span>
                          <span>{g.decideMaxTokens > 0 ? `${g.decideMaxTokens} tok` : '—'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title={s('settings.chat.enterSend')} desc={s('settings.chat.enterSendHint')}>
                  <button
                    type="button"
                    className={`st-switch${enterSend ? ' on' : ''}`}
                    role="switch"
                    aria-checked={enterSend}
                    data-testid="settings-entersend"
                    onClick={toggleEnterSend}
                  >
                    <span className="st-switch-knob" />
                  </button>
                  <span className="st-hint">{s(enterSend ? 'settings.chat.enterSend.on' : 'settings.chat.enterSend.off')}</span>
                </Card>
                <Card title={s('settings.chat.notify')} desc={s('settings.chat.notifyHint')}>
                  <button
                    type="button"
                    className={`st-switch${notifySys ? ' on' : ''}`}
                    role="switch"
                    aria-checked={notifySys}
                    data-testid="settings-notify-sys"
                    onClick={toggleNotifySys}
                  >
                    <span className="st-switch-knob" />
                  </button>
                  <span className="st-hint">{s(notifySys ? 'settings.chat.notify.on' : 'settings.chat.notify.off')}</span>
                </Card>
              </section>
            ) : sec === 'butler' ? (
              <section className="st-section" data-testid="settings-section" data-sec="butler">
                <h3>{s('settings.butler.title')}</h3>
                <p className="st-desc">{s('settings.butler.desc')}</p>
                {settings ? (
                  <Card title={s('settings.butler.policy')} desc={s('settings.butler.policyHint')}>
                    <div className="st-radios" role="radiogroup" aria-label={s('settings.butler.policy')}>
                      <button
                        type="button"
                        className={`st-radio${draft.policy === 'butler' ? ' on' : ''}`}
                        role="radio"
                        aria-checked={draft.policy === 'butler'}
                        data-testid="settings-policy-butler"
                        onClick={() => setDraft({ ...draft, policy: 'butler' })}
                      >
                        {/* div keeps icon+label on one flex row (.st-radio span
                            is reserved for the small desc line) */}
                        <div>
                          <Icon name="heart" size={13} /> {s('settings.butler.policy.butler')}
                        </div>
                        <span>{s('settings.butler.policy.butler.desc')}</span>
                      </button>
                      <button
                        type="button"
                        className={`st-radio${draft.policy === 'conservative' ? ' on' : ''}`}
                        role="radio"
                        aria-checked={draft.policy === 'conservative'}
                        data-testid="settings-policy-conservative"
                        onClick={() => setDraft({ ...draft, policy: 'conservative' })}
                      >
                        <div>
                          <Icon name="ban" size={13} /> {s('settings.butler.policy.conservative')}
                        </div>
                        <span>{s('settings.butler.policy.conservative.desc')}</span>
                      </button>
                    </div>
                  </Card>
                ) : null}
                <Card title={s('settings.butler.gears')}>
                  <div className="st-gear-table">
                    <div className="st-gear-tr th">
                      <span>{s('settings.butler.gear.name')}</span>
                      <span>{s('settings.butler.gear.tick')}</span>
                      <span>{s('settings.butler.gear.desc')}</span>
                      <span>{s('settings.butler.gear.cost')}</span>
                    </div>
                    {gears.map((g) => (
                      <div key={g.id} className={`st-gear-tr${state.gear === g.id ? ' cur' : ''}`}>
                        <span className="st-gear-name">
                          <Icon name={gearIcon(g.id)} size={14} /> {g.name}
                        </span>
                        <span className="st-gear-tick">
                          {g.tickMs > 0 ? `${g.tickMs / 1000}s` : s('settings.butler.gear.stopped')}
                        </span>
                        <span className="st-gear-desc">{g.desc}</span>
                        <span className="st-gear-cost">{g.cost}</span>
                      </div>
                    ))}
                  </div>
                </Card>
                <div className="st-card st-card-note">
                  <div className="st-card-head">
                    <span className="st-card-title">
                      <Icon name="brain" size={13} /> {s('settings.butler.more.title')}
                    </span>
                  </div>
                  <div className="st-card-body">
                    <p className="st-note-body">{s('settings.butler.more.body')}</p>
                  </div>
                </div>
              </section>
            ) : sec === 'provider' ? (
              <section className="st-section" data-testid="settings-section" data-sec="provider">
                <h3>{s('settings.provider.title')}</h3>
                <p className="st-desc">{s('settings.provider.desc')}</p>
                <Card title={s('settings.provider.mode')} desc={s('settings.provider.modeHint')}>
                  <div className="st-chip-row" role="radiogroup" aria-label={s('settings.provider.mode')}>
                    <button
                      type="button"
                      className={`st-chip${directDraft.mode === 'gateway' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={directDraft.mode === 'gateway'}
                      data-testid="direct-mode-gateway"
                      onClick={() => setDirectDraft({ ...directDraft, mode: 'gateway' })}
                    >
                      <Icon name="database" size={13} /> {s('settings.provider.mode.gateway')}
                      <em>{s('settings.provider.mode.gateway.desc')}</em>
                    </button>
                    <button
                      type="button"
                      className={`st-chip${directDraft.mode === 'direct' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={directDraft.mode === 'direct'}
                      data-testid="direct-mode-direct"
                      onClick={() => setDirectDraft({ ...directDraft, mode: 'direct' })}
                    >
                      <Icon name="zap" size={13} /> {s('settings.provider.mode.direct')}
                      <em>{s('settings.provider.mode.direct.desc')}</em>
                    </button>
                  </div>
                  {directDraft.mode === 'direct' ? (
                    <div className="st-direct" data-testid="direct-fields">
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.direct.baseUrl')}</span>
                        <input
                          className="st-input"
                          data-testid="direct-baseurl"
                          value={directDraft.baseUrl}
                          placeholder={api.DEFAULT_DIRECT_BASE}
                          spellCheck={false}
                          onChange={(e) => setDirectDraft({ ...directDraft, baseUrl: e.target.value })}
                        />
                        <span className="st-hint">{s('settings.provider.direct.baseUrlHint')}</span>
                      </label>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.direct.apiKey')}</span>
                        <input
                          className="st-input"
                          type="password"
                          data-testid="direct-apikey"
                          value={directKeyInput}
                          placeholder={
                            state.direct.apiKey ? s('settings.provider.direct.apiKeySaved') : 'sk-…'
                          }
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => setDirectKeyInput(e.target.value)}
                        />
                        <span className="st-hint">{s('settings.provider.direct.apiKeyHint')}</span>
                      </label>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.direct.model')}</span>
                        <input
                          className="st-input"
                          data-testid="direct-model"
                          value={directDraft.model}
                          placeholder={state.model}
                          spellCheck={false}
                          onChange={(e) => setDirectDraft({ ...directDraft, model: e.target.value })}
                        />
                        <span className="st-hint">
                          {fmt('settings.provider.direct.modelHint', { model: state.model })}
                        </span>
                      </label>
                      <p className="st-direct-note">{s('settings.provider.direct.note')}</p>
                    </div>
                  ) : null}
                </Card>
                {settings ? (
                  <>
                    <Card title={s('settings.provider.gateway')} desc={s('settings.provider.gatewayHint')}>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.baseUrl')}</span>
                        <input
                          className="st-input"
                          value={draft.baseUrl}
                          placeholder="https://api.deepseek.com/v1"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                        />
                        <span className="st-hint">{s('settings.provider.baseUrlHint')}</span>
                      </label>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.apiKey')}</span>
                        <input
                          className="st-input"
                          type="password"
                          value={apiKeyInput}
                          placeholder={settings.apiKey || 'sk-…'}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => setApiKeyInput(e.target.value)}
                        />
                        <span className="st-hint">
                          {apiKeyInput === ''
                            ? fmt('settings.provider.apiKeyCurrent', {
                                key: settings.apiKey || s('settings.provider.apiKeyNone'),
                              })
                            : apiKeyReady
                              ? s('settings.provider.apiKeyWillSubmit')
                              : s('settings.provider.apiKeyRule')}
                        </span>
                      </label>
                    </Card>
                    <Card title={s('settings.provider.modelSlots')} desc={s('settings.provider.modelSlotsHint')}>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.patrolModel')}</span>
                        <input
                          className="st-input"
                          value={draft.patrolModel}
                          placeholder="deepseek-v4-flash"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, patrolModel: e.target.value })}
                        />
                      </label>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.decideModel')}</span>
                        <input
                          className="st-input"
                          value={draft.decideModel}
                          placeholder="deepseek-v4-flash"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, decideModel: e.target.value })}
                        />
                      </label>
                      <div className="st-field">
                        <span className="st-label">{s('settings.provider.thinking')}</span>
                        <button
                          type="button"
                          className={`st-switch${draft.thinking ? ' on' : ''}`}
                          role="switch"
                          aria-checked={draft.thinking}
                          data-testid="settings-thinking"
                          onClick={() => setDraft({ ...draft, thinking: !draft.thinking })}
                        >
                          <span className="st-switch-knob" />
                        </button>
                        <span className="st-hint">{s(draft.thinking ? 'settings.provider.thinking.on' : 'settings.provider.thinking.off')}</span>
                      </div>
                    </Card>
                    <Card title={s('settings.provider.budget')}>
                      <div className="st-chip-row" role="radiogroup" aria-label={s('settings.provider.budget')}>
                        <button
                          type="button"
                          className={`st-chip${draft.budgetMode === 'burn' ? ' on' : ''}`}
                          role="radio"
                          aria-checked={draft.budgetMode === 'burn'}
                          onClick={() => setDraft({ ...draft, budgetMode: 'burn' })}
                        >
                          <Icon name="zap" size={13} /> {s('settings.provider.budget.burn')}
                        </button>
                        <button
                          type="button"
                          className={`st-chip${draft.budgetMode === 'budgeted' ? ' on' : ''}`}
                          role="radio"
                          aria-checked={draft.budgetMode === 'budgeted'}
                          onClick={() => setDraft({ ...draft, budgetMode: 'budgeted' })}
                        >
                          <Icon name="gauge" size={13} /> {s('settings.provider.budget.budgeted')}
                        </button>
                      </div>
                      <label className="st-field">
                        <span className="st-label">{s('settings.provider.dailyTokens')}</span>
                        <input
                          className="st-input"
                          type="number"
                          min={1}
                          step={1000}
                          value={draft.dailyTokens}
                          disabled={draft.budgetMode === 'burn'}
                          onChange={(e) => setDraft({ ...draft, dailyTokens: e.target.value })}
                        />
                        <span className={`st-hint${tokensValid ? '' : ' err'}`}>
                          {tokensValid
                            ? s('settings.provider.dailyTokensOk')
                            : s('settings.provider.dailyTokensBad')}
                        </span>
                      </label>
                    </Card>
                    <Card title={s('settings.provider.connState')} desc={s('settings.provider.connStateHint')}>
                      <div className="st-kv">
                        <span className="k">{s('settings.provider.takeoverUrl')}</span>
                        <span className="v">{settings.takeoverUrl || '—'}</span>
                      </div>
                      <div className="st-kv">
                        <span className="k">{s('settings.provider.apiPort')}</span>
                        <span className="v">{settings.apiPort}</span>
                      </div>
                      <div className="st-kv">
                        <span className="k">{s('settings.provider.apiHost')}</span>
                        <span className="v">{settings.apiHost}</span>
                      </div>
                      <div className="st-kv">
                        <span className="k">{s('settings.provider.ws')}</span>
                        <span className={`v st-conn ${state.conn}`}>● {state.conn}</span>
                      </div>
                    </Card>
                  </>
                ) : loading ? (
                  <div className="st-loading">{s('settings.loading')}</div>
                ) : (
                  <p className="st-hint">{s('settings.unavailable')}</p>
                )}
              </section>
            ) : sec === 'data' ? (
              <section className="st-section" data-testid="settings-section" data-sec="data">
                <h3>{s('settings.data.title')}</h3>
                <p className="st-desc">{s('settings.data.desc')}</p>
                <Card title={s('settings.data.storage')}>
                  <p className="st-note-body">{s('settings.data.storageBody')}</p>
                </Card>
                <Card title={s('settings.data.clearConvs')} desc={s('settings.data.clearConvsHint')}>
                  <button
                    type="button"
                    className={`st-danger${clearArmed ? ' armed' : ''}`}
                    data-testid="settings-clear-convs"
                    disabled={clearing}
                    onClick={() => (clearArmed ? clearAllConversations() : armClearConvs())}
                  >
                    {clearing
                      ? s('settings.data.clearConvs.running')
                      : clearArmed
                        ? fmt('settings.data.clearConvs.confirm', { n: convCount })
                        : `${s('settings.data.clearConvs')}${convCount > 0 ? ` (${convCount})` : ''}`}
                  </button>
                </Card>
                <Card title={s('settings.data.clearPrefs')} desc={s('settings.data.clearPrefsHint')}>
                  <button
                    type="button"
                    className="st-danger"
                    data-testid="settings-clear-prefs"
                    onClick={clearUiPrefs}
                  >
                    {s('settings.data.clearPrefs')}
                  </button>
                </Card>
              </section>
            ) : sec === 'shortcuts' ? (
              <section className="st-section" data-testid="settings-section" data-sec="shortcuts">
                <h3>{s('settings.shortcuts.title')}</h3>
                <p className="st-desc">{s('settings.shortcuts.desc')}</p>
                <div className="st-keys">
                  {SHORTCUTS.map((it) => (
                    <div className="st-key-row" key={it.descKey}>
                      <span className="st-key-desc">{s(it.descKey)}</span>
                      <span className="st-key-caps">
                        {it.keys.map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section className="st-section" data-testid="settings-section" data-sec="about">
                <h3>{s('settings.about.title')}</h3>
                <div className="st-about">
                  <div className="st-about-orb">
                    <Icon name="gauge" size={26} />
                  </div>
                  <div className="st-about-name">RoboJex</div>
                  <div className="st-about-ver">version {state.version || '—'}</div>
                  <p className="st-about-desc">{s('settings.about.desc')}</p>
                  <div className="st-about-stack">{TECH_STACK}</div>
                  <div className="st-about-kv">
                    <div className="st-kv">
                      <span className="k">{s('settings.about.version')}</span>
                      <span className="v">{state.version || '—'}</span>
                    </div>
                    <div className="st-kv">
                      <span className="k">{s('settings.about.model')}</span>
                      <span className="v">{state.model || '—'}</span>
                    </div>
                  </div>
                  <div className="st-about-links">
                    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                      {s('settings.about.github')} ↗
                    </a>
                    <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
                      {s('settings.about.spec')} ↗
                    </a>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="st-foot">
          <span className={`st-dirty${dirty ? ' on' : ''}`}>
            {saving ? s('settings.saving') : dirty ? s('settings.dirty') : s('settings.clean')}
          </span>
          <button type="button" className="st-save" disabled={!canSave} onClick={save}>
            {saving ? (
              <>
                <Icon name="clock" size={13} /> {s('settings.saving')}
              </>
            ) : (
              <>
                <Icon name="archive" size={13} /> {s('settings.save')}
              </>
            )}
          </button>
        </div>

        {toast ? <div className={`st-toast ${toast.tone}`}>{toast.msg}</div> : null}
      </div>
    </div>
  )
}

export default SettingsView

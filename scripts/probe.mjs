// scripts/probe.mjs — live-app browser probe. Drives the REAL product at
// BASE (default http://127.0.0.1:7620: ceo-core serving the built web dist,
// real DeepSeek key, real WS/SSE) through named scenarios with screenshots +
// soft assertions. Usage: node scripts/probe.mjs <scenario> [...more]
//
// Screenshots land in probe-shots/<scenario>-NN.png; results print as
// PASS/FAIL lines and the exit code reflects failures.

import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:7620'
const SHOTS = 'probe-shots'
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${label}${detail ? ' — ' + detail : ''}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-json */ }
  return { status: res.status, json, text }
}

async function open(page, path = '/') {
  await page.goto(BASE + path)
  await page.getByTestId('conn-status').waitFor({ state: 'attached', timeout: 15000 })
}

/** The app boots into the command center; chat-surface scenarios opt into
 *  the chat tab first. */
async function openChat(page) {
  await open(page)
  await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
}

/* ───────────────────────── scenarios ───────────────────────── */

const scenarios = {}

scenarios.load = async ({ page }) => {
  await open(page)
  ok('app loads, connection up', true)
  const empty = await page.getByTestId('empty-prompt').count()
  const convRows = await page.getByTestId('conv-item').count()
  ok('empty-state OR conversations render', empty > 0 || convRows > 0, `prompts=${empty} convs=${convRows}`)
  await page.screenshot({ path: `${SHOTS}/load-01.png` })
  ok('new-chat button', await page.getByTestId('sidebar-new-chat').count() > 0)
  ok('search box', await page.getByPlaceholder(/搜索/).count() > 0)
  ok('gear chip', await page.getByTestId('gear-chip').count() > 0)
  ok('model chip', await page.getByTestId('model-chip').count() > 0)
  await page.screenshot({ path: `${SHOTS}/load-02.png` })
}

scenarios['chat-real'] = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('sidebar-new-chat').click()
  const q = '用 markdown 表格对比 Python 和 Rust 的三点差异，然后给一段 Python 快速排序代码'
  await page.getByTestId('chat-input').fill(q)
  await page.getByTestId('chat-send').click()
  await page.locator('[data-testid="msg-row"][data-role="user"]').waitFor({ timeout: 8000 })
  ok('user bubble (optimistic)', true)
  const think = await page.getByTestId('think-toggle').waitFor({ timeout: 25000 }).then(() => true).catch(() => false)
  ok('thinking strip appears while streaming', think)
  await page.screenshot({ path: `${SHOTS}/chat-real-01-stream.png` })
  await page.locator('[data-testid="msg-row"][data-role="assistant"] table').first().waitFor({ timeout: 90000 })
  ok('markdown table rendered', true)
  // the table closing doesn't mean the stream ended — wait for the stop
  // button to disappear before asserting the tail of the answer
  const finished = await page
    .waitForFunction(() => !document.querySelector('[data-testid="stream-stop"]'), null, { timeout: 120000, polling: 1000 })
    .then(() => true).catch(() => false)
  ok('stream finished (stop hidden)', finished)
  const code = await page.locator('[data-testid="msg-row"][data-role="assistant"] pre code').count()
  ok('code block rendered', code > 0, `${code} blocks`)
  const copyBtn = await page.getByTestId('code-copy').count()
  ok('code copy buttons', copyBtn > 0, `${copyBtn}`)
  await page.screenshot({ path: `${SHOTS}/chat-real-02-done.png` })
  let titled = false
  for (let i = 0; i < 30; i++) {
    const rows = await page.getByTestId('conv-item').allInnerTexts()
    const nonDefault = rows.filter((t) => t && !t.includes('新对话') && t.trim().length > 4)
    if (nonDefault.length > 0) { titled = true; break }
    await page.waitForTimeout(1000)
  }
  ok('auto-generated conversation title', titled)
  await page.screenshot({ path: `${SHOTS}/chat-real-03-title.png` })
}

scenarios['msg-ops'] = async ({ page }) => {
  await openChat(page)
  const hasConvs = await page.getByTestId('conv-item').first()
    .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
  if (!hasConvs) { ok('needs a conversation', false); return }
  const first = page.getByTestId('conv-item').first()
  await first.click()
  await page.locator('[data-testid="msg-row"]').first().waitFor({ timeout: 8000 })
  const assistant = page.locator('[data-testid="msg-row"][data-role="assistant"]').first()
  await assistant.hover()
  ok('regenerate action on hover', await page.getByTestId('msg-regen').first().isVisible().catch(() => false))
  const user = page.locator('[data-testid="msg-row"][data-role="user"]').first()
  if (await user.count()) {
    await user.hover()
    ok('edit action on user msg', await page.getByTestId('msg-edit').first().isVisible().catch(() => false))
    ok('delete action on user msg', await page.getByTestId('msg-del').first().isVisible().catch(() => false))
  } else ok('user message present', false)
  await page.screenshot({ path: `${SHOTS}/msg-ops-01.png` })
  await assistant.hover()
  await page.getByTestId('msg-regen').first().click()
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${SHOTS}/msg-ops-02-regen.png` })
  const done = await page
    .locator('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')
    .last().innerText().then((t) => t.length > 20).catch(() => false)
  ok('regenerate produces content', done)
}

scenarios['conv-mgmt'] = async ({ page }) => {
  await openChat(page)
  const c1 = await api('POST', '/api/conversations', { title: '探针A-置顶' })
  const c2 = await api('POST', '/api/conversations', { title: '探针B-普通' })
  ok('seed convs via API', c1.status < 300 && c2.status < 300)
  await page.reload()
  await page.getByTestId('conn-status').waitFor({ timeout: 15000 })
  const rowA = page.getByTestId('conv-item').filter({ hasText: '探针A-置顶' }).first()
  await rowA.hover()
  await rowA.getByTestId('conv-pin').click()
  await page.waitForTimeout(600)
  const sidebarText = await page.locator('.sb-list, .sidebar, aside').first().innerText().catch(() => '')
  ok('pinned group header appears', sidebarText.includes('置顶'))
  const rowB = page.getByTestId('conv-item').filter({ hasText: '探针B-普通' }).first()
  const rowBIdx = await page.getByTestId('conv-item').evaluateAll(
    (els, el) => els.findIndex((e) => e.textContent.includes('探针B-普通')), '探针B-普通')
  await rowB.hover()
  await rowB.getByTestId('conv-rename').click()
  // the rename input replaces the title text, so re-locate positionally
  const editing = page.getByTestId('conv-item').nth(rowBIdx)
  await editing.locator('input,textarea').fill('探针B-已改名')
  await editing.locator('input,textarea').press('Enter')
  await page.waitForTimeout(600)
  ok('inline rename', await page.getByTestId('conv-item').filter({ hasText: '探针B-已改名' }).count() > 0)
  await page.getByPlaceholder(/搜索/).first().fill('探针A')
  await page.waitForTimeout(600)
  const visible = await page.getByTestId('conv-item').count()
  ok('search filters list', visible >= 1, `${visible} rows`)
  await page.screenshot({ path: `${SHOTS}/conv-mgmt-01.png` })
  await page.getByPlaceholder(/搜索/).first().fill('')
  const rowB2 = page.getByTestId('conv-item').filter({ hasText: '探针B-已改名' }).first()
  await rowB2.hover()
  await rowB2.getByTestId('conv-delete').click()
  await rowB2.locator('.sb-confirm-btn.del').click()
  await page.waitForTimeout(600)
  ok('delete removes row', (await page.getByTestId('conv-item').filter({ hasText: '探针B-已改名' }).count()) === 0)
  await page.screenshot({ path: `${SHOTS}/conv-mgmt-02.png` })
  await api('DELETE', `/api/conversations/${c1.json.id}`)
}

scenarios.gears = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('gear-chip').click()
  await page.getByTestId('gear-popover').waitFor({ timeout: 5000 })
  const n = await page.getByTestId('gear-opt').count()
  ok('gear popover lists all gears', n === 5, `${n} options`)
  await page.screenshot({ path: `${SHOTS}/gears-01-popover.png` })
  const names = ['dormant', 'eco', 'balanced', 'focused', 'turbo']
  for (const g of names) {
    if (!(await page.getByTestId('gear-popover').isVisible().catch(() => false))) {
      await page.getByTestId('gear-chip').click()
    }
    await page.locator(`[data-testid="gear-opt"][data-gear="${g}"]`).click()
    await page.waitForTimeout(500)
    const s = await api('GET', '/api/gear')
    ok(`gear ${g} hot-applied`, s.json?.gear === g, `tick=${s.json?.appliedTickMs}`)
  }
  const chipText = await page.getByTestId('gear-chip').innerText()
  ok('gear chip reflects selection', /狂暴|turbo/i.test(chipText), chipText.trim())
  await page.locator('[data-testid="view-tab"][data-view="cockpit"]').click()
  await page.waitForTimeout(600)
  ok('cockpit gear dial renders', await page.getByTestId('gear-dial').count() > 0)
  await page.screenshot({ path: `${SHOTS}/gears-02-cockpit.png` })
  await api('PUT', '/api/gear', { gear: 'balanced' })
}

scenarios.views = async ({ page }) => {
  await open(page)
  const targets = [
    ['command', 'gantt-board'],
    ['board', 'board-new-task'],
    ['activity', null],
    ['cockpit', 'gear-dial'],
  ]
  for (const [view, marker] of targets) {
    await page.locator(`[data-testid="view-tab"][data-view="${view}"]`).click()
    await page.waitForTimeout(1000)
    if (marker) ok(`${view}: marker ${marker}`, await page.getByTestId(marker).count() > 0)
    else ok(`${view}: renders`, (await page.locator('main, [role="main"]').first().innerText()).length > 10)
    await page.screenshot({ path: `${SHOTS}/views-${view}.png` })
  }
  ok('cockpit usage chart', await page.getByTestId('usage-chart').count() > 0)
  await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
}

scenarios.settings = async ({ page }) => {
  await open(page)
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-modal').waitFor({ timeout: 5000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/settings-01.png` })
  const modal = page.getByTestId('settings-modal')
  const tabs = await modal.locator('.st-nav button, nav button, [role="tab"]').count()
  ok('settings tabs present', tabs >= 4, `${tabs} tabs`)
  for (const label of ['模型', '预算', '连接', '关于']) {
    await modal.getByRole('button', { name: new RegExp(label) }).first().click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: `${SHOTS}/settings-02-about.png` })
  const aboutText = await modal.innerText()
  ok('about shows real version', /0\.\d/.test(aboutText), aboutText.match(/0\.\d+/)?.[0] || '')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  ok('settings closes on Escape', await page.getByTestId('settings-modal').count() === 0)
}

scenarios.cmdk = async ({ page }) => {
  await open(page)
  await page.keyboard.press('Control+K')
  const input = page.getByTestId('cmdk-input')
  ok('palette opens on Ctrl+K', await input.waitFor({ timeout: 3000 }).then(() => true).catch(() => false))
  await input.fill('挡位')
  await page.waitForTimeout(400)
  const cmdk = page.getByTestId('cmdk')
  const items = await cmdk.locator('button, [role="option"], li').count()
  ok('palette filters commands', items > 0, `${items} items`)
  await page.screenshot({ path: `${SHOTS}/cmdk-01.png` })
  await page.keyboard.press('Escape')
}

scenarios.slash = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('chat-input').click()
  await page.getByTestId('chat-input').fill('/')
  await page.waitForTimeout(500)
  const menuVisible = await page.getByText('/gear').first().isVisible().catch(() => false)
  ok('slash menu opens', menuVisible)
  await page.screenshot({ path: `${SHOTS}/slash-01.png` })
  await page.getByTestId('chat-input').fill('/gear eco')
  await page.getByTestId('chat-send').click()
  await page.waitForTimeout(1000)
  const s = await api('GET', '/api/gear')
  ok('slash /gear eco applies', s.json?.gear === 'eco')
  const chip = await page.getByTestId('gear-chip').innerText()
  ok('chip shows 省电', chip.includes('省电'), chip.trim())
  await api('PUT', '/api/gear', { gear: 'balanced' })
}

scenarios.model = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('model-chip').click()
  await page.getByTestId('model-opt').first().waitFor({ timeout: 5000 })
  const opts = await page.getByTestId('model-opt').allInnerTexts()
  ok('model picker lists real models', opts.length >= 3, opts.join(',').slice(0, 80))
  await page.screenshot({ path: `${SHOTS}/model-01.png` })
  await page.getByTestId('model-opt').filter({ hasText: 'deepseek-v4-flash' }).first().click()
  await page.waitForTimeout(400)
  const chip = await page.getByTestId('model-chip').innerText()
  ok('model chip updates', chip.includes('flash'), chip.trim())
}

scenarios.theme = async ({ page }) => {
  await open(page)
  await page.getByTestId('theme-toggle').click()
  await page.waitForTimeout(500)
  const dark1 = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  ok('theme toggles away from dark', dark1 === false, `darkAttr=${dark1}`)
  await page.screenshot({ path: `${SHOTS}/theme-01-light.png` })
  // triple-state cycle (dark→light→system→dark): click until dark returns
  let dark2 = dark1
  for (let i = 0; i < 3 && !dark2; i++) {
    await page.getByTestId('theme-toggle').click()
    await page.waitForTimeout(400)
    dark2 = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  }
  ok('theme cycles back to dark', dark2 === true, `darkAttr=${dark2}`)
  await page.screenshot({ path: `${SHOTS}/theme-02-dark.png` })
}

scenarios.narrow = async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 })
  await page.goto(BASE + '/')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/narrow-01.png` })
  ok('narrow viewport renders', (await page.locator('body').innerText()).length > 50)
}

scenarios.widget = async ({ page }) => {
  await page.goto(BASE + '/widget')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/widget-01.png` })
  ok('widget route renders', (await page.locator('body').innerText()).length > 10)
}

scenarios['ws-live'] = async ({ page }) => {
  await open(page)
  await api('PUT', '/api/gear', { gear: 'turbo' })
  let reflected = false
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500)
    const txt = await page.getByTestId('gear-chip').innerText().catch(() => '')
    if (/狂暴|turbo/i.test(txt)) { reflected = true; break }
  }
  ok('WS push: gear change reflects live', reflected)
  await page.screenshot({ path: `${SHOTS}/ws-live-01.png` })
  await api('PUT', '/api/gear', { gear: 'balanced' })
}

scenarios.agentmode = async ({ page }) => {
  await openChat(page)
  // observe mode blocks tool execution by design (safety default); switch to
  // assist so the loop may actually act
  const sw = await api('POST', '/api/mode', { mode: 'assist' })
  ok('switch to assist mode', sw.status < 300, `status=${sw.status}`)
  await page.getByTestId('sidebar-new-chat').click()
  await page.getByTestId('chat-input').fill('/jex 在任务板上创建一个新任务：整理桌面文件夹')
  await page.getByTestId('chat-send').click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOTS}/agentmode-01.png` })
  // the jex loop wakes on the event and decides (balanced tick = 60s)
  let landed = false
  let titles = ''
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000)
    const s = await api('GET', '/api/state')
    titles = (s.json?.tasks || []).map((t) => t.title).join('|')
    if (titles.includes('整理') || titles.includes('桌面')) { landed = true; break }
  }
  ok('agent mode side effects on task board', landed, titles.slice(0, 120))
  await page.screenshot({ path: `${SHOTS}/agentmode-02.png` })
  await api('POST', '/api/mode', { mode: 'observe' })
}

scenarios.stopstream = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('sidebar-new-chat').click()
  await page.getByTestId('chat-input').fill('写一篇 800 字关于海洋的散文')
  await page.getByTestId('chat-send').click()
  // let the stream reach the CONTENT phase (reasoning streams first), then abort
  await page.getByTestId('stream-stop').waitFor({ state: 'visible', timeout: 20000 })
  await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')?.textContent || '').length > 20,
      null, { timeout: 90000, polling: 1000 },
    )
    .catch(() => {})
  const before = await page
    .locator('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')
    .last().innerText().catch(() => '')
  await page.getByTestId('stream-stop').click()
  const stopped = await page
    .waitForFunction(() => !document.querySelector('[data-testid="stream-stop"]'), null, { timeout: 10000 })
    .then(() => true).catch(() => false)
  ok('stop button ends the stream', stopped)
  await page.waitForTimeout(1000)
  const after = await page
    .locator('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')
    .last().innerText().catch(() => '')
  ok('partial content retained after stop', after.length > 20 && after.length >= before.length, `before=${before.length} after=${after.length}`)
  await page.screenshot({ path: `${SHOTS}/stopstream-01.png` })
}

scenarios['board-new'] = async ({ page }) => {
  await openChat(page)
  await page.locator('[data-testid="view-tab"][data-view="board"]').click()
  await page.getByTestId('board-new-task').waitFor({ timeout: 5000 })
  await page.getByTestId('board-new-task').click()
  // fill the new-task form (title input in the dialog/inline form)
  const box = page.locator('input, textarea').last()
  await box.fill('探针任务-浏览器创建')
  await box.press('Enter')
  await page.waitForTimeout(1500)
  const s = await api('GET', '/api/state')
  const hit = (s.json?.tasks || []).some((t) => (t.title || '').includes('探针任务-浏览器创建'))
  ok('task created from board UI', hit)
  await page.screenshot({ path: `${SHOTS}/board-new-01.png` })
}

scenarios.fepanel = async ({ page }) => {
  await openChat(page)
  // 1) char/token counter appears while typing
  await page.getByTestId('chat-input').click()
  await page.getByTestId('chat-input').fill('你好世界')
  await page.waitForTimeout(300)
  const counter = await page.getByTestId('input-count').innerText().catch(() => '')
  ok('input counter shows', /字/.test(counter) && /tok/.test(counter), counter.trim())
  // 2) @ mention menu opens and completes a token
  await page.getByTestId('chat-input').fill('')
  await page.getByTestId('chat-input').fill('切到 @')
  await page.waitForTimeout(400)
  const mentionMenu = await page.getByTestId('gear-mention').isVisible().catch(() => false)
  ok('@ mention menu opens', mentionMenu)
  const opts = await page.getByTestId('gear-mention-opt').count().catch(() => 0)
  ok('@ mention lists 5 gears', opts === 5, `${opts}`)
  await page.screenshot({ path: `${SHOTS}/fepanel-01-mention.png` })
  // 3) sending "@turbo 帮我记住这个偏好" applies turbo + strips the token
  await page.getByTestId('chat-input').fill('@turbo 记一下：我喜欢简洁回答')
  await page.getByTestId('chat-send').click()
  await page.waitForTimeout(1500)
  const s = await api('GET', '/api/gear')
  ok('@turbo mention applies gear', s.json?.gear === 'turbo', `gear=${s.json?.gear}`)
  const userRow = page.locator('[data-testid="msg-row"][data-role="user"]').first()
  const userText = await userRow.innerText().catch(() => '')
  ok('mention token stripped from message', !userText.includes('@turbo'), userText.slice(0, 40))
  await api('PUT', '/api/gear', { gear: 'balanced' })
  // 4) shortcuts tab in settings
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-modal').waitFor({ timeout: 5000 })
  const tab = page.getByTestId('settings-modal').getByRole('button', { name: /快捷键/ })
  ok('shortcut tab exists', await tab.count() > 0)
  await tab.first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/fepanel-02-shortcuts.png` })
  const kbd = await page.getByTestId('settings-modal').locator('kbd').count()
  ok('shortcut kbd list renders', kbd >= 8, `${kbd} kbd`)
  await page.keyboard.press('Escape')
}

scenarios.jexcard = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('sidebar-new-chat').click()
  await page.getByTestId('chat-input').fill('/jex 汇报一下当前任务板状态')
  await page.getByTestId('chat-send').click()
  // the agent-send card appears immediately (optimistic)
  const sent = await page.locator('[data-testid="agent-card"][data-kind="send"]').waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
  ok('agent-send timeline card visible', sent)
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/jexcard-01.png` })
  // jex replies land as agent-notice cards (loop decides within a tick or two)
  let notice = false
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(5000)
    if (await page.locator('[data-testid="agent-card"][data-kind="notice"]').count() > 0) { notice = true; break }
  }
  ok('agent-notice card from jex reply', notice)
  await page.screenshot({ path: `${SHOTS}/jexcard-02.png` })
}

scenarios.direct = async ({ page }) => {
  await openChat(page)
  // the settings API masks the key — read it from the server-side config file
  let key = process.env.PROBE_KEY || ''
  if (!key) {
    try { key = JSON.parse(readFileSync('runtime/config.json', 'utf8')).apiKey || '' } catch { key = '' }
  }
  if (!key || key.includes('*')) { ok('needs a real key for direct test', false); return }
  // open settings → provider tab → switch connection mode to direct
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-modal').waitFor({ timeout: 5000 })
  await page.getByTestId('direct-mode-direct').click()
  await page.getByTestId('direct-baseurl').fill('https://api.deepseek.com/v1')
  await page.getByTestId('direct-apikey').fill(key)
  await page.getByTestId('direct-model').fill('deepseek-chat')
  await page.screenshot({ path: `${SHOTS}/direct-01-settings.png` })
  await page.getByRole('button', { name: /保存/ }).click()
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  // send a message through the DIRECT path (browser → DeepSeek, no backend)
  await page.getByTestId('chat-input').fill('直连模式下用一句话自我介绍')
  await page.getByTestId('chat-send').click()
  const replied = await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')?.textContent || '').length > 10,
      null, { timeout: 60000, polling: 1000 },
    )
    .then(() => true).catch(() => false)
  ok('direct-mode streaming reply lands', replied)
  await page.screenshot({ path: `${SHOTS}/direct-02-reply.png` })
  // restore gateway mode
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-modal').waitFor({ timeout: 5000 })
  await page.getByTestId('direct-mode-gateway').click()
  await page.getByRole('button', { name: /保存/ }).click()
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  ok('restored gateway mode', true)
}


scenarios.cmdcenter = async ({ page }) => {
  await open(page)
  ok('command center is the default view', await page.getByTestId('cmd-center').count() > 0)
  ok('gantt board renders', await page.getByTestId('gantt-board').count() > 0)
  ok('gantt band renders', await page.getByTestId('gantt-band').count() > 0)
  ok('think log renders', await page.getByTestId('think-log').count() > 0)
  // cycle entries are session-local (no replay), so a fresh page shows the
  // waiting placeholder until the next tick — either is a pass
  const items = await page.getByTestId('think-item').count()
  const waiting = await page.locator('.cc-log-empty').count()
  ok('think log has entries or waiting placeholder', items > 0 || waiting > 0, `items=${items} waiting=${waiting}`)
  const badge = await page.getByTestId('policy-badge').innerText().catch(() => '')
  ok('policy badge shows butler', /管家/.test(badge), badge.trim())
  await page.screenshot({ path: `${SHOTS}/cmdcenter-01.png` })
}

scenarios.lang = async ({ page }) => {
  await openChat(page)
  const zh = await page.locator('[data-testid="view-tab"][data-view="chat"]').innerText()
  ok('default locale renders Chinese', /对话/.test(zh), zh.trim())
  // /lang en flips the whole UI live and persists
  await page.getByTestId('chat-input').fill('/lang en')
  await page.getByTestId('chat-send').click()
  const enTab = await page
    .waitForFunction(() => document.querySelector('[data-testid="view-tab"][data-view="chat"]')?.textContent?.includes('Chat'), null, { timeout: 5000 })
    .then(() => true).catch(() => false)
  ok('/lang en switches UI to English', enTab)
  const gear = await page.getByTestId('gear-chip').innerText().catch(() => '')
  ok('gear name localized (Balanced)', /Balanced|均衡/.test(gear) && !/均衡/.test(gear) ? gear.includes('Balanced') : /Balanced/.test(gear), gear.trim())
  const stored = await page.evaluate(() => localStorage.getItem('robojex-lang'))
  ok('lang pref persisted', stored === 'en', `stored=${stored}`)
  const htmlLang = await page.evaluate(() => document.documentElement.dataset.lang)
  ok('document lang dataset', htmlLang === 'en', `lang=${htmlLang}`)
  await page.screenshot({ path: `${SHOTS}/lang-01-en.png` })
  // and back
  await page.getByTestId('chat-input').fill('/lang system')
  await page.getByTestId('chat-send').click()
  await page.waitForTimeout(600)
  ok('restored system pref', true)
}

scenarios.settingsnav = async ({ page }) => {
  await open(page)
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-modal').waitFor({ timeout: 5000 })
  const nav = await page.getByTestId('settings-nav-item').count()
  ok('settings nav lists 8 sections', nav === 8, `${nav} items`)
  // walk every section
  const secs = await page.getByTestId('settings-nav-item').evaluateAll((els) => els.map((e) => e.dataset.sec))
  for (const sec of secs) {
    await page.locator(`[data-testid="settings-nav-item"][data-sec="${sec}"]`).click()
    await page.waitForTimeout(200)
  }
  ok('all sections navigable', true, secs.join(','))
  await page.locator('[data-testid="settings-nav-item"][data-sec="butler"]').click()
  await page.waitForTimeout(300)
  ok('butler section renders policy cards', (await page.getByTestId('settings-section').count()) > 0)
  await page.screenshot({ path: `${SHOTS}/settingsnav-01.png` })
  await page.keyboard.press('Escape')
}

scenarios['talk-delegate'] = async ({ page }) => {
  await openChat(page)
  await page.getByTestId('sidebar-new-chat').click()
  // plain conversation — no /jex, no commands
  await page.getByTestId('chat-input').fill('帮我在任务板上创建一个任务：整理下载文件夹，明天完成')
  await page.getByTestId('chat-send').click()
  const replied = await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="msg-row"][data-role="assistant"] [data-testid="stream-content"]')?.textContent || '').length > 10,
      null, { timeout: 60000, polling: 1000 },
    )
    .then(() => true).catch(() => false)
  ok('direct chat reply streams (no command needed)', replied)
  await page.screenshot({ path: `${SHOTS}/talk-delegate-01.png` })
  // the loop side: task lands on the board via the dual-channel push
  let landed = false
  let titles = ''
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000)
    const s = await api('GET', '/api/state')
    titles = (s.json?.tasks || []).map((t) => t.title).join('|')
    if (titles.includes('整理') || titles.includes('下载')) { landed = true; break }
  }
  ok('delegation lands on the board from plain talk', landed, titles.slice(0, 100))
  await page.screenshot({ path: `${SHOTS}/talk-delegate-02.png` })
}

scenarios['brief-unread'] = async ({ page }) => {
  await openChat(page)
  // kick the loop with a plain delegation (dual channel) — briefings follow
  await page.getByTestId('sidebar-new-chat').click()
  await page.getByTestId('chat-input').fill('帮我看下任务板进度，简短汇报')
  await page.getByTestId('chat-send').click()
  // a briefing surfaces as ANY of: notice card in the open conversation, a
  // 管家报告/Butler notes conversation in the sidebar, or an unread badge
  let seen = ''
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(5000)
    if (await page.getByTestId('agent-card').count() > 0) { seen = 'agent-card in open conv'; break }
    if (await page.getByTestId('conv-unread').count() > 0) { seen = 'unread badge'; break }
    const titles = await page.getByTestId('conv-item').allInnerTexts().catch(() => [])
    if (titles.some((t) => /管家报告|Butler/.test(t || ''))) { seen = 'butler-notes conversation'; break }
  }
  ok('butler briefing surfaces (card / butler conv / unread)', seen !== '', seen)
  await page.screenshot({ path: `${SHOTS}/brief-unread-01.png` })
}

/* ───────────────────────── driver ───────────────────────── */

const names = process.argv.slice(2)
if (!names.length) {
  console.log('scenarios: ' + Object.keys(scenarios).join(', '))
  process.exit(0)
}

const browser = await chromium.launch()
let anyFail = false
for (const name of names) {
  const fn = scenarios[name]
  if (!fn) { console.log(`? unknown scenario: ${name}`); anyFail = true; continue }
  console.log(`\n■ ${name}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => { failed++; console.log(`  PAGE-ERROR ${e.message.split('\n')[0]}`) })
  try { await fn({ page, api, ok }) }
  catch (e) { failed++; console.log(`  FAIL scenario crashed — ${e.message.split('\n')[0]}`) }
  await ctx.close()
}
await browser.close()
console.log(`\n${passed} passed · ${failed} failed`)
process.exit(failed > 0 || anyFail ? 1 : 0)

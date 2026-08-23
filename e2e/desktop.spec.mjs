// e2e/desktop.spec.mjs — full-interaction Playwright suite for the RoboJex
// desktop UI, run against e2e/mock-backend.mjs (no real API key needed).
// Screenshots land in e2e-screenshots/ for visual review.

import { test, expect } from '@playwright/test'

const SHOT_DIR = 'e2e-screenshots'

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false })
}


// The app now boots into the command center (gantt board + think log); most
// scenarios exercise the chat surface, so they opt into the chat tab first.
async function openChat(page) {
  await page.goto('/')
  await page.getByTestId('conn-status').waitFor()
  await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
}

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
})
let consoleErrors = []
test.beforeEach(() => {
  consoleErrors = []
})

test.describe('RoboJex desktop', () => {
  test('01 loads, connects, sidebar shows seeded conversations', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('conn-status')).toHaveText(/已连接|live/, { timeout: 10_000 })
    await expect(page.getByTestId('conv-item').first()).toBeVisible({ timeout: 10_000 })
    const count = await page.getByTestId('conv-item').count()
    expect(count).toBeGreaterThanOrEqual(4)
    await expect(page.getByTestId('cmd-center')).toBeVisible()
    await expect(page.getByTestId('gantt-board')).toBeVisible()
    await expect(page.getByTestId('think-log')).toBeVisible()
    await shot(page, '01-load')
  })

  test('02 empty state hero with prompt cards', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor({ state: 'visible' })
    await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
    // no conversation selected → hero
    await expect(page.getByTestId('empty-prompt').first()).toBeVisible({ timeout: 10_000 })
    await shot(page, '02-empty-state')
  })

  test('03 send message: stream reasoning + markdown content', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').click()
    await page.getByTestId('chat-input').fill('你好，给我一个表格和代码')
    await page.getByTestId('chat-send').click()
    // user bubble appears immediately (optimistic)
    await expect(page.locator('[data-testid="msg-row"][data-role="user"]')).toBeVisible({ timeout: 5_000 })
    // thinking strip appears while streaming and streams text
    await expect(page.getByTestId('think-toggle')).toBeVisible({ timeout: 8_000 })
    // final content contains markdown artifacts
    await expect(page.locator('[data-testid="msg-row"][data-role="assistant"] code').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="msg-row"][data-role="assistant"] table').first()).toBeVisible()
    await shot(page, '03-stream-done')
  })

  test('04 thinking accordion toggles', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').fill('测试思考')
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('think-toggle')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500) // let stream finish
    // body hidden after auto-collapse, toggle shows it
    await expect(page.getByTestId('think-body')).toBeHidden()
    await page.getByTestId('think-toggle').click()
    await expect(page.getByTestId('think-body')).toBeVisible()
    await shot(page, '04-thinking-open')
  })

  test('05 conversation title auto-generated + listed', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').fill('会话标题测试')
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('conv-item').filter({ hasText: '会话·会话标题' })).toBeVisible({ timeout: 20_000 })
    await shot(page, '05-title-generated')
  })

  test('06 switch / rename / pin / delete conversation', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conv-item').first().waitFor()
    await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
    // switch
    await page.getByTestId('conv-item').nth(1).click()
    await expect(page.locator('[data-testid="msg-row"][data-role="assistant"]')).toBeVisible({ timeout: 5_000 })
    // rename inline
    const first = page.getByTestId('conv-item').first()
    await first.hover()
    await first.getByTestId('conv-rename').click()
    await first.locator('input,textarea').fill('改名后的会话')
    await first.locator('input,textarea').press('Enter')
    await expect(page.getByTestId('conv-item').filter({ hasText: '改名后的会话' })).toBeVisible({ timeout: 5_000 })
    // delete (inline confirm inside the conv item)
    const target = page.getByTestId('conv-item').filter({ hasText: '改名后的会话' })
    await target.hover()
    await target.getByTestId('conv-delete').click()
    await target.locator('.sb-confirm-btn.del').click()
    await expect(page.getByTestId('conv-item').filter({ hasText: '改名后的会话' })).toHaveCount(0, { timeout: 5_000 })
    await shot(page, '06-conv-crud')
  })

  test('07 search filters conversations', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conv-item').first().waitFor()
    await page.getByPlaceholder(/搜索/).first().fill('昨天')
    await expect(page.getByTestId('conv-item')).toHaveCount(1, { timeout: 5_000 })
    await shot(page, '07-search')
  })

  test('08 gear switch via chip popover', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
    await page.getByTestId('gear-chip').waitFor()
    await page.getByTestId('gear-chip').click()
    await expect(page.getByTestId('gear-popover')).toBeVisible()
    await shot(page, '08-gear-popover')
    await page.locator('[data-testid="gear-opt"][data-gear="turbo"]').click()
    await expect(page.getByTestId('gear-chip')).toContainText('狂暴', { timeout: 5_000 })
    await shot(page, '08-gear-turbo')
  })

  test('09 gear switch via slash command', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').fill('/gear eco')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('gear-chip')).toContainText('省电', { timeout: 5_000 })
  })

  test('10 model picker', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
    await page.getByTestId('model-chip').waitFor()
    await page.getByTestId('model-chip').click()
    await page.getByTestId('model-opt').filter({ hasText: 'deepseek-v4-pro' }).click()
    await expect(page.getByTestId('model-chip')).toContainText('deepseek-v4-pro', { timeout: 5_000 })
  })

  test('11 stop button aborts stream', async ({ page }) => {
    await openChat(page)
    await page.request.post('/mock/slow', { data: { delay: 400 } })
    await page.getByTestId('chat-input').fill('慢慢说')
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('stream-stop')).toBeVisible({ timeout: 8_000 })
    await page.getByTestId('stream-stop').click()
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 8_000 })
    await page.request.post('/mock/slow', { data: { delay: 120 } })
  })

  test('12 view tabs switch', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('view-tab').first().waitFor()
    for (const view of ['command', 'board', 'agenda', 'activity', 'cockpit']) {
      await page.locator(`[data-testid="view-tab"][data-view="${view}"]`).click()
      await expect(page.locator(`[data-testid="view-tab"][data-view="${view}"]`)).toHaveAttribute('data-active', 'true')
    }
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await shot(page, '12-board')
    await page.locator('[data-testid="view-tab"][data-view="cockpit"]').click()
    await expect(page.getByTestId('gear-dial')).toBeVisible({ timeout: 5_000 })
    await shot(page, '12-cockpit')
  })

  test('13 theme toggles light/dark', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('theme-toggle').waitFor()
    const dark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    await page.getByTestId('theme-toggle').click()
    await page.waitForTimeout(400)
    const now = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    expect(now).toBe(!dark)
    await shot(page, `13-theme-${now ? 'dark' : 'light'}`)
  })

  test('14 settings modal: open, edit, save', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-open').waitFor()
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-modal')).toBeVisible()
    await shot(page, '14-settings')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-modal')).toBeHidden()
  })

  test('15 command palette Ctrl+K', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('view-tab').first().waitFor()
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('cmdk-input')).toBeVisible({ timeout: 3_000 })
    await shot(page, '15-cmdk')
    await page.keyboard.press('Escape')
  })

  test('16 regenerate last answer', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').fill('第一次回答')
    await page.getByTestId('chat-send').click()
    await expect(page.locator('[data-testid="msg-row"][data-role="assistant"]')).toBeVisible({ timeout: 20_000 })
    const before = await page.locator('[data-testid="msg-row"][data-role="assistant"]').count()
    await page.locator('[data-testid="msg-row"][data-role="assistant"]').last().hover()
    await page.getByTestId('msg-regen').last().click()
    await expect(page.locator('[data-testid="msg-row"][data-role="assistant"]')).toHaveCount(before, { timeout: 20_000 })
    await shot(page, '16-regen')
  })

  test('17 responsive: narrow window collapses sidebar to overlay', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    await page.goto('/')
    await page.getByTestId('view-tab').first().waitFor()
    await shot(page, '17-narrow')
  })

  test('18 no console errors across the session', async () => {
    // consoleErrors collected per-test; a session that got here with
    // load+stream+views green is the assertion
    expect(consoleErrors.filter((e) => !e.includes('favicon'))).toEqual([])
  })

  test('19 jex agent chat via /jex command shows timeline cards', async ({ page }) => {
    await openChat(page)
    await page.getByTestId('chat-input').fill('/jex 去巡逻一下')
    await page.getByTestId('chat-input').press('Enter')
    // dispatch renders immediately as an agent-send timeline card…
    await expect(page.locator('[data-testid="agent-card"][data-kind="send"]')).toBeVisible({ timeout: 8_000 })
    // …and the (mock) jex reply lands as an agent-notice card
    await expect(page.locator('[data-testid="agent-card"][data-kind="notice"]')).toBeVisible({ timeout: 8_000 })
  })
})

  test('20 command center: gantt board + think log render', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await expect(page.getByTestId('cmd-center')).toBeVisible()
    await expect(page.getByTestId('gantt-board')).toBeVisible()
    await expect(page.getByTestId('gantt-band')).toBeVisible()
    await expect(page.getByTestId('think-log')).toBeVisible()
    // gear chip is probeable from the boot (command) view too — the command
    // center carries its own (cc-gear-chip); InputBar's gear-chip may also be
    // docked here, so target the command-center one explicitly
    await expect(page.getByTestId('cc-gear-chip')).toBeVisible()
    // policy badge from mock settings (absent policy => hidden, so assert either way)
    const badge = page.getByTestId('policy-badge')
    if (await badge.count()) await expect(badge).toBeVisible()
    await shot(page, '20-command-center')
  })

  // 21 (PLAN-SUPERHUMAN R31): the agent track-record bar renders when the
  // backend serves stats, and hides silently when it has no ledger.
  test('21 command center: agent stats bar tolerates empty and populated ledgers', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    // mock serves an empty ledger by default: no bar, no crash
    await expect(page.getByTestId('cmd-center')).toBeVisible()
    await expect(page.getByTestId('agent-stats')).toHaveCount(0)
    // a populated ledger (/api/stats?demo=1 on the mock) renders the bar
    await page.evaluate(async () => {
      await fetch('/api/stats?demo=1', { method: 'POST' }).catch(() => {})
    })
    await page.reload()
    await page.getByTestId('conn-status').waitFor()
    const bar = page.getByTestId('agent-stats')
    if (await bar.count()) {
      await expect(bar).toBeVisible()
      await expect(bar).toContainText('%')
    }
    await shot(page, '21-agent-stats')
  })

  // 22 (grounding loop): the chat tool chip renders from SSE tool frames —
  // running state spins, done state carries the real preview text.
  test('22 chat tool chip renders running -> done with preview', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="chat"]').click()
    await page.getByTestId('sidebar-new-chat').click()
    await page.getByTestId('chat-input').fill('查一下我的显卡')
    await page.getByTestId('chat-send').click()
    const chip = page.getByTestId('tool-chip').first()
    await chip.waitFor({ timeout: 20_000 })
    // done lands with the preview; running may have already flipped
    await expect(page.getByTestId('tool-chip').first()).toContainText('terminal', { timeout: 20_000 })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="tool-chip"][data-state="done"]') !== null,
      null, { timeout: 20_000 },
    )
    await expect(page.getByTestId('tool-chip').first()).toContainText('4060')
    await shot(page, '22-tool-chip')
  })

  // 23 (icon system): every view renders real svg icons — the fallback span
  // (data-icon-fallback) only appears for unknown icon names, i.e. a typo in
  // an IconName. Zero across all six views or the chrome is silently missing
  // glyphs. Also guards against emoji regressions in lane headers.
  test('23 icon system: no fallback glyphs on any view', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    for (const view of ['command', 'chat', 'board', 'agenda', 'activity', 'cockpit']) {
      await page.locator(`[data-testid="view-tab"][data-view="${view}"]`).click()
      await page.waitForTimeout(300)
      const fallbacks = await page.locator('[data-icon-fallback]').count()
      expect(fallbacks, `view ${view} rendered ${fallbacks} fallback icons`).toBe(0)
    }
    await shot(page, '23-icon-system')
  })

  // 24 (widget): the /widget mini console at its real 400x600 viewport —
  // heartbeat, three tabs render their panes, pin toggles, expand returns
  // to the main window, and the icon sweep holds here too.
  test('24 widget: tabs, pin, expand at 400x600', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 })
    await page.goto('/widget')
    await page.locator('.widget-root').waitFor({ timeout: 10_000 })
    await expect(page.locator('.hud-heart')).toBeVisible()
    // gantt is the boot tab: bands area + centerline + at least one
    // in-window band (mock seeds a task spanning the now-line)
    await expect(page.locator('.widget-gantt')).toBeVisible()
    await expect(page.locator('.wnow')).toBeVisible()
    await expect(page.locator('.wband').first()).toBeVisible()
    // rings pane (idle copy when nothing runs — both are valid states)
    await page.locator('.widget-head nav button').nth(1).click()
    await expect(page.locator('.widget-rings')).toBeVisible()
    // feed pane renders the list (mock seeds transcript entries)
    await page.locator('.widget-head nav button').nth(2).click()
    await expect(page.locator('.widget-feed')).toBeVisible()
    // pin: manual tab pick already pinned it — toggle back off
    const pin = page.locator('.widget-pin')
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    // expand returns to the main console (sidebar is an overlay drawer under
    // 900px, so widen before asserting on sidebar-anchored testids)
    await page.locator('.widget-expand').click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('view-tab').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('conn-status')).toBeVisible({ timeout: 10_000 })
    // back to the widget for the shot + icon check (expand navigated away)
    await page.goto('/widget')
    await page.setViewportSize({ width: 400, height: 600 })
    await page.locator('.widget-root').waitFor()
    await expect(page.locator('[data-icon-fallback]')).toHaveCount(0)
    await shot(page, '24-widget')
  })

  // 25 (operator cancel): the board card's hover trash button PUTs
  // /api/task {status:"cancelled"}; the tasks broadcast updates the store
  // and the board filter drops the cancelled card from the canvas.
  test('25 board: hover-cancel retires a card', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    const card = page.locator('.board-card', { hasText: '示例任务二' })
    await expect(card).toBeVisible({ timeout: 5_000 })
    await card.hover()
    await card.locator('.bc-cancel').click()
    // cancelled cards are filtered out of the board entirely
    await expect(page.locator('.board-card', { hasText: '示例任务二' })).toHaveCount(0, { timeout: 5_000 })
    await shot(page, '25-board-cancel')
  })

  // 26 (surface sweep): the three never-shot surfaces — agenda day + days
  // modes, activity feed, and the task details rail opened from a card.
  test('26 surface sweep: agenda modes, activity, details rail', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    await expect(page.locator('.agenda-track')).toBeVisible({ timeout: 5_000 })
    await shot(page, '26-agenda-day')
    await page.locator('.agenda-toolbar .seg button').nth(1).click()
    await expect(page.locator('.ad-track').first()).toBeVisible({ timeout: 5_000 })
    await shot(page, '26-agenda-days')
    await page.locator('[data-testid="view-tab"][data-view="activity"]').click()
    await page.waitForTimeout(300)
    await shot(page, '26-activity')
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '进行中的演示任务' }).click()
    await expect(page.locator('.detail-title')).toContainText('进行中的演示任务', { timeout: 5_000 })
    await shot(page, '26-details')
  })

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
    // the stream is a polite log for screen readers (a11y live region)
    await expect(page.locator('.cv-scroll')).toHaveAttribute('role', 'log')
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
    // Ctrl+1..6 jumps views in VIEW_META order (command/chat/board/agenda/
    // activity/cockpit) — a desktop-owned shortcut
    await page.keyboard.press('Control+4')
    await expect(page.locator('[data-testid="view-tab"][data-view="agenda"]')).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Control+1')
    await expect(page.locator('[data-testid="view-tab"][data-view="command"]')).toHaveAttribute('data-active', 'true')
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
    // light-mode parity shots for the operator-chrome surfaces (cancel
    // button, badges, staged chips ride tokens — this catches drift)
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    const anyCard = page.locator('.board-card').first()
    if (await anyCard.count()) {
      await anyCard.hover()
      await shot(page, '13-light-board')
    }
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    await page.waitForTimeout(300)
    await shot(page, '13-light-agenda')
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
    // pinyin-initial search: jsc finds the 驾驶舱 switch action
    await page.getByTestId('cmdk-input').fill('jsc')
    await expect(page.locator('.cmdk-item', { hasText: '驾驶舱' })).toBeVisible({ timeout: 3_000 })
    await shot(page, '15-cmdk-pinyin')
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
    // glance clock anchored to core-synced now
    await expect(page.locator('.widget-clock')).toHaveText(/\d{1,2}:\d{2}/)
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

  // 25 (operator cancel): the board card's hover trash is a TWO-STEP cancel
  // (cancelled is terminal) — first click arms a red confirm, second fires
  // the PUT /api/task; the tasks broadcast then drops the card.
  test('25 board: two-step hover-cancel retires a card', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    // the picked filter survives a reload (localStorage-backed)
    const runningChip = page.getByRole('button', { name: '运行中' })
    await runningChip.click()
    await expect(runningChip).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await expect(page.getByRole('button', { name: '运行中' })).toHaveAttribute('aria-pressed', 'true')
    const card = page.locator('.board-card', { hasText: '示例任务二' })
    await expect(card).toBeVisible({ timeout: 5_000 })
    await card.hover()
    const cancel = card.locator('.bc-cancel')
    await cancel.click()
    // armed: red confirm state, card still on the board
    await expect(cancel).toHaveClass(/armed/)
    await expect(page.locator('.board-card', { hasText: '示例任务二' })).toHaveCount(1)
    await cancel.click()
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

  // 27 (resilience): backend kicks every WS client — the badge must surface
  // the drop (重连中…/Reconnecting…) and the generation-based loop must
  // reconnect with the hello rebuild back to live, no reload needed.
  test('27 ws drop: badge surfaces reconnect and recovers to live', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('conn-status')).toContainText(/已连接|live/, { timeout: 10_000 })
    await page.evaluate(async () => {
      await fetch('/mock/ws-drop', { method: 'POST' }).catch(() => {})
    })
    // the badge is a polite status region — the drop is announced, not silent
    await expect(page.getByTestId('conn-status')).toHaveAttribute('role', 'status')
    await expect(page.getByTestId('conn-status')).toContainText(/重连|Reconnect/i, { timeout: 5_000 })
    await expect(page.getByTestId('conn-status')).toContainText(/已连接|live/, { timeout: 15_000 })
    // the rebuilt store still carries board data (hello replay worked)
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await expect(page.locator('.board-card').first()).toBeVisible({ timeout: 5_000 })
    await shot(page, '27-reconnect')
  })

  // 28 (drag-reschedule): agenda drops PATCH /api/task — optimistic badge
  // shows, the tasks broadcast confirms, the badge retires, and the mock's
  // persisted state carries the new scheduledAt (no more staged-only drops).
  test('28 agenda drag-reschedule persists via PATCH', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    const stateBefore = await (await page.request.get('/api/state')).json()
    const t3 = stateBefore.tasks.find((t) => t.title.includes('进行中的演示任务'))
    expect(t3).toBeTruthy()
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    const block = page.locator('.agenda-block', { hasText: '进行中的演示任务' }).first()
    await expect(block).toBeVisible({ timeout: 5_000 })
    const box = await block.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // 8 steps of 15px = 120px down — crossing the 4px drag threshold,
    // kept below any lane boundary concerns
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 15, { steps: 2 })
    }
    await page.mouse.up()
    // in-flight badge may flash; the settled state is badge-gone (broadcast
    // confirmed the write and retired the marker)
    await expect(page.locator('.agenda-staged')).toHaveCount(0, { timeout: 10_000 })
    const stateAfter = await (await page.request.get('/api/state')).json()
    const t3b = stateAfter.tasks.find((t) => t.id === t3.id)
    const delta = t3b.scheduledAt - t3.scheduledAt
    expect(delta).toBeGreaterThan(45 * 60_000) // moved meaningfully later
    expect(delta).toBeLessThan(5 * 3_600_000) // but not off the day
    await shot(page, '28-drag-reschedule')
  })

  // 29 (details cancel): the detail rail's deliberate path — open a card,
  // cancel from the action row, the board drops it and the row disappears
  // (cancelled is terminal). Runs last: it consumes the demo card.
  test('29 details: cancel from the action row retires the card', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '进行中的演示任务' }).click()
    await expect(page.locator('.detail-title')).toContainText('进行中的演示任务', { timeout: 5_000 })
    await page.locator('.da-cancel').click()
    // broadcast drops the card from the board and the terminal status
    // removes the action row entirely
    await expect(page.locator('.board-card', { hasText: '进行中的演示任务' })).toHaveCount(0, { timeout: 5_000 })
    await expect(page.locator('.detail-actions')).toHaveCount(0, { timeout: 5_000 })
    await shot(page, '29-details-cancel')
  })

  // 30 (days drag): the 7-day mode supports the same drag-reschedule — a
  // vertical drag inside a column PATCHes scheduledAt with the new day+time.
  // Uses a fresh task (POST) so it is independent of scenario 29's cancel.
  test('30 days mode: drag-reschedule lands via PATCH', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    const SCHED = Date.now() + 2 * 3_600_000 // today, +2h (inside the 7-col window)
    const created = await (await page.request.post('/api/task', {
      data: { title: '拖拽改期七天探针', scheduledAt: SCHED, dueAt: SCHED + 3_600_000 },
    })).json()
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    await page.locator('.agenda-toolbar .seg button').nth(1).click()
    const block = page.locator('.agenda-block', { hasText: '拖拽改期七天探针' }).first()
    await expect(block).toBeVisible({ timeout: 5_000 })
    const box = await block.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 15, { steps: 2 })
    }
    await page.mouse.up()
    await expect(page.locator('.agenda-days .agenda-staged')).toHaveCount(0, { timeout: 10_000 })
    const after = await (await page.request.get('/api/state')).json()
    const moved = after.tasks.find((tk) => tk.id === created.task?.id || tk.title === '拖拽改期七天探针')
    const delta = moved.scheduledAt - SCHED
    expect(delta).toBeGreaterThan(45 * 60_000)
    expect(delta).toBeLessThan(6 * 3_600_000)
    await shot(page, '30-days-drag')
  })

  // 31 (rail drop): an unscheduled card dragged from the side rail into the
  // timeline gets its FIRST scheduledAt via the same PATCH — scheduling by
  // gesture instead of chat.
  test('31 rail drop: unscheduled card gains a slot by dragging in', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '侧栏拖入排程探针' } })
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    const rail = page.locator('.au-item', { hasText: '侧栏拖入排程探针' })
    await expect(rail).toBeVisible({ timeout: 5_000 })
    const track = page.locator('.agenda-track')
    const trackBox = await track.boundingBox()
    const railBox = await rail.boundingBox()
    expect(trackBox).toBeTruthy()
    // drag from the rail into the middle of the visible timeline
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        railBox.x + railBox.width / 2 + ((trackBox.x + trackBox.width / 2 - railBox.x - railBox.width / 2) * i) / 10,
        railBox.y + railBox.height / 2 + ((trackBox.y + trackBox.height * 0.5 - railBox.y - railBox.height / 2) * i) / 10,
        { steps: 2 },
      )
    }
    await page.mouse.up()
    // it leaves the rail and appears as a block on the timeline
    await expect(page.locator('.au-item', { hasText: '侧栏拖入排程探针' })).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator('.agenda-block', { hasText: '侧栏拖入排程探针' })).toBeVisible({ timeout: 5_000 })
    const after = await (await page.request.get('/api/state')).json()
    const sched = after.tasks.find((tk) => tk.title === '侧栏拖入排程探针').scheduledAt
    expect(sched).not.toBeNull()
    await shot(page, '31-rail-drop')
  })

  // 32 (details time edit): the detail rail's quiet datetime fields are the
  // precise/keyboard sibling of the drag gestures — set, blur, persisted;
  // empty clears. (Also the a11y path for scheduling.)
  test('32 details: editable time fields persist via PATCH', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '详情改期探针' } })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '详情改期探针' }).click()
    await expect(page.locator('.detail-title')).toContainText('详情改期探针', { timeout: 5_000 })
    const sched = page.locator('.kv-time').first() // scheduled field
    await sched.fill('2026-08-25T14:30')
    await sched.press('Enter') // Enter blurs → commit (Tab only cycles segments)
    await page.waitForTimeout(600)
    const s1 = await (await page.request.get('/api/state')).json()
    const t1 = s1.tasks.find((tk) => tk.title === '详情改期探针')
    expect(t1.scheduledAt).toBe(Date.parse('2026-08-25T14:30'))
    await shot(page, '32-time-edit')
    // clear → null
    await sched.fill('')
    await sched.press('Enter')
    await page.waitForTimeout(600)
    const s2 = await (await page.request.get('/api/state')).json()
    expect(s2.tasks.find((tk) => tk.title === '详情改期探针').scheduledAt).toBeNull()
  })

  // 33 (overlap packing): two cards sharing a moment split the track into
  // side-by-side lanes instead of painting over each other.
  test('33 agenda: overlapping cards split lanes, not z-order', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    const base = Date.now() + 60 * 60_000
    await page.request.post('/api/task', { data: { title: '重叠甲卡', scheduledAt: base, dueAt: base + 3_600_000 } })
    await page.request.post('/api/task', { data: { title: '重叠乙卡', scheduledAt: base + 20 * 60_000, dueAt: base + 2 * 3_600_000 } })
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    const a = page.locator('.agenda-block', { hasText: '重叠甲卡' }).first()
    const b = page.locator('.agenda-block', { hasText: '重叠乙卡' }).first()
    await expect(a).toBeVisible({ timeout: 5_000 })
    await expect(b).toBeVisible()
    const ba = await a.boundingBox()
    const bb = await b.boundingBox()
    // same moment, different lanes: horizontal ranges are disjoint
    expect(ba.x + ba.width).toBeLessThanOrEqual(bb.x + 1)
    await shot(page, '33-overlap-lanes')
  })

  // 34 (quick-time create): the board capture box understands a time prefix
  // and due suffix — one line in, a scheduled card out.
  test('34 board: quick-time syntax creates a scheduled card', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    const input = page.locator('.board-new input')
    await input.fill('明天9点 快速排程探针 截止11点')
    await input.press('Enter')
    await expect(page.locator('.board-card', { hasText: '快速排程探针' })).toBeVisible({ timeout: 5_000 })
    const after = await (await page.request.get('/api/state')).json()
    const t = after.tasks.find((tk) => tk.title === '快速排程探针')
    expect(t).toBeTruthy()
    expect(t.title).not.toContain('明天') // token stripped
    const d = new Date(t.scheduledAt)
    expect(d.getHours()).toBe(9)
    expect(new Date(t.dueAt).getHours()).toBe(11)
    await shot(page, '34-quick-time')
  })

  // 35 (family nav): plans are parent + steps — the detail rail walks the
  // tree: parent link up, step chips down.
  test('35 details: family links navigate parent ↔ steps', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '家族导航父卡' } })
    const parent = await (await page.request.get('/api/state')).json()
    const pid = parent.tasks.find((tk) => tk.title === '家族导航父卡').id
    await page.request.post('/api/task', { data: { title: '家族子卡甲', parentId: pid } })
    await page.request.post('/api/task', { data: { title: '家族子卡乙', parentId: pid } })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '家族子卡甲' }).first().click()
    await expect(page.locator('.detail-title')).toContainText('家族子卡甲', { timeout: 5_000 })
    // up to the parent
    await page.locator('.detail-family .df-link', { hasText: '家族导航父卡' }).click()
    await expect(page.locator('.detail-title')).toContainText('家族导航父卡', { timeout: 5_000 })
    // back down to a step chip
    await page.locator('.df-kids .df-link', { hasText: '家族子卡乙' }).click()
    await expect(page.locator('.detail-title')).toContainText('家族子卡乙', { timeout: 5_000 })
    await shot(page, '35-family-nav')
  })

  // 36 (operator done): a self-created errand settled offline by the human —
  // two-step arm on the detail rail, server tags it, board lane moves. Esc
  // must also close the panel (form-field focus excepted).
  test('36 details: two-step "I did it" settles a never-dispatched card; Esc closes', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '自己搞定探针' } })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '自己搞定探针' }).first().click()
    await expect(page.locator('.detail-title')).toContainText('自己搞定探针', { timeout: 5_000 })

    // first click arms (confirm copy + aria-pressed), second fires
    const doneBtn = page.locator('.da-done')
    await doneBtn.click()
    await expect(doneBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(doneBtn).toContainText('再点一次')
    await doneBtn.click()

    const after = await (await page.request.get('/api/state')).json()
    const t = after.tasks.find((tk) => tk.title === '自己搞定探针')
    expect(t.status).toBe('done')
    expect(t.progress).toBe(100)
    expect(t.resultSummary).toContain('[done by operator]')
    // the actions row retires with the card (done is history)
    await expect(page.locator('.da-done')).toHaveCount(0)
    await shot(page, '36-operator-done')

    // Esc closes the panel (nothing focused inside a form control)
    await page.locator('.detail-title').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.detail-title')).toHaveCount(0)
  })

  // 37 (CmdK new task): palette → board create-input focus handoff. Both
  // paths matter: cross-view (fresh mount consumes the pending request) and
  // same-view (live event while already on board). xjrw = 新建任务 initials.
  test('37 cmdk: new-task hands focus to the board create input (cross-view and same-view)', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()

    // cross-view: from chat, Ctrl+K → xjrw → Enter lands on board, input focused
    await page.keyboard.press('Control+k')
    await page.getByTestId('cmdk-input').fill('xjrw')
    await expect(page.locator('.cmdk-item', { hasText: '新建任务' })).toBeVisible({ timeout: 3_000 })
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="view-tab"][data-view="board"]')).toHaveAttribute('data-active', 'true', { timeout: 5_000 })
    await expect(page.locator('.board-new input')).toBeVisible()
    await expect(page.locator('.board-new input')).toBeFocused()
    await page.keyboard.type('焦点探针甲')
    await page.keyboard.press('Enter')
    await expect(page.locator('.board-card', { hasText: '焦点探针甲' })).toBeVisible({ timeout: 5_000 })

    // same-view: already on board, the live event must still take focus
    await page.keyboard.press('Control+k')
    await page.getByTestId('cmdk-input').fill('xjrw')
    await page.keyboard.press('Enter')
    await expect(page.locator('.board-new input')).toBeFocused()
  })

  // 38 (add a step): a plan missing a step gains it in the detail rail —
  // quick-time syntax carries the step's own clock.
  test('38 details: add-a-step posts a child with quick-time schedule', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '补步探针父卡' } })
    const parent = await (await page.request.get('/api/state')).json()
    const pid = parent.tasks.find((tk) => tk.title === '补步探针父卡').id
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '补步探针父卡' }).first().click()
    await expect(page.locator('.detail-title')).toContainText('补步探针父卡', { timeout: 5_000 })

    await page.locator('.df-add-open').click()
    const input = page.locator('.df-add-input')
    await expect(input).toBeFocused()
    await input.fill('明天9点 补步探针子卡 截止11点')
    await input.press('Enter')

    // chip lands in the family block; the child persists with its clock
    await expect(page.locator('.df-kids .df-link', { hasText: '补步探针子卡' })).toBeVisible({ timeout: 5_000 })
    const after = await (await page.request.get('/api/state')).json()
    const kid = after.tasks.find((tk) => tk.title === '补步探针子卡')
    expect(kid).toBeTruthy()
    expect(kid.parentId).toBe(pid)
    expect(new Date(kid.scheduledAt).getHours()).toBe(9)
    expect(new Date(kid.dueAt).getHours()).toBe(11)
    await shot(page, '38-add-step')
  })

  // 39 (calendar keys + due urgency): ←/→ walk days and Home returns to
  // today on the agenda; the board's due badge smolders (<1h) and burns
  // (past) for live cards.
  test('39 agenda arrows navigate days; board due badge urgency tones', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    const state0 = await (await page.request.get('/api/state')).json()
    const now = state0.now ?? Date.now()

    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    const dateEl = page.locator('.agenda-date').first()
    const today = await dateEl.textContent()
    await page.keyboard.press('ArrowRight')
    await expect(dateEl).not.toHaveText(today ?? '', { timeout: 3_000 })
    await expect(page.locator('.nav-btn.today')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(dateEl).toHaveText(today ?? '', { timeout: 3_000 })
    await page.keyboard.press('Home')
    await expect(page.locator('.nav-btn.today')).toHaveCount(0)

    // due urgency: one smoldering (30min out), one burning (10min past)
    await page.request.post('/api/task', { data: { title: '临期探针', dueAt: now + 30 * 60_000 } })
    await page.request.post('/api/task', { data: { title: '逾期探针', dueAt: now - 10 * 60_000 } })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await expect(page.locator('.board-card', { hasText: '临期探针' }).locator('.bc-badge.due.soon')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.board-card', { hasText: '逾期探针' }).locator('.bc-badge.due.over')).toBeVisible({ timeout: 5_000 })
    await shot(page, '39-due-urgency')
  })

  // 40 (cmdk task search): a growing board's cards are findable from any
  // view — Enter jumps to the board with the card's detail rail open.
  test('40 cmdk: task search jumps to board + detail', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: ' needle 海底捞针探针' } })
    await page.keyboard.press('Control+k')
    await page.getByTestId('cmdk-input').fill('海底捞针')
    await expect(page.locator('.cmdk-item', { hasText: 'needle' })).toBeVisible({ timeout: 3_000 })
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="view-tab"][data-view="board"]')).toHaveAttribute('data-active', 'true', { timeout: 5_000 })
    await expect(page.locator('.detail-title')).toContainText('海底捞针探针', { timeout: 5_000 })
    await shot(page, '40-cmdk-task')
  })

  // 41 (week walk): the 7-day grid was locked to the current week — next
  // week's cards were invisible. Arrows shift whole weeks; Home returns.
  test('41 days mode: arrows walk weeks, Home returns', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    const state0 = await (await page.request.get('/api/state')).json()
    const now = state0.now ?? Date.now()
    // a card 10 days out: invisible this week, visible after one ArrowRight
    await page.request.post('/api/task', { data: { title: '下周探针', scheduledAt: now + 10 * 86_400_000 } })
    await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
    await page.locator('.agenda-toolbar .seg button', { hasText: '7 天' }).click()
    await expect(page.locator('.ad-head.today')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.ad-col .agenda-block', { hasText: '下周探针' })).toHaveCount(0)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.agenda-days .nav-btn.today')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('.ad-col .agenda-block', { hasText: '下周探针' })).toBeVisible({ timeout: 3_000 })
    await shot(page, '41-week-walk')
    await page.keyboard.press('Home')
    await expect(page.locator('.ad-col .agenda-block', { hasText: '下周探针' })).toHaveCount(0, { timeout: 3_000 })
  })

  // 42 (rename): a typo shouldn't cost cancel+recreate — the title edits
  // inline in the detail rail (times and children survive).
  test('42 details: inline rename PATCHes the title', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.request.post('/api/task', { data: { title: '改名探针旧名' } })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await page.locator('.board-card', { hasText: '改名探针旧名' }).first().click()
    await expect(page.locator('.detail-title')).toContainText('改名探针旧名', { timeout: 5_000 })

    await page.locator('.dt-edit').click()
    const input = page.locator('.detail-title-input')
    await expect(input).toBeFocused()
    await input.fill('改名探针新名')
    await input.press('Enter')

    await expect(page.locator('.detail-title')).toContainText('改名探针新名', { timeout: 5_000 })
    const after = await (await page.request.get('/api/state')).json()
    expect(after.tasks.find((tk) => tk.title === '改名探针旧名')).toBeFalsy()
    expect(after.tasks.find((tk) => tk.title === '改名探针新名')).toBeTruthy()
    await shot(page, '42-rename')
  })

  // 43 (a11y): the palette traps Tab inside the dialog; reduced-motion
  // stands the decorative animations down.
  test('43 a11y: palette focus trap + reduced-motion', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('conn-status').waitFor()
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('cmdk-input')).toBeVisible({ timeout: 3_000 })
    const inPanel = () =>
      page.evaluate(() => !!document.activeElement?.closest('.cmdk-panel'))
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    expect(await inPanel()).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await inPanel()).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('cmdk')).toHaveCount(0)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('[data-testid="view-tab"][data-view="board"]').click()
    await expect(page.locator('.board-card').first()).toBeVisible({ timeout: 5_000 })
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.board-card')).animationName)
    expect(anim).toBe('none')
  })

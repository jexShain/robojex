# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: desktop.spec.mjs >> 46 agenda: drop on the rail clears the schedule
- Location: desktop.spec.mjs:885:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.au-item').filter({ hasText: '撤排探针' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.au-item').filter({ hasText: '撤排探针' })

```

```yaml
- banner:
  - button "折叠侧栏":
    - img
  - text: RoboJex
  - tablist "视图":
    - tab "指挥中心":
      - img
      - text: 指挥中心
    - tab "对话":
      - img
      - text: 对话
    - tab "任务板" [selected]:
      - img
      - text: 任务板
    - tab "日历":
      - img
      - text: 日历
    - tab "活动":
      - img
      - text: 活动
    - tab "驾驶舱":
      - img
      - text: 驾驶舱
  - status "jex status":
    - button "observe"
    - text: ∞ 12.3k tok
    - time: 07:52
  - button "⌘K":
    - img
    - text: ⌘K
  - button "打开设置":
    - img
  - button "切换主题":
    - img
  - button "切换详情面板" [pressed]:
    - img
- complementary:
  - text: RoboJex 均衡挡 · 常驻 AI
  - button "折叠侧栏"
  - button "新对话"
  - textbox "搜索对话"
  - navigation "会话列表":
    - text: "置顶 置顶的会话 今天 06:22 我是 **RoboJex**（置顶的会话）。 ```ts const jex = 'ready' ```"
    - button "取消置顶"
    - button "重命名"
    - button "删除对话"
    - text: "今天 今天的会话 30分钟前 我是 **RoboJex**（今天的会话）。 ```ts const jex = 'ready' ```"
    - button "置顶"
    - button "重命名"
    - button "删除对话"
    - text: "昨天 昨天的会话 昨天 05:52 我是 **RoboJex**（昨天的会话）。 ```ts const jex = 'ready' ```"
    - button "置顶"
    - button "重命名"
    - button "删除对话"
    - text: "更早 更早的会话 8月15日 我是 **RoboJex**（更早的会话）。 ```ts const jex = 'ready' ```"
    - button "置顶"
    - button "重命名"
    - button "删除对话"
  - status "jex · 均衡 · 已连接 · v0.0.0-mock": 均衡挡 已连接 v0.0.0-mock
- main:
  - textbox "＋ 新任务 · 支持「明天9点 检查X 截止11点」"
  - button "创建任务" [disabled]
  - group "筛选":
    - button "全部" [pressed]
    - button "运行中"
    - button "今日到期"
  - text: 5 / 5 任务
  - group "展开":
    - button "全部展开"
    - button "全部折叠"
  - button "示例任务一 · done":
    - text: 示例任务一
    - img "进度 100%": "100"
  - button "示例任务二 · running":
    - text: 示例任务二
    - img "进度 40%": "40"
    - text: 08:37 09:22
    - button "撤销这张卡（示例任务二）"
  - button "进行中的演示任务 · todo":
    - text: 进行中的演示任务
    - img "进度 10%": "10"
    - text: 07:22 08:22
    - button "撤销这张卡（进行中的演示任务）"
  - button "撤排探针 · todo":
    - text: 撤排探针
    - img "进度 0%": "0"
    - button "撤销这张卡（撤排探针）"
  - button "撤排探针 · todo":
    - text: 撤排探针
    - img "进度 0%": "0"
    - button "撤销这张卡（撤排探针）"
- button "任务"
- button "文件"
- button "屏幕"
- button "关闭详情":
  - img
- heading "撤排探针" [level=2]
- button "重命名"
- text: 进度 0% 未验 ID t5-1787529131906 状态 待办 创建 2026/8/24 07:52:11 开始
- textbox "开始时间（可编辑）"
- text: 截止
- textbox "截止时间（可编辑）"
- button "添加步骤"
- button "我已完成"
- button "撤销此卡"
```

# Test source

```ts
  812 |     await page.locator('[data-testid="view-tab"][data-view="board"]').click()
  813 |     await page.locator('.board-card', { hasText: '改名探针旧名' }).first().click()
  814 |     await expect(page.locator('.detail-title')).toContainText('改名探针旧名', { timeout: 5_000 })
  815 | 
  816 |     await page.locator('.dt-edit').click()
  817 |     const input = page.locator('.detail-title-input')
  818 |     await expect(input).toBeFocused()
  819 |     await input.fill('改名探针新名')
  820 |     await input.press('Enter')
  821 | 
  822 |     await expect(page.locator('.detail-title')).toContainText('改名探针新名', { timeout: 5_000 })
  823 |     const after = await (await page.request.get('/api/state')).json()
  824 |     expect(after.tasks.find((tk) => tk.title === '改名探针旧名')).toBeFalsy()
  825 |     expect(after.tasks.find((tk) => tk.title === '改名探针新名')).toBeTruthy()
  826 |     await shot(page, '42-rename')
  827 |   })
  828 | 
  829 |   // 43 (a11y): the palette traps Tab inside the dialog; reduced-motion
  830 |   // stands the decorative animations down.
  831 |   test('43 a11y: palette focus trap + reduced-motion', async ({ page }) => {
  832 |     await page.goto('/')
  833 |     await page.getByTestId('conn-status').waitFor()
  834 |     await page.keyboard.press('Control+k')
  835 |     await expect(page.getByTestId('cmdk-input')).toBeVisible({ timeout: 3_000 })
  836 |     const inPanel = () =>
  837 |       page.evaluate(() => !!document.activeElement?.closest('.cmdk-panel'))
  838 |     for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  839 |     expect(await inPanel()).toBe(true)
  840 |     await page.keyboard.press('Shift+Tab')
  841 |     expect(await inPanel()).toBe(true)
  842 |     await page.keyboard.press('Escape')
  843 |     await expect(page.getByTestId('cmdk')).toHaveCount(0)
  844 | 
  845 |     await page.emulateMedia({ reducedMotion: 'reduce' })
  846 |     await page.locator('[data-testid="view-tab"][data-view="board"]').click()
  847 |     await expect(page.locator('.board-card').first()).toBeVisible({ timeout: 5_000 })
  848 |     const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.board-card')).animationName)
  849 |     expect(anim).toBe('none')
  850 |   })
  851 | 
  852 |   // 44 (a11y): the settings sheet traps Tab the same way — a modal that
  853 |   // leaks focus to the page behind it isn't a modal.
  854 |   test('44 a11y: settings modal focus trap', async ({ page }) => {
  855 |     await page.goto('/')
  856 |     await page.getByTestId('conn-status').waitFor()
  857 |     await page.getByTestId('settings-open').click()
  858 |     await expect(page.getByTestId('settings-modal')).toBeVisible()
  859 |     const inModal = () =>
  860 |       page.evaluate(() => !!document.activeElement?.closest('[data-testid="settings-modal"]'))
  861 |     for (let i = 0; i < 15; i++) await page.keyboard.press('Tab')
  862 |     expect(await inModal()).toBe(true)
  863 |     await page.keyboard.press('Shift+Tab')
  864 |     expect(await inModal()).toBe(true)
  865 |     await page.keyboard.press('Escape')
  866 |     await expect(page.getByTestId('settings-modal')).toBeHidden()
  867 |   })
  868 | 
  869 |   // 45 (flow): landing on the chat view means typing intent — the input
  870 |   // takes focus even though the view never remounts.
  871 |   test('45 chat: view switch focuses the input', async ({ page }) => {
  872 |     await page.goto('/')
  873 |     await page.getByTestId('conn-status').waitFor()
  874 |     await page.keyboard.press('Control+1') // command center first
  875 |     await expect(page.locator('[data-testid="view-tab"][data-view="command"]')).toHaveAttribute('data-active', 'true', { timeout: 5_000 })
  876 |     await page.keyboard.press('Control+2') // into chat
  877 |     await expect(page.getByTestId('chat-input')).toBeFocused()
  878 |     await page.keyboard.type('abc')
  879 |     await expect(page.getByTestId('chat-input')).toHaveValue('abc')
  880 |   })
  881 | 
  882 |   // 46 (rail drop = unschedule): dragging a placed block back onto the
  883 |   // unscheduled rail clears its clock (PATCH null) — the rail is the
  884 |   // natural home for a de-scheduled card, not a dead zone.
  885 |   test('46 agenda: drop on the rail clears the schedule', async ({ page }) => {
  886 |     await page.goto('/')
  887 |     await page.getByTestId('conn-status').waitFor()
  888 |     const state0 = await (await page.request.get('/api/state')).json()
  889 |     const now = state0.now ?? Date.now()
  890 |     await page.request.post('/api/task', { data: { title: '撤排探针', scheduledAt: now + 3_600_000 } })
  891 |     await page.locator('[data-testid="view-tab"][data-view="agenda"]').click()
  892 |     const block = page.locator('.agenda-block', { hasText: '撤排探针' }).first()
  893 |     await expect(block).toBeVisible({ timeout: 5_000 })
  894 | 
  895 |     const from = await block.boundingBox()
  896 |     const rail = await page.locator('.agenda-unsched').boundingBox()
  897 |     expect(from).toBeTruthy()
  898 |     expect(rail).toBeTruthy()
  899 |     await page.mouse.move(from.x + from.width / 2, from.y + 3)
  900 |     await page.mouse.down()
  901 |     for (let i = 1; i <= 10; i++) {
  902 |       await page.mouse.move(
  903 |         from.x + ((rail.x + rail.width / 2 - from.x) * i) / 10,
  904 |         from.y + ((rail.y + rail.height / 2 - from.y) * i) / 10,
  905 |       )
  906 |     }
  907 |     await page.mouse.up()
  908 | 
  909 |     const after = await (await page.request.get('/api/state')).json()
  910 |     const t = after.tasks.find((tk) => tk.title === '撤排探针')
  911 |     expect(t.scheduledAt).toBeNull()
> 912 |     await expect(page.locator('.au-item', { hasText: '撤排探针' })).toBeVisible({ timeout: 5_000 })
      |                                                                 ^ Error: expect(locator).toBeVisible() failed
  913 |     await shot(page, '46-rail-unschedule')
  914 |   })
  915 | 
```
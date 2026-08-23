import { describe, expect, it } from 'vitest'
import { parseQuickTime } from '../src/views/quickTime'

// fixed "now": 2026-08-24 15:00 local-equivalent epoch
const NOW = new Date(2026, 7, 24, 15, 0).getTime()

describe('parseQuickTime', () => {
  it('explicit day word + 点 form strips the token and schedules', () => {
    const r = parseQuickTime('明天9点 检查磁盘', NOW)!
    expect(r.title).toBe('检查磁盘')
    expect(new Date(r.scheduledAt!).getHours()).toBe(9)
    expect(new Date(r.scheduledAt!).getDate()).toBe(25)
  })

  it('HH:MM today; a passed time rolls to tomorrow', () => {
    const keep = parseQuickTime('22:30 夜间巡检', NOW)!
    expect(new Date(keep.scheduledAt!).getHours()).toBe(22)
    expect(new Date(keep.scheduledAt!).getDate()).toBe(24)
    const roll = parseQuickTime('14:30 午后咖啡', NOW)!
    expect(new Date(roll.scheduledAt!).getDate()).toBe(25)
  })

  it('后天 + colon minutes + 截止 suffix parses a full window', () => {
    const r = parseQuickTime('后天10:30 复盘会 截止12点', NOW)!
    expect(r.title).toBe('复盘会')
    expect(new Date(r.scheduledAt!).getDate()).toBe(26)
    expect(new Date(r.scheduledAt!).getMinutes()).toBe(30)
    expect(new Date(r.dueAt!).getHours()).toBe(12)
  })

  it('inverted 截止 drops the due instead of guessing', () => {
    const r = parseQuickTime('明天9点 任务 截止8点', NOW)!
    expect(r.dueAt).toBeUndefined()
    expect(r.title).toBe('任务 截止8点')
  })

  it('no time token → null (plain create path)', () => {
    expect(parseQuickTime('随便一个任务', NOW)).toBeNull()
    expect(parseQuickTime('25点 越界', NOW)).toBeNull()
    expect(parseQuickTime('', NOW)).toBeNull()
  })

  it('en keyword pair: bare HH:MM + due suffix', () => {
    const r = parseQuickTime('9:00 check disks due 11:30', NOW)!
    expect(r.title).toBe('check disks')
    expect(new Date(r.scheduledAt!).getHours()).toBe(9)
    expect(new Date(r.dueAt!).getMinutes()).toBe(30)
  })
})

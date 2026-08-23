import { describe, expect, it } from 'vitest'
import { initialsOf, matchesInitials } from '../src/frame/pinyin'

describe('pinyin initials matcher', () => {
  it('derives per-char initials for the static UI vocabulary', () => {
    expect(initialsOf('驾驶舱')).toBe('jsc')
    expect(initialsOf('对话')).toBe('dh')
    expect(initialsOf('任务板')).toBe('rwb')
    expect(initialsOf('指挥中心')).toBe('zhzx')
  })

  it('latin passes through lowercased, digits/punct drop', () => {
    expect(initialsOf('RoboJex 0.2')).toBe('robojex')
  })

  it('unknown hanzi contribute nothing (user content falls back to includes)', () => {
    expect(initialsOf('魑魅魍魉')).toBe('')
  })

  it('subsequence, not substring: word-initial typing still hits', () => {
    expect(matchesInitials('指挥中心', 'zhx')).toBe(true) // zh + zx loosely typed
    expect(matchesInitials('指挥中心', 'zhzx')).toBe(true)
    expect(matchesInitials('驾驶舱', 'jsc')).toBe(true)
    expect(matchesInitials('驾驶舱', 'jscx')).toBe(false) // extra char not present
    expect(matchesInitials('对话', 'dh')).toBe(true)
    expect(matchesInitials('新对话', 'dh')).toBe(true) // subsequence allows the 新 gap
    expect(matchesInitials('浅色', 'qs')).toBe(true)
  })

  it('empty query matches everything', () => {
    expect(matchesInitials('任意', '')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { splitByCategory, composeFromCategories, revsDiffer } from './state-categories.js'

const S = {
  unit: 'kg', lang: 'en', theme: 'dark',
  routines: [{ id: 'r1', name: 'A' }], week: { 1: 'r1' }, dayPlan: {}, customEx: [],
  workouts: [{ d: '2026-08-20', entries: [] }],
  bodyweight: [{ d: '2026-08-20', w: 80 }],
  active: { exIdx: 0 }, _ts: 12345
}

describe('splitByCategory', () => {
  it('routes each field to exactly one category', () => {
    const cats = splitByCategory(S)
    expect(cats.routines).toEqual({ routines: S.routines, week: S.week, dayPlan: S.dayPlan, customEx: S.customEx })
    expect(cats.workouts).toEqual({ workouts: S.workouts })
    expect(cats.bodyweight).toEqual({ bodyweight: S.bodyweight })
    expect(cats.settings).toEqual({ unit: 'kg', lang: 'en', theme: 'dark' })
  })

  it('drops active and _ts from every category — neither is ever synced', () => {
    const cats = splitByCategory(S)
    for (const c of Object.values(cats)) { expect(c.active).toBeUndefined(); expect(c._ts).toBeUndefined() }
  })

  it('a field added to DEF later falls into settings automatically, with no mapping to update', () => {
    const cats = splitByCategory({ ...S, someNewSetting: 42 })
    expect(cats.settings.someNewSetting).toBe(42)
  })
})

describe('composeFromCategories', () => {
  it('round-trips through splitByCategory losslessly (minus active/_ts)', () => {
    const cats = splitByCategory(S)
    const { active, _ts, ...rest } = S
    expect(composeFromCategories(cats)).toEqual(rest)
  })
})

describe('revsDiffer', () => {
  const a = { routines: 1, workouts: 4, bodyweight: 0, settings: 2 }
  it('false when every category matches', () => {
    expect(revsDiffer(a, { ...a })).toBe(false)
  })
  it('true when exactly one category moved — the reason for splitting the columns at all', () => {
    expect(revsDiffer(a, { ...a, workouts: 5 })).toBe(true)
  })
  it('treats either side missing as different', () => {
    expect(revsDiffer(a, null)).toBe(true)
    expect(revsDiffer(null, null)).toBe(false)
  })
})

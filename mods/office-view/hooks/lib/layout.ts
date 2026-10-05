import type { OfficeLayout } from '../../types'

/** office.json が読めないときの既定のフロア構成。 */
export const DEFAULT_LAYOUT: OfficeLayout = {
  floors: [
    { name: '3階 役員フロア', desks: ['ソラ/本社', 'アオ/本社', '開発プロジェクト相談'] },
    {
      name: '2階 PMフロア',
      desks: ['モモ/PPPアプリ', 'モモ/報酬申請アプリ', 'モモ/VideoFlow', 'モモ/ヤフーフリマ', 'モモ/クリップ&フリップ'],
    },
    { name: '1階 ツールフロア', desks: ['アカ/ヤフーフリマ', 'アオ/ヤフーフリマ', 'クロ/ヤフーフリマ'] },
  ],
  colors: {
    ソラ: '#4aa3ff',
    アオ: '#2e8b57',
    モモ: '#ff7eb6',
    アカ: '#e0443e',
    クロ: '#5a5a66',
    キイ: '#f2c230',
  },
  labels: {},
}

const FALLBACK_COLORS = ['#e8833a', '#3fb6a8', '#8a6fd1', '#c9a227', '#d0577b', '#4f86c6']

/** 受け取った JSON を形だけ確かめて OfficeLayout にする。壊れていれば null。 */
export function parseLayout(value: unknown): OfficeLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.floors)) return null
  const floors = v.floors.flatMap(f => {
    if (typeof f !== 'object' || f === null) return []
    const ff = f as Record<string, unknown>
    if (typeof ff.name !== 'string' || !Array.isArray(ff.desks)) return []
    return [{ name: ff.name, desks: ff.desks.filter((d): d is string => typeof d === 'string') }]
  })
  if (floors.length === 0) return null
  return { floors, colors: stringMap(v.colors), labels: stringMap(v.labels) }
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(value)) if (typeof x === 'string') out[k] = x
  return out
}

/**
 * セッション名や宛先から席名を取り出す。
 * "[モモ/PPPアプリ] 要件" → "モモ/PPPアプリ"、"ソラ/本社" → "ソラ/本社"
 */
export function deskKey(address: string): string {
  const m = /\[([^\]]+)\]/.exec(address)
  return (m?.[1] ?? address).trim()
}

/** 席名からキャラ名を取り出す。"モモ/PPPアプリ" → "モモ"、"開発プロジェクト相談" → そのまま */
export function charName(address: string): string {
  const key = deskKey(address)
  const slash = key.indexOf('/')
  return slash > 0 ? key.slice(0, slash) : key
}

export type DeskRef = { floor: number; index: number; desk: string }

/** 宛先がどの席か。完全一致 → 同じキャラ名の最初の席 → 見つからなければ null（来客扱い） */
export function findDesk(layout: OfficeLayout, address: string): DeskRef | null {
  const key = deskKey(address)
  if (key === '') return null
  for (const [floor, f] of layout.floors.entries()) {
    const index = f.desks.indexOf(key)
    if (index >= 0) return { floor, index, desk: key }
  }
  const name = charName(key)
  for (const [floor, f] of layout.floors.entries()) {
    const index = f.desks.findIndex(d => charName(d) === name)
    if (index >= 0) return { floor, index, desk: f.desks[index] ?? key }
  }
  return null
}

/**
 * 図に出す短い名前。labels にあればそれ。同じ階に同じキャラが何席もあるときは案件名を
 * 5 文字まで、それ以外はキャラ名。
 */
export function labelOf(layout: OfficeLayout, desk: string): string {
  const key = deskKey(desk)
  const set = layout.labels[key] ?? layout.labels[desk]
  if (set !== undefined) return set
  const name = charName(key)
  const slash = key.indexOf('/')
  const floor = layout.floors.find(f => f.desks.includes(key))
  const same = floor?.desks.filter(d => charName(d) === name).length ?? 0
  if (slash > 0 && same > 1) return Array.from(key.slice(slash + 1)).slice(0, 5).join('')
  return name
}

/** 説明行とログに出す名前。「キャラ/案件」の形ならそのまま、それ以外は labels の呼び名。 */
export function nameOf(layout: OfficeLayout, address: string): string {
  const key = deskKey(address)
  if (key === '') return '(未登録)'
  return key.includes('/') ? key : (layout.labels[key] ?? key)
}

/** キャラの色。colors にキャラ名か席名があればそれ、無ければ名前から決まる固定色。 */
export function colorOf(layout: OfficeLayout, desk: string): string {
  const name = charName(desk)
  const set = layout.colors[name] ?? layout.colors[deskKey(desk)]
  if (set !== undefined) return set
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length] ?? '#888888'
}

/** 本文の最初の空でない行を 40 文字までに切る。連絡板には本文を残さない。 */
export function summarize(text: string): string {
  const line = text
    .split('\n')
    .map(s => s.trim())
    .find(s => s !== '')
  if (line === undefined) return '(空のメッセージ)'
  const chars = Array.from(line)
  return chars.length > 40 ? chars.slice(0, 39).join('') + '…' : line
}

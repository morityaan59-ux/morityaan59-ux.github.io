import type { OfficeAnim, OfficeLayout } from '../../types'
import type { DeskState } from './activity'
import { colorOf, findDesk, nameOf, tagOf } from './layout'

/** 歩くコマ数（120ms × 20 = 2.4 秒）。 */
export const WALK_FRAMES = 20
/** 着いてから吹き出しを出しておくコマ数（3 秒）。 */
export const BUBBLE_FRAMES = 25
/** 受信の「！」を出すコマ数（約 1 秒）。 */
export const PING_FRAMES = 8

export function totalFrames(anim: OfficeAnim): number {
  return anim.event.kind === 'send' ? WALK_FRAMES + BUBBLE_FRAMES : PING_FRAMES
}

// 座標は幅 100 の単位。サイドバーに置けるよう縦に積む。
const VW = 100
const ROOM_X = 2
const ROOM_W = 82
const COR_X = 86
const COR_W = 12
const COR_MID = COR_X + COR_W / 2
const TOP = 2
const HEADER_H = 8
const FLOOR_GAP = 4
/** 1 席の高さ: 吹き出し 8 + キャラ 12 + 机 2 + 名札 2 行 + 状態 1 行 */
const CELL_H = 35
const COLS = 2
const BLOB_W = 11
const BLOB_H = 11
const BLOB_TOP = 8

export type Cell = { floor: number; index: number; desk: string; column: number; cx: number; top: number }
export type Room = { floor: number; headerY: number; boxY: number; boxH: number }
export type Geometry = { width: number; height: number; rooms: Room[]; cells: Cell[] }
/** キャラの位置。x は中心、y は頭のてっぺん。 */
export type Point = { x: number; y: number }

export function geometry(layout: OfficeLayout): Geometry {
  const rooms: Room[] = []
  const cells: Cell[] = []
  const colW = ROOM_W / COLS
  let y = TOP
  for (const [floor, f] of layout.floors.entries()) {
    const headerY = y
    const boxY = y + HEADER_H
    const rows = Math.max(1, Math.ceil(f.desks.length / COLS))
    const boxH = rows * CELL_H + 4
    for (const [index, desk] of f.desks.entries()) {
      const column = index % COLS
      const row = Math.floor(index / COLS)
      cells.push({ floor, index, desk, column, cx: ROOM_X + colW * column + colW / 2, top: boxY + 2 + row * CELL_H })
    }
    rooms.push({ floor, headerY, boxY, boxH })
    y = boxY + boxH + FLOOR_GAP
  }
  return { width: VW, height: y, rooms, cells }
}

function cellOf(geo: Geometry, layout: OfficeLayout, address: string): Cell | null {
  const ref = findDesk(layout, address)
  if (ref === null) return null
  return geo.cells.find(c => c.floor === ref.floor && c.index === ref.index) ?? null
}

/** 席が見つからない相手は、廊下の一番下（入口）に立つ来客として描く。 */
function visitorPoint(geo: Geometry): Point {
  const last = geo.rooms[geo.rooms.length - 1]
  return { x: COR_MID, y: last === undefined ? TOP : last.boxY + last.boxH - BLOB_H - 4 }
}

function pointOf(geo: Geometry, layout: OfficeLayout, address: string): Point {
  const c = cellOf(geo, layout, address)
  return c === null ? visitorPoint(geo) : { x: c.cx, y: c.top + BLOB_TOP }
}

/** 席 → 右の廊下 → 相手の階 → 相手の席の隣、の折れ線。同じ段の席どうしなら直接。 */
export function walkPath(layout: OfficeLayout, from: string, to: string): Point[] {
  const geo = geometry(layout)
  const fc = cellOf(geo, layout, from)
  const tc = cellOf(geo, layout, to)
  const a = pointOf(geo, layout, from)
  const t = pointOf(geo, layout, to)
  const b = tc === null ? t : { x: t.x + (tc.column === COLS - 1 ? -13 : 13), y: t.y }
  if (fc !== null && tc !== null && fc.floor === tc.floor && fc.top === tc.top) return [a, b]
  return [a, { x: COR_MID, y: a.y }, { x: COR_MID, y: b.y }, b]
}

/** 折れ線の上を t（0〜1）だけ進んだ位置。 */
export function along(path: readonly Point[], t: number): Point {
  const first = path[0] ?? { x: 0, y: 0 }
  if (path.length < 2) return first
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!
    const q = path[i]!
    const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y)
    lengths.push(d)
    total += d
  }
  if (total === 0) return first
  let left = Math.min(1, Math.max(0, t)) * total
  for (let i = 1; i < path.length; i++) {
    const d = lengths[i - 1] ?? 0
    const p = path[i - 1]!
    const q = path[i]!
    if (left <= d || i === path.length - 1) {
      const k = d === 0 ? 1 : Math.min(1, left / d)
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }
    }
    left -= d
  }
  return path[path.length - 1] ?? first
}

// ---- SVG の部品 ----

function n(v: number): string {
  return String(Math.round(v * 100) / 100)
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function rgb(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  const v = m?.[1] !== undefined ? parseInt(m[1], 16) : 0x888888
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function hexOf([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')
}

/** 白に寄せた色（k=0 でそのまま、1 で白）。 */
export function lighter(color: string, k: number): string {
  const [r, g, b] = rgb(color)
  return hexOf([r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k])
}

/** 暗くした色（k=1 でそのまま）。 */
export function darker(color: string, k: number): string {
  const [r, g, b] = rgb(color)
  return hexOf([r * k, g * k, b * k])
}

/** おばけ餅のようなキャラ。上が丸く、すそに 3 つのふくらみ。 */
function blob(cx: number, top: number, color: string, bob = 0): string {
  const w = BLOB_W
  const h = BLOB_H
  const x = cx - w / 2
  const y = top - bob
  const r = w / 2
  const d =
    `M${n(x)} ${n(y + h)}V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h)}` +
    `Q${n(x + (w * 5) / 6)} ${n(y + h + 1.4)} ${n(x + (w * 2) / 3)} ${n(y + h)}` +
    `Q${n(x + w / 2)} ${n(y + h + 1.4)} ${n(x + w / 3)} ${n(y + h)}` +
    `Q${n(x + w / 6)} ${n(y + h + 1.4)} ${n(x)} ${n(y + h)}Z`
  return [
    `<path d="${d}" fill="${lighter(color, 0.3)}" stroke="${darker(color, 0.62)}" stroke-width=".4"/>`,
    `<ellipse cx="${n(x + w * 0.3)}" cy="${n(y + h * 0.24)}" rx="1.5" ry=".8" fill="#fff" opacity=".55"/>`,
    `<ellipse cx="${n(x + w * 0.36)}" cy="${n(y + h * 0.5)}" rx=".72" ry="1.05" fill="#2b2430"/>`,
    `<ellipse cx="${n(x + w * 0.64)}" cy="${n(y + h * 0.5)}" rx=".72" ry="1.05" fill="#2b2430"/>`,
    `<ellipse cx="${n(x + w * 0.22)}" cy="${n(y + h * 0.66)}" rx="1.1" ry=".55" fill="#ff7a9a" opacity=".45"/>`,
    `<ellipse cx="${n(x + w * 0.78)}" cy="${n(y + h * 0.66)}" rx="1.1" ry=".55" fill="#ff7a9a" opacity=".45"/>`,
  ].join('')
}

function clip(text: string, max: number): string {
  const cs = Array.from(text)
  return cs.length > max ? cs.slice(0, max - 1).join('') + '…' : text
}

/** 名札を 1 行 11 文字、最大 2 行に折る。「案件のキャラ」は「の」の後ろで折って、キャラ名を割らない。 */
export function wrapTag(text: string, per = 11, lines = 2): string[] {
  const cs = Array.from(text)
  if (cs.length <= per) return [text]
  const joint = cs.lastIndexOf('の')
  if (lines >= 2 && joint >= 0 && joint + 1 <= per && cs.length - joint - 1 <= per) {
    return [cs.slice(0, joint + 1).join(''), cs.slice(joint + 1).join('')]
  }
  const out: string[] = []
  for (let i = 0; i < cs.length && out.length < lines; i += per) out.push(cs.slice(i, i + per).join(''))
  if (cs.length > per * lines) out[lines - 1] = cs.slice(per * (lines - 1), per * lines - 1).join('') + '…'
  return out.length === 0 ? [''] : out
}

/** 角の丸い吹き出し。bottom はしっぽの先の y。 */
function bubble(cx: number, bottom: number, text: string, minX: number, maxX: number, isStrong: boolean): string {
  const t = clip(text, 12)
  const w = Math.max(10, Math.min(maxX - minX, Array.from(t).length * 2.9 + 4))
  const x = Math.max(minX, Math.min(maxX - w, cx - w / 2))
  const h = 5.4
  const y = bottom - h - 1.3
  const stroke = isStrong ? '#2b2b2b' : '#6b6b6b'
  return [
    `<path d="M${n(cx - 1.1)} ${n(y + h - 0.3)}L${n(cx)} ${n(bottom)}L${n(cx + 1.1)} ${n(y + h - 0.3)}Z" fill="#fff" stroke="${stroke}" stroke-width=".35"/>`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="2.4" fill="#fff" stroke="${stroke}" stroke-width="${isStrong ? '.45' : '.35'}"/>`,
    `<rect x="${n(cx - 0.9)}" y="${n(y + h - 0.6)}" width="1.8" height=".7" fill="#fff"/>`,
    `<text x="${n(x + w / 2)}" y="${n(y + 3.8)}" font-size="2.9" text-anchor="middle" fill="#222"${isStrong ? ' font-weight="bold"' : ''}>${esc(t)}</text>`,
  ].join('')
}

export type Drawn = { svg: string; caption: string | null }

export type DrawOptions = {
  layout: OfficeLayout
  anim: OfficeAnim | null
  states: ReadonlyMap<string, DeskState>
  /** CSS ピクセルでの表示幅。高さは縦横比から決まる。 */
  width: number
}

/** オフィス全体を 1 コマ、縦長の SVG で描く。 */
export function drawSvg(o: DrawOptions): Drawn {
  const { layout, anim, states } = o
  const geo = geometry(layout)
  const height = geo.height
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${n(height)}" width="${Math.round(o.width)}" height="${Math.round((o.width * height) / VW)}"` +
      ` font-family="'Hiragino Maru Gothic ProN','Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdf6e3"/><stop offset="1" stop-color="#fbf1ef"/></linearGradient></defs>`,
    `<rect width="${VW}" height="${n(height)}" fill="url(#bg)"/>`,
  )

  // 右の廊下と階段
  const first = geo.rooms[0]
  const last = geo.rooms[geo.rooms.length - 1]
  if (first !== undefined && last !== undefined) {
    const y0 = first.boxY
    const y1 = last.boxY + last.boxH
    parts.push(`<rect x="${COR_X}" y="${n(y0)}" width="${COR_W}" height="${n(y1 - y0)}" rx="2.5" fill="#f0e6d4"/>`)
    for (const room of geo.rooms.slice(1)) {
      const sy = room.boxY - FLOOR_GAP / 2 + 5
      const sx = COR_X + 2
      parts.push(
        `<path d="M${sx} ${n(sy)}h2v-2h2v-2h2v-2h2" fill="none" stroke="#b39d80" stroke-width=".6" stroke-linejoin="round"/>`,
      )
    }
    parts.push(`<text x="${COR_MID}" y="${n(y1 - 1.6)}" font-size="2.3" text-anchor="middle" fill="#9a8a70">入口</text>`)
  }

  const walking = anim !== null && anim.event.kind === 'send' ? anim : null
  const awayDesk = walking === null ? null : (findDesk(layout, walking.event.from)?.desk ?? null)
  const targetDesk = anim === null ? null : (findDesk(layout, anim.event.to)?.desk ?? null)

  for (const room of geo.rooms) {
    const floor = layout.floors[room.floor]
    if (floor === undefined) continue
    const sub = floor.subtitle === undefined ? '' : `<tspan font-size="2.7" font-weight="normal" fill="#8a7f72" dx="2">${esc(floor.subtitle)}</tspan>`
    parts.push(
      `<text x="${ROOM_X + 1}" y="${n(room.headerY + 5.6)}" font-size="4.2" font-weight="bold" fill="#3a2e24">${esc(floor.name)}${sub}</text>`,
      `<rect x="${ROOM_X}" y="${n(room.boxY)}" width="${ROOM_W}" height="${n(room.boxH)}" rx="3" fill="#fffdf8" fill-opacity=".75" stroke="#8a8174" stroke-width=".35" stroke-dasharray="1.2 1"/>`,
    )
    if (floor.role !== undefined) {
      parts.push(`<text x="${ROOM_X + 2.5}" y="${n(room.boxY + 4.4)}" font-size="3" font-weight="bold" fill="#3b4a6b">${esc(floor.role)}</text>`)
    }
  }

  const bubbles: string[] = []
  for (const cell of geo.cells) {
    const state = states.get(cell.desk)
    const isAway = cell.desk === awayDesk
    const isQuiet = state === undefined || (!state.isHere && state.pending === null)
    const color = colorOf(layout, cell.desk)
    const colW = ROOM_W / COLS
    const minX = ROOM_X + colW * cell.column + 1
    const maxX = minX + colW - 2
    const blobTop = cell.top + BLOB_TOP

    const g: string[] = []
    if (isAway) {
      g.push(
        `<ellipse cx="${n(cell.cx)}" cy="${n(blobTop + BLOB_H / 2 + 1)}" rx="${BLOB_W / 2}" ry="${BLOB_H / 2}" fill="none" stroke="#c9bfb2" stroke-width=".35" stroke-dasharray=".8 .8"/>`,
      )
    } else {
      g.push(blob(cell.cx, blobTop, color))
    }
    // 机（キャラの下の弧）
    const deskY = blobTop + BLOB_H + 2
    g.push(
      `<path d="M${n(cell.cx - 10)} ${n(deskY)}q0 1.6 1.6 1.6h16.8q1.6 0 1.6 -1.6" fill="none" stroke="${isQuiet ? '#c9c2b8' : '#e8833a'}" stroke-width=".6" stroke-linecap="round"/>`,
    )
    // 名札と状態
    const lines = wrapTag(tagOf(layout, cell.desk))
    const hasMark = state?.pending !== null && state?.pending !== undefined
    for (const [i, line] of lines.entries()) {
      const mark = hasMark && i === lines.length - 1 ? '<tspan fill="#e23b3b">!</tspan>' : ''
      g.push(
        `<text x="${n(cell.cx)}" y="${n(cell.top + 26.2 + i * 3.6)}" font-size="3.1" font-weight="bold" text-anchor="middle" fill="${isQuiet ? '#8d867d' : '#2b2b2b'}">${esc(line)}${mark}</text>`,
      )
    }
    const statusY = cell.top + 26.2 + lines.length * 3.6
    const status = isAway ? '移動中' : (state?.status ?? '')
    g.push(`<text x="${n(cell.cx)}" y="${n(statusY)}" font-size="2.5" text-anchor="middle" fill="#8d867d">${esc(status)}</text>`)
    parts.push(isQuiet && !isAway ? `<g opacity=".42">${g.join('')}</g>` : g.join(''))

    // 返事待ちの指示は吹き出しで残す（いま歩いて届けている相手は、着いてからの吹き出しに任せる）
    if (state?.pending != null && cell.desk !== targetDesk && !isAway) {
      bubbles.push(bubble(cell.cx, blobTop - 0.6, state.pending.summary, minX, maxX, false))
    }
  }

  let caption: string | null = null
  if (anim !== null) {
    const ev = anim.event
    if (ev.kind === 'send') {
      const path = walkPath(layout, ev.from, ev.to)
      const isWalking = anim.frame < WALK_FRAMES
      const pos = along(path, anim.frame / WALK_FRAMES)
      const bob = isWalking && anim.frame % 2 === 1 ? 0.9 : 0
      parts.push(blob(pos.x, pos.y, colorOf(layout, ev.from), bob))
      if (findDesk(layout, ev.from) === null) {
        parts.push(`<text x="${n(pos.x)}" y="${n(pos.y + BLOB_H + 4)}" font-size="2.5" text-anchor="middle" fill="#5b4a3a">${esc(clip(nameOf(layout, ev.from), 6))}</text>`)
      }
      if (isWalking) {
        caption = `🚶 ${nameOf(layout, ev.from)} が ${nameOf(layout, ev.to)} のところへ向かっています`
      } else {
        bubbles.push(bubble(pos.x, pos.y - 0.6, ev.summary, ROOM_X + 1, ROOM_X + ROOM_W - 1, true))
        caption = `💬 ${nameOf(layout, ev.from)} → ${nameOf(layout, ev.to)}「${ev.summary}」`
      }
    } else {
      const p = pointOf(geo, layout, ev.to)
      if (anim.frame % 2 === 0) {
        parts.push(`<text x="${n(p.x + 7)}" y="${n(p.y + 3)}" font-size="6" font-weight="bold" fill="#e23b3b">!</text>`)
      }
      caption = `❗ ${nameOf(layout, ev.to)} が指示を受け取りました`
    }
  }

  parts.push(...bubbles, '</svg>')
  return { svg: parts.join(''), caption }
}

/** ターミナル用の小さなドット絵キャラ（8×8）。X=体 e=目 .=透明 */
export const BLOB_SPRITE = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXeXXeXX', 'XXeXXeXX', 'XXXXXXXX', 'XXXXXXXX', 'X.XXXX.X'] as const

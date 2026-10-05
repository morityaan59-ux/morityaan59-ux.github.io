import type { OfficeAnim, OfficeLayout } from '../../types'
import { colorOf, findDesk, labelOf, nameOf, type DeskRef } from './layout'
import { CLEAR, frame, hex, rect, sprite, type Frame, type SvgText } from './pixels'

/** 1 フロアの高さ（ピクセル）。 */
export const FLOOR_H = 24
/** 歩くコマ数（120ms × 20 = 2.4 秒）。 */
export const WALK_FRAMES = 20
/** 吹き出しを出しておくコマ数（3 秒）。 */
export const BUBBLE_FRAMES = 25
/** 受信の「！」を出すコマ数（約 1 秒）。 */
export const PING_FRAMES = 8

const DESK_LEFT = 14
const STAIRS_W = 16

export function totalFrames(anim: OfficeAnim): number {
  return anim.event.kind === 'send' ? WALK_FRAMES + BUBBLE_FRAMES : PING_FRAMES
}

const WOOD = hex('#8b6f4e')
const DESK_TOP = hex('#b8875a')
const DESK_LEG = hex('#6b4e31')
const STEP = hex('#b9ad9f')
const STEP_EDGE = hex('#857a6e')
const DOOR = hex('#7a5a3a')
const SKIN = hex('#f5cfa8')
const LEGS = hex('#3b3b4a')
const RED = hex('#e23b3b')
const BUBBLE = hex('#ffffff')
const BUBBLE_EDGE = hex('#3b3b4a')

// キャラのドット絵（幅 7 × 高さ 10）。H=髪 S=肌 B=服 L=脚
const HEAD = ['..HHH..', '.HHHHH.', '.HSSSH.', '..SSS..', '.BBBBB.', 'B.BBB.B', '..BBB..']
const LEGS_STAND = ['..L.L..', '..L.L..', '.LL.LL.']
const LEGS_STEP_A = ['..L.L..', '.L...L.', 'LL...LL']
const LEGS_STEP_B = ['...LL..', '...LL..', '..LLL..']
const DESK = ['TTTTTTTTT', 'D.......D', 'D.......D', 'D.......D']

function person(f: Frame, x: number, y: number, color: string, legs: readonly string[]): void {
  const c = hex(color)
  sprite(f, x, y, [...HEAD, ...legs], { H: darker(c), S: SKIN, B: c, L: LEGS })
}

function darker(c: number): number {
  const r = Math.round(((c >> 16) & 0xff) * 0.6)
  const g = Math.round(((c >> 8) & 0xff) * 0.6)
  const b = Math.round((c & 0xff) * 0.6)
  return (r << 16) | (g << 8) | b
}

export type Point = { x: number; y: number }

/** 席にいるキャラの左上座標。 */
export function deskPoint(layout: OfficeLayout, w: number, ref: DeskRef): Point {
  const floor = layout.floors[ref.floor]
  const n = Math.max(1, floor?.desks.length ?? 1)
  const usable = w - DESK_LEFT - STAIRS_W - 2
  const slot = usable / n
  const x = DESK_LEFT + ref.index * slot + Math.max(0, (slot - 7) / 2)
  return { x: Math.round(x), y: ref.floor * FLOOR_H + FLOOR_H - 11 }
}

/** 席が見つからない相手は、一番下の階の入口に立つ来客として描く。 */
export function visitorPoint(layout: OfficeLayout): Point {
  const last = Math.max(0, layout.floors.length - 1)
  return { x: 3, y: last * FLOOR_H + FLOOR_H - 11 }
}

function pointOf(layout: OfficeLayout, w: number, address: string): Point {
  const ref = findDesk(layout, address)
  return ref === null ? visitorPoint(layout) : deskPoint(layout, w, ref)
}

/** 席 → 階段 → 相手の階 → 相手の席の右隣、の折れ線。 */
export function walkPath(layout: OfficeLayout, w: number, from: string, to: string): Point[] {
  const a = pointOf(layout, w, from)
  const target = pointOf(layout, w, to)
  const b = { x: Math.min(w - STAIRS_W - 8, target.x + 9), y: target.y }
  if (a.y === b.y) return [a, b]
  const sx = w - STAIRS_W + 4
  return [a, { x: sx, y: a.y }, { x: sx, y: b.y }, b]
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

export type Scene = {
  frame: Frame
  /** SVG にだけ重ねる文字（ターミナルは文字を別の行で出す）。 */
  texts: SvgText[]
  /** いま何が起きているかの 1 行。 */
  caption: string | null
}

/** オフィス全体を 1 コマ描く。 */
export function drawScene(layout: OfficeLayout, w: number, anim: OfficeAnim | null, me: string): Scene {
  const floors = layout.floors.length
  const h = floors * FLOOR_H
  const f = frame(w, h)
  const texts: SvgText[] = []

  const walking = anim !== null && anim.event.kind === 'send'
  const fromRef = walking ? findDesk(layout, anim.event.from) : null

  for (const [i, floor] of layout.floors.entries()) {
    const y0 = i * FLOOR_H
    // 床
    rect(f, 0, y0 + FLOOR_H - 1, w, 1, WOOD)
    // 上の階へ上がる階段（一番上の階には無い）
    if (i > 0) {
      const sx = w - STAIRS_W
      for (let s = 0; s < 7; s++) {
        const hgt = Math.round(((s + 1) * (FLOOR_H - 2)) / 7)
        rect(f, sx + s * 2, y0 + FLOOR_H - 1 - hgt, 2, hgt, STEP)
        rect(f, sx + s * 2, y0 + FLOOR_H - 1 - hgt, 2, 1, STEP_EDGE)
      }
    }
    texts.push({ x: 1.5, y: y0 + 4.2, text: floor.name, size: 3.2, color: '#5b4a3a', bold: true })

    for (const [index, desk] of floor.desks.entries()) {
      const p = deskPoint(layout, w, { floor: i, index, desk })
      const isAway = fromRef !== null && fromRef.floor === i && fromRef.index === index
      if (!isAway) person(f, p.x, p.y, colorOf(layout, desk), LEGS_STAND)
      sprite(f, p.x - 1, p.y + 6, DESK, { T: DESK_TOP, D: DESK_LEG })
      const isMe = me !== '' && findDesk(layout, me)?.desk === desk
      texts.push({
        x: p.x + 3.5,
        y: p.y - 1,
        text: labelOf(layout, desk),
        size: 3,
        color: isMe ? '#c0392b' : '#3b3b4a',
        anchor: 'middle',
        bold: isMe,
      })
    }
  }
  // 入口のドア（一番下の階の左端）
  const lastY = (floors - 1) * FLOOR_H
  rect(f, 1, lastY + FLOOR_H - 13, 1, 12, DOOR)

  let caption: string | null = null
  if (anim !== null) {
    const ev = anim.event
    if (ev.kind === 'send') {
      const path = walkPath(layout, w, ev.from, ev.to)
      const t = anim.frame / WALK_FRAMES
      const pos = along(path, t)
      const legs = anim.frame >= WALK_FRAMES ? LEGS_STAND : Math.floor(anim.frame / 2) % 2 === 0 ? LEGS_STEP_A : LEGS_STEP_B
      person(f, pos.x, pos.y, colorOf(layout, ev.from), legs)
      if (findDesk(layout, ev.from) === null) {
        texts.push({ x: pos.x + 3.5, y: pos.y - 1, text: labelOf(layout, ev.from), size: 3, color: '#3b3b4a', anchor: 'middle' })
      }
      if (anim.frame >= WALK_FRAMES) {
        const text = Array.from(ev.summary).slice(0, 14).join('')
        const bw = Math.min(w - 2, Math.round(4 + Array.from(text).length * 3.3))
        const bx = Math.max(1, Math.min(w - bw - 1, Math.round(pos.x + 3 - bw / 2)))
        const by = Math.max(0, Math.round(pos.y - 9))
        rect(f, bx, by, bw, 6, BUBBLE_EDGE)
        rect(f, bx + 1, by + 1, bw - 2, 4, BUBBLE)
        rect(f, Math.round(pos.x + 3), by + 6, 1, 1, BUBBLE_EDGE)
        texts.push({ x: bx + bw / 2, y: by + 4.3, text, size: 3.2, color: '#222222', anchor: 'middle' })
        caption = `💬 ${nameOf(layout, ev.from)} → ${nameOf(layout, ev.to)}「${ev.summary}」`
      } else {
        caption = `🚶 ${nameOf(layout, ev.from)} が ${nameOf(layout, ev.to)} のところへ向かっています`
      }
    } else {
      const p = pointOf(layout, w, ev.to)
      if (anim.frame % 2 === 0) {
        rect(f, p.x + 8, p.y - 2, 1, 3, RED)
        rect(f, p.x + 8, p.y + 2, 1, 1, RED)
      }
      caption = `❗ ${nameOf(layout, ev.to)} が指示を受け取りました`
    }
  }

  return { frame: f, texts, caption }
}

export { CLEAR }

import type { OfficeEvent, OfficeLayout } from '../../types'
import { deskKey, findDesk } from './layout'

/** この時間内に在席の合図があれば「在席」。合図は 30 秒ごとなので 3 回分。 */
export const PRESENT_MS = 90_000
/** 返事が無いまま「指示あり」を出し続ける上限。 */
export const PENDING_MS = 7 * 24 * 60 * 60_000
/** 「送信 N分前」を出す上限。 */
const SENT_MS = 24 * 60 * 60_000

export type DeskState = {
  desk: string
  isHere: boolean
  isMe: boolean
  /** 返事をまだしていない、最後に受けた指示 */
  pending: OfficeEvent | null
  /** 名札の下に出す 1 行 */
  status: string
}

export function ago(ms: number): string {
  if (ms < 60_000) return '今'
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}分前`
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}時間前`
  return `${Math.floor(ms / (24 * 60 * 60_000))}日前`
}

/** 自分の席名を、図の上の席名にそろえる。 */
export function meDesk(layout: OfficeLayout, me: string): string {
  if (me === '') return ''
  return findDesk(layout, me)?.desk ?? deskKey(me)
}

/**
 * 席ごとの状態。指示を受けた後に自分から何か送るまでは「指示あり」、
 * 最近送っていれば「送信」、在席の合図が新しければ「在席」、それ以外は「退勤」。
 */
export function deskStates(
  layout: OfficeLayout,
  log: readonly OfficeEvent[],
  presence: Readonly<Record<string, number>>,
  now: number,
  me: string,
): Map<string, DeskState> {
  const lastTo = new Map<string, OfficeEvent>()
  const lastFrom = new Map<string, OfficeEvent>()
  for (const ev of log) {
    if (ev.kind !== 'send') continue
    const to = findDesk(layout, ev.to)?.desk
    const prevTo = to === undefined ? undefined : lastTo.get(to)
    if (to !== undefined && (prevTo === undefined || prevTo.at <= ev.at)) lastTo.set(to, ev)
    const from = findDesk(layout, ev.from)?.desk
    const prevFrom = from === undefined ? undefined : lastFrom.get(from)
    if (from !== undefined && (prevFrom === undefined || prevFrom.at <= ev.at)) lastFrom.set(from, ev)
  }

  const mine = meDesk(layout, me)
  const out = new Map<string, DeskState>()
  for (const floor of layout.floors) {
    for (const desk of floor.desks) {
      const isMe = desk === mine
      const beat = presence[desk]
      const isHere = isMe || (beat !== undefined && now - beat < PRESENT_MS)
      const to = lastTo.get(desk)
      const from = lastFrom.get(desk)
      const pending =
        to !== undefined && (from === undefined || from.at < to.at) && now - to.at < PENDING_MS ? to : null
      let status: string
      if (pending !== null) status = `指示あり ${ago(now - pending.at)}`
      else if (!isHere) status = '退勤'
      else if (from !== undefined && now - from.at < SENT_MS) status = `送信 ${ago(now - from.at)}`
      else status = '在席'
      if (isMe) status += '・あなた'
      out.set(desk, { desk, isHere, isMe, pending, status })
    }
  }
  return out
}

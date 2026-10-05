/** 連絡板の1行。本文は持たず、要約1行だけ。 */
export type OfficeEvent = {
  id: string
  at: number
  from: string
  to: string
  summary: string
  kind: 'send' | 'receive'
}

/** 再生中のアニメ。frame は 120ms ごとに 1 進む。 */
export type OfficeAnim = { event: OfficeEvent; frame: number }

export type OfficeFloor = { name: string; desks: string[] }

export type OfficeLayout = {
  floors: OfficeFloor[]
  /** キャラ名 → '#rrggbb' */
  colors: Record<string, string>
  /** 席名 → 図に出す短い名前 */
  labels: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'office-view': {
      log: OfficeEvent[]
      queue: OfficeEvent[]
      anim: OfficeAnim | null
      seen: string[]
      isOpen: boolean
      me: string
      layout: OfficeLayout | null
    }
  }
}

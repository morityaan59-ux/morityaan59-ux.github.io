import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OfficeEvent, OfficeLayout } from '../types'
import { deskStates, meDesk } from './lib/activity'
import { colorOf, DEFAULT_LAYOUT, findDesk, nameOf, parseLayout, summarize, tagOf } from './lib/layout'
import { frame, hex, sprite, toRaster } from './lib/pixels'
import { BLOB_SPRITE, drawSvg, lighter, totalFrames } from './lib/vertical'

const PANE = 'office'
const LOG_PREFIX = 'log:'
const DESK_PREFIX = 'desk:'
const HERE_PREFIX = 'here:'
const POLL_MS = 500
const TICK_MS = 120
const HEARTBEAT_MS = 30_000
const KEEP_PER_SESSION = 50
const KEEP_SEEN = 400
const KEEP_LOG = 30

const logA = atom({ plugin: 'office-view', key: 'log' } as const, [])
const queueA = atom({ plugin: 'office-view', key: 'queue' } as const, [])
const animA = atom({ plugin: 'office-view', key: 'anim' } as const, null)
const seenA = atom({ plugin: 'office-view', key: 'seen' } as const, [])
const isOpenA = atom({ plugin: 'office-view', key: 'isOpen' } as const, false)
const meA = atom({ plugin: 'office-view', key: 'me' } as const, '')
const layoutA = atom({ plugin: 'office-view', key: 'layout' } as const, null)
const presenceA = atom({ plugin: 'office-view', key: 'presence' } as const, {})
const nowA = atom({ plugin: 'office-view', key: 'now' } as const, 0)

type $ = EngineInterface

// タイマーはモジュールの変数。リロードで消えるので session.start で張り直す。
let poller: Timer | null = null
let ticker: Timer | null = null
let beater: Timer | null = null
let isPolling = false
let isTicking = false

async function layoutOf($: $): Promise<OfficeLayout> {
  return (await read($, layoutA)) ?? DEFAULT_LAYOUT
}

/** 自分のセッションのキーに 1 行追記する。他のセッションとキーが別なので書き込みがぶつからない。 */
async function append($: $, ev: Omit<OfficeEvent, 'id' | 'at'>): Promise<void> {
  const sid = await $.session.id()
  const at = await $.clock.now()
  const key = LOG_PREFIX + sid
  const prev = await $.store.get(key)
  const list = Array.isArray(prev) ? (prev as OfficeEvent[]) : []
  const id = `${sid}:${at}:${list.length}`
  await $.store.set(key, [...list, { ...ev, id, at }].slice(-KEEP_PER_SESSION))
}

/** 在席の合図。席を登録したセッションだけが、30 秒ごとに自分の席と時刻を書く。 */
async function beat($: $): Promise<void> {
  const me = await read($, meA)
  if (me === '') return
  const sid = await $.session.id()
  const layout = await layoutOf($)
  await $.store.set(HERE_PREFIX + sid, { desk: meDesk(layout, me), at: await $.clock.now() })
}

function startBeating($: $): void {
  if (beater !== null) return
  beater = $.clock.every(HEARTBEAT_MS, () => void beat($))
}

/** 全セッションの連絡板を読んで、時刻順に並べる。 */
async function readBoard($: $): Promise<OfficeEvent[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(LOG_PREFIX))
  const all: OfficeEvent[] = []
  for (const key of keys) {
    const list = await $.store.get(key)
    if (Array.isArray(list)) all.push(...(list as OfficeEvent[]))
  }
  return all.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

/** 全セッションの在席の合図を、席ごとの最新時刻にまとめる。 */
async function readPresence($: $): Promise<Record<string, number>> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(HERE_PREFIX))
  const out: Record<string, number> = {}
  for (const key of keys) {
    const v = await $.store.get(key)
    if (typeof v !== 'object' || v === null) continue
    const { desk, at } = v as { desk?: unknown; at?: unknown }
    if (typeof desk === 'string' && typeof at === 'number' && at > (out[desk] ?? -1)) out[desk] = at
  }
  return out
}

/** 在席と現在時刻は、変わったときだけ書く（書くたびにパネルが描き直されるため）。 */
async function refreshPresence($: $): Promise<void> {
  const presence = await readPresence($)
  const prev = await read($, presenceA)
  if (JSON.stringify(prev) !== JSON.stringify(presence)) await update($, presenceA, () => presence)
  const now = await $.clock.now()
  if (now - (await read($, nowA)) >= HEARTBEAT_MS) await update($, nowA, () => now)
}

/** パネルを開いた時点の連絡板は「既読」にする（昔の指示をまとめて再生しない）。 */
async function prime($: $): Promise<void> {
  const board = await readBoard($)
  await update($, seenA, () => board.map(e => e.id).slice(-KEEP_SEEN))
  await update($, logA, () => board.slice(-KEEP_LOG))
  await update($, nowA, () => 0)
  await refreshPresence($)
}

async function poll($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    await refreshPresence($)
    const board = await readBoard($)
    const seen = new Set(await read($, seenA))
    const fresh = board.filter(e => !seen.has(e.id))
    if (fresh.length === 0) return
    await update($, seenA, list => [...list, ...fresh.map(e => e.id)].slice(-KEEP_SEEN))
    await update($, queueA, list => [...list, ...fresh])
    startTicking($)
  } finally {
    isPolling = false
  }
}

function startPolling($: $): void {
  if (poller !== null) return
  poller = $.clock.every(POLL_MS, () => void poll($))
}

function stopPolling(): void {
  poller?.cancel()
  poller = null
}

/**
 * アニメを 1 コマ進める。1 件の再生が終わったらログに載せ、次の行をキューから取る。
 * ログに載るのは再生が始まった時なので、「指示あり」の吹き出しは届いてから出る。
 */
async function tick($: $): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const anim = await read($, animA)
    if (anim !== null && anim.frame + 1 < totalFrames(anim)) {
      await update($, animA, a => (a === null ? null : { ...a, frame: a.frame + 1 }))
      return
    }
    const queue = await read($, queueA)
    const next = queue[0]
    if (next === undefined) {
      await update($, animA, () => null)
      ticker?.cancel()
      ticker = null
      return
    }
    await update($, queueA, list => list.slice(1))
    await update($, logA, list => [...list, next].slice(-KEEP_LOG))
    await update($, animA, () => ({ event: next, frame: 0 }))
  } finally {
    isTicking = false
  }
}

function startTicking($: $): void {
  if (ticker !== null) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

async function openPane($: $): Promise<void> {
  const wasOpen = await read($, isOpenA)
  if (!wasOpen) await prime($)
  await update($, isOpenA, () => true)
  await $.ui.open({ id: PANE, title: 'オフィス' })
  startPolling($)
}

/** デモ用の在席。図が「在席」と「退勤」で描き分けられることを見せる。 */
async function demoPresence($: $, desks: readonly string[]): Promise<void> {
  const at = await $.clock.now()
  for (const desk of desks) await $.store.set(`${HERE_PREFIX}demo-${desk}`, { desk, at })
}

/** 日本時間の HH:MM。 */
function clock(at: number): string {
  const d = new Date(at + 9 * 60 * 60 * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'office',
      description: 'オフィス図を開く（desk <席名> / demo / clear も使えます）',
    })
    try {
      const text = await $.fs.read(`${$.plugin.root}/office.json`)
      await update($, layoutA, () => parseLayout(JSON.parse(text)))
    } catch {
      await update($, layoutA, () => null)
    }
    try {
      const sid = await $.session.id()
      const mine = await $.store.get(DESK_PREFIX + sid)
      if (typeof mine === 'string') await update($, meA, () => mine)
      await beat($)
    } catch {
      // 席名が未登録なら空のまま
    }
    startBeating($)
    if (await read($, isOpenA)) {
      startPolling($)
      if ((await read($, queueA)).length > 0 || (await read($, animA)) !== null) startTicking($)
    }
    return next(e)
  })

  // 送る側: 届いたら連絡板に「誰から誰へ、要約 1 行」を書く。送信そのものには手を出さない。
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (sent.isDelivered) {
      try {
        await append($, { kind: 'send', from: await read($, meA), to: e.to, summary: summarize(e.text) })
      } catch {
        // 記録に失敗しても送信は成功のまま
      }
    }
    return sent
  })

  // 受け取る側: 他のセッションからの配達なら「受け取った」を書く。
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
      try {
        await append($, { kind: 'receive', from: '', to: await read($, meA), summary: '' })
      } catch {
        // 記録に失敗しても受信はそのまま
      }
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpenA, () => false)
      stopPolling()
    }
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()

    if (sub === 'desk') {
      if (arg === '') {
        const me = await read($, meA)
        return { text: me === '' ? '席名は未登録です。/office desk ソラ/本社 のように登録してください。' : `このセッションの席は「${me}」です。` }
      }
      const sid = await $.session.id()
      await $.store.set(DESK_PREFIX + sid, arg)
      await update($, meA, () => arg)
      await beat($)
      const layout = await layoutOf($)
      const ref = findDesk(layout, arg)
      return {
        text:
          ref === null
            ? `席を「${arg}」にしました。office.json に無い名前なので、図では入口の来客として描きます。`
            : `席を「${tagOf(layout, ref.desk)}」にしました（${layout.floors[ref.floor]?.name ?? ''}）。`,
      }
    }

    if (sub === 'demo') {
      await openPane($)
      const me = await read($, meA)
      const boss = me !== '' ? me : 'ソラ/本社'
      await demoPresence($, ['ソラ/本社', 'アオ/本社', 'モモ/PPPアプリ', 'モモ/VideoFlow', 'モモ/クリップ&フリップ', 'アカ/ヤフーフリマ', 'クロ/ヤフーフリマ'])
      await append($, { kind: 'send', from: boss, to: '[モモ/クリップ&フリップ] 要件', summary: '0.8.2要件書の値が違うので確認して' })
      await append($, { kind: 'receive', from: '', to: 'モモ/クリップ&フリップ', summary: '' })
      await append($, { kind: 'send', from: 'モモ/PPPアプリ', to: boss, summary: '要件まとめ終わりました' })
      await append($, { kind: 'send', from: 'ソラ/本社', to: 'クロ/ヤフーフリマ', summary: '保守の状況を教えて' })
      await poll($)
      return { text: 'デモの指示を 4 件流しました。パネルでキャラが動きます。' }
    }

    if (sub === 'clear') {
      for (const key of await $.store.keys()) {
        if (key.startsWith(LOG_PREFIX) || key.startsWith(`${HERE_PREFIX}demo-`)) await $.store.delete(key)
      }
      await update($, logA, () => [])
      await update($, queueA, () => [])
      await update($, animA, () => null)
      await update($, seenA, () => [])
      await refreshPresence($)
      return { text: '連絡板を空にしました。' }
    }

    await openPane($)
    const me = await read($, meA)
    return {
      text:
        me === ''
          ? 'オフィスを開きました。このセッションの席は /office desk <席名> で登録できます。'
          : `オフィスを開きました。このセッションの席は「${me}」です。`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const layout = await layoutOf($)
    const anim = await read($, animA)
    const log = await read($, logA)
    const me = await read($, meA)
    const presence = await read($, presenceA)
    const storedNow = await read($, nowA)
    const now = storedNow > 0 ? storedNow : await $.clock.now()
    const states = deskStates(layout, log, presence, now, me)
    const columns = e.props.bodyColumns

    const lines = log
      .slice(-5)
      .reverse()
      .map(ev =>
        ev.kind === 'send'
          ? `${clock(ev.at)} ${nameOf(layout, ev.from)} → ${nameOf(layout, ev.to)}  ${ev.summary}`
          : `${clock(ev.at)} ❗ ${nameOf(layout, ev.to)} が受信`,
      )
    const idle = me === '' ? '待機中（/office desk <席名> で席を登録）' : `待機中　あなたの席: ${nameOf(layout, me)}`

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      const caption = anim === null ? null : drawSvg({ layout, anim, states, width: 100 }).caption
      const half = Math.max(16, Math.floor(columns / 2))
      return (
        <Box flexDirection="column">
          {layout.floors.map((floor, fi) => (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>
                {floor.name}
                {floor.subtitle === undefined ? '' : `  ${floor.subtitle}`}
              </Text>
              <Box flexDirection="row" flexWrap="wrap">
                {floor.desks.map((desk, di) => {
                  const state = states.get(desk)
                  const isQuiet = state === undefined || (!state.isHere && state.pending === null)
                  const f = frame(8, 8)
                  sprite(f, 0, 0, BLOB_SPRITE, {
                    X: hex(isQuiet ? '#9a948c' : lighter(colorOf(layout, desk), 0.2)),
                    e: hex('#2b2430'),
                  })
                  const r = toRaster(f)
                  return (
                    <Box flexDirection="column" alignItems="center" width={half}>
                      <Raster key={`blob-${fi}-${di}`} columns={r.columns} rows={r.rows} cells={r.cells} />
                      <Text bold dimColor={isQuiet}>
                        {tagOf(layout, desk)}
                        {state?.pending != null ? <Text color="#e23b3b">!</Text> : ''}
                      </Text>
                      <Text dimColor>{state?.status ?? ''}</Text>
                      {state?.pending != null ? <Text>💬 {state.pending.summary}</Text> : ''}
                    </Box>
                  )
                })}
              </Box>
            </Box>
          ))}
          <Text bold>{caption ?? idle}</Text>
          {lines.length === 0 ? (
            <Text dimColor>まだ指示のやり取りはありません。/office demo で動きを確認できます。</Text>
          ) : (
            lines.map((line, i) => <Text dimColor={i > 0}>{line}</Text>)
          )}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const drawn = drawSvg({ layout, anim, states, width: Math.max(220, Math.min(440, columns * 8.5)) })
    return (
      <Box flexDirection="column">
        <Svg source={drawn.svg} alt="オフィス図" />
        <Text bold>{drawn.caption ?? idle}</Text>
        {lines.length === 0 ? (
          <Text dimColor>まだ指示のやり取りはありません。/office demo で動きを確認できます。</Text>
        ) : (
          lines.map((line, i) => <Text dimColor={i > 0}>{line}</Text>)
        )}
      </Box>
    )
  })
}


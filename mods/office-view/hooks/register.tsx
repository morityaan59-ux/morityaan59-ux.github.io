import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OfficeEvent, OfficeLayout } from '../types'
import { DEFAULT_LAYOUT, findDesk, labelOf, nameOf, parseLayout, summarize } from './lib/layout'
import { toRaster, toSvg } from './lib/pixels'
import { drawScene, totalFrames } from './lib/scene'

const PANE = 'office'
const LOG_PREFIX = 'log:'
const DESK_PREFIX = 'desk:'
const POLL_MS = 500
const TICK_MS = 120
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

type $ = EngineInterface

// タイマーはモジュールの変数。リロードで消えるので session.start で張り直す。
let poller: Timer | null = null
let ticker: Timer | null = null
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

/** パネルを開いた時点の連絡板は「既読」にする（昔の指示をまとめて再生しない）。 */
async function prime($: $): Promise<void> {
  const board = await readBoard($)
  await update($, seenA, () => board.map(e => e.id).slice(-KEEP_SEEN))
  await update($, logA, () => board.slice(-KEEP_LOG))
}

async function poll($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const board = await readBoard($)
    const seen = new Set(await read($, seenA))
    const fresh = board.filter(e => !seen.has(e.id))
    if (fresh.length === 0) return
    await update($, seenA, list => [...list, ...fresh.map(e => e.id)].slice(-KEEP_SEEN))
    await update($, logA, list => [...list, ...fresh].slice(-KEEP_LOG))
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

/** アニメを 1 コマ進める。終わったら次の行をキューから取り、何も無ければ止まる。 */
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
    } catch {
      // 席名が未登録なら空のまま
    }
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
      const layout = await layoutOf($)
      const ref = findDesk(layout, arg)
      return {
        text:
          ref === null
            ? `席を「${arg}」にしました。office.json に無い名前なので、図では入口の来客として描きます。`
            : `席を「${arg}」にしました（${layout.floors[ref.floor]?.name ?? ''}）。`,
      }
    }

    if (sub === 'demo') {
      await openPane($)
      const me = await read($, meA)
      const boss = me !== '' ? me : 'ソラ/本社'
      await append($, { kind: 'send', from: boss, to: '[モモ/PPPアプリ] 要件', summary: '要件の確認を依頼' })
      await append($, { kind: 'receive', from: '', to: 'モモ/PPPアプリ', summary: '' })
      await append($, { kind: 'send', from: 'モモ/PPPアプリ', to: boss, summary: '受領しました。今日中に返します' })
      await append($, { kind: 'send', from: 'ソラ/本社', to: 'クロ/ヤフーフリマ', summary: '保守の状況を教えて' })
      await poll($)
      return { text: 'デモの指示を 4 件流しました。パネルでキャラが動きます。' }
    }

    if (sub === 'clear') {
      for (const key of await $.store.keys()) if (key.startsWith(LOG_PREFIX)) await $.store.delete(key)
      await update($, logA, () => [])
      await update($, queueA, () => [])
      await update($, animA, () => null)
      await update($, seenA, () => [])
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
    const columns = e.props.bodyColumns

    const lines = log
      .slice(-5)
      .reverse()
      .map(ev =>
        ev.kind === 'send'
          ? `${clock(ev.at)} ${nameOf(layout, ev.from)} → ${nameOf(layout, ev.to)}  ${ev.summary}`
          : `${clock(ev.at)} ❗ ${nameOf(layout, ev.to)} が受信`,
      )

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      const w = Math.max(48, Math.min(120, columns))
      const scene = drawScene(layout, w, anim, me)
      const raster = toRaster(scene.frame)
      return (
        <Box flexDirection="column">
          <Raster key="office" columns={raster.columns} rows={raster.rows} cells={raster.cells} />
          {layout.floors.map(floor => (
            <Text>
              <Text bold>{floor.name}</Text>
              <Text dimColor> {floor.desks.map(d => labelOf(layout, d)).join(' / ')}</Text>
            </Text>
          ))}
          <Text bold>
            {scene.caption ?? (me === '' ? '待機中（/office desk <席名> で席を登録）' : `待機中　あなたの席: ${nameOf(layout, me)}`)}
          </Text>
          {lines.length === 0 ? (
            <Text dimColor>
              まだ指示のやり取りはありません。/office demo で動きを確認できます。
            </Text>
          ) : (
            lines.map((line, i) => (
              <Text dimColor={i > 0}>
                {line}
              </Text>
            ))
          )}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const scene = drawScene(layout, 120, anim, me)
    const svg = toSvg(scene.frame, {
      width: Math.max(280, Math.min(560, columns * 8)),
      background: '#f6f1e7',
      texts: scene.texts,
    })
    return (
      <Box flexDirection="column">
        <Svg source={svg} alt="オフィス図" />
        <Text bold>
          {scene.caption ?? (me === '' ? '待機中（/office desk <席名> で席を登録）' : `待機中　あなたの席: ${nameOf(layout, me)}`)}
        </Text>
        {lines.length === 0 ? (
          <Text dimColor>
            まだ指示のやり取りはありません。/office demo で動きを確認できます。
          </Text>
        ) : (
          lines.map((line, i) => (
            <Text dimColor={i > 0}>
              {line}
            </Text>
          ))
        )}
      </Box>
    )
  })
}

/** 日本時間の HH:MM。 */
function clock(at: number): string {
  const d = new Date(at + 9 * 60 * 60 * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

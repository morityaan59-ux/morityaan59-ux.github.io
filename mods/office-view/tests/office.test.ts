import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { OfficeEvent } from '../types'
import { deskStates } from '../hooks/lib/activity'
import { charName, DEFAULT_LAYOUT, deskKey, findDesk, nameOf, summarize, tagOf } from '../hooks/lib/layout'
import { base64, frame, rect, toRaster } from '../hooks/lib/pixels'
import { along, drawSvg, walkPath, wrapTag, WALK_FRAMES } from '../hooks/lib/vertical'

const PANE = {
  component: 'Pane',
  requestId: 'office',
  props: {
    title: 'オフィス',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

/** エンジンの下側を、メモリのストアと止まった時計で答える。ストアの中身はテストから覗ける。 */
function world(on: On, sid: string) {
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5, 1, 0, 0) })
  on('session.id', () => ({ value: sid }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', () => ({ deny: 'office.json は無い前提（既定の構成を使う）' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.receive', (_$, e) => ({ text: e.text }))
  return { clock, store }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
}

async function office($: Engine, args: string): Promise<{ text?: string }> {
  return await $.command.run({
    command: 'office',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

function send(at: number, from: string, to: string, summary: string): OfficeEvent {
  return { id: `${from}-${at}`, at, from, to, summary, kind: 'send' }
}

describe('席名と名札', () => {
  test('セッション名から席名とキャラ名を取り出す', () => {
    expect(deskKey('[モモ/PPPアプリ] 要件')).toBe('モモ/PPPアプリ')
    expect(deskKey('ソラ/本社')).toBe('ソラ/本社')
    expect(charName('[ソラ/本社] 社長秘書')).toBe('ソラ')
    expect(charName('開発プロジェクト相談')).toBe('開発プロジェクト相談')
  })

  test('宛先から席を探す（完全一致 → 同じキャラ → 来客）', () => {
    expect(findDesk(DEFAULT_LAYOUT, '[モモ/VideoFlow] 要件')).toEqual({ floor: 1, index: 2, desk: 'モモ/VideoFlow' })
    expect(findDesk(DEFAULT_LAYOUT, 'モモ')?.desk).toBe('モモ/PPPアプリ')
    expect(findDesk(DEFAULT_LAYOUT, '知らない人')).toBeNull()
  })

  test('名札は「案件のキャラ」、呼び名があればそれ', () => {
    expect(tagOf(DEFAULT_LAYOUT, 'モモ/ヤフーフリマ')).toBe('ヤフーフリマのモモ')
    expect(tagOf(DEFAULT_LAYOUT, 'ソラ/本社')).toBe('本社のソラ')
    expect(tagOf({ ...DEFAULT_LAYOUT, labels: { 開発プロジェクト相談: '相談役' } }, '開発プロジェクト相談')).toBe('相談役')
    expect(nameOf(DEFAULT_LAYOUT, '[モモ/PPPアプリ] 要件')).toBe('モモ/PPPアプリ')
  })

  test('長い名札は 1 行 11 文字、2 行までに折る', () => {
    expect(wrapTag('クリップ&フリップのモモ')).toEqual(['クリップ&フリップの', 'モモ'])
    const long = wrapTag('あ'.repeat(30))
    expect(long.length).toBe(2)
    expect(long[1]?.endsWith('…')).toBe(true)
  })

  test('要約は最初の行だけ、40 文字まで', () => {
    expect(summarize('\n  要件の確認を依頼  \n詳細はここ')).toBe('要件の確認を依頼')
    expect(Array.from(summarize('あ'.repeat(60))).length).toBe(40)
  })
})

describe('席の状態', () => {
  const now = 10 * 60_000
  test('指示を受けて返事をしていない席は「指示あり」、返事をしたら消える', () => {
    const asked = [send(now - 3 * 60_000, 'ソラ/本社', '[モモ/PPPアプリ] 要件', '確認して')]
    const s1 = deskStates(DEFAULT_LAYOUT, asked, {}, now, '')
    expect(s1.get('モモ/PPPアプリ')?.pending?.summary).toBe('確認して')
    expect(s1.get('モモ/PPPアプリ')?.status).toBe('指示あり 3分前')

    const answered = [...asked, send(now - 60_000, 'モモ/PPPアプリ', 'ソラ/本社', '終わりました')]
    const presence = { 'モモ/PPPアプリ': now - 10_000 }
    const s2 = deskStates(DEFAULT_LAYOUT, answered, presence, now, '')
    expect(s2.get('モモ/PPPアプリ')?.pending).toBeNull()
    expect(s2.get('モモ/PPPアプリ')?.status).toBe('送信 1分前')
  })

  test('在席の合図が古い席は「退勤」、自分の席は常に在席', () => {
    const presence = { 'アオ/本社': now - 10_000, 'クロ/ヤフーフリマ': now - 5 * 60_000 }
    const s = deskStates(DEFAULT_LAYOUT, [], presence, now, '[ソラ/本社] 社長秘書')
    expect(s.get('アオ/本社')?.status).toBe('在席')
    expect(s.get('クロ/ヤフーフリマ')?.status).toBe('退勤')
    expect(s.get('ソラ/本社')?.status).toBe('在席・あなた')
  })
})

describe('縦型の図', () => {
  test('違う階へは右の廊下を通って歩き、相手の隣に立つ', () => {
    const path = walkPath(DEFAULT_LAYOUT, 'ソラ/本社', 'モモ/PPPアプリ')
    expect(path.length).toBe(4)
    expect(path[1]?.x).toBe(path[2]?.x)
    expect((path[2]?.y ?? 0) > (path[1]?.y ?? 0)).toBe(true)
    expect(along(path, 0)).toEqual(path[0])
    expect(along(path, 1)).toEqual(path[3])
  })

  test('縦長で、名札と吹き出しが入り、文字数上限に収まる', () => {
    const log = [send(0, 'ソラ/本社', '[モモ/クリップ&フリップ] 要件', '0.8.2要件書の値が違う')]
    const states = deskStates(DEFAULT_LAYOUT, log, {}, 60_000, '')
    const { svg } = drawSvg({ layout: DEFAULT_LAYOUT, anim: null, states, width: 320 })
    const m = /viewBox="0 0 (\d+) ([\d.]+)"/.exec(svg)
    expect(Number(m?.[2]) > Number(m?.[1]) * 2).toBe(true)
    expect(svg).toContain('ヤフーフリマのモモ')
    expect(svg).toContain('0.8.2要件書の値')
    expect(svg).toContain('<tspan fill="#e23b3b">!</tspan>')
    expect(svg.length).toBeLessThan(131072)
  })

  test('Raster のセルは 縦 2 ピクセル = 1 セル', () => {
    const f = frame(4, 5)
    rect(f, 0, 0, 4, 5, 0xff0000)
    const r = toRaster(f)
    expect(r.columns).toBe(4)
    expect(r.rows).toBe(3)
    expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
    expect(base64(new Uint8Array([77]))).toBe('TQ==')
  })
})

describe('連絡板', () => {
  test('送信は「誰から誰へ・要約 1 行」だけを残し、本文は残さない', async ($, on) => {
    const { store } = world(on, 'sess-sora')
    await start($)
    await office($, 'desk ソラ/本社')
    await $.session.send({ to: '[モモ/PPPアプリ] 要件', text: '要件の確認を依頼\n社外秘の詳細はこちら', origin: { kind: 'model' } })

    const saved = store.get('log:sess-sora') as OfficeEvent[]
    expect(saved.length).toBe(1)
    expect(saved[0]).toEqual(
      expect.objectContaining({ kind: 'send', from: 'ソラ/本社', to: '[モモ/PPPアプリ] 要件', summary: '要件の確認を依頼' }),
    )
    expect(JSON.stringify(saved)).not.toContain('社外秘')
  })

  test('他のセッションからの配達は「受け取った」として残す', async ($, on) => {
    const { store } = world(on, 'sess-momo')
    await start($)
    await office($, 'desk モモ/PPPアプリ')
    await $.session.receive({ origin: { kind: 'peer' }, text: '要件の確認を依頼' })
    await $.session.receive({ origin: { kind: 'bridge' }, text: '自分の入力' })

    const saved = store.get('log:sess-momo') as OfficeEvent[]
    expect(saved.length).toBe(1)
    expect(saved[0]).toEqual(expect.objectContaining({ kind: 'receive', to: 'モモ/PPPアプリ', summary: '' }))
  })

  test('席を登録すると在席の合図を書く', async ($, on) => {
    const { store } = world(on, 'sess-ao')
    await start($)
    await office($, 'desk [アオ/本社] 現場ビュー')
    expect(store.get('here:sess-ao')).toEqual({ desk: 'アオ/本社', at: Date.UTC(2026, 9, 5, 1, 0, 0) })
  })
})

describe('オフィス図', () => {
  test('デモでキャラが歩き、着いたら吹き出しを出す（デスクトップとターミナル）', async ($, on) => {
    const { clock } = world(on, 'sess-sora')
    await start($)
    await office($, 'desk ソラ/本社')
    const said = await office($, 'demo')
    expect(said.text).toContain('4 件')

    await clock.advance(120)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'office-view', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /向かっています/ })).toBeDefined()
      await ui.unmount()
    }

    await clock.advance(120 * WALK_FRAMES)
    const desk = await $.ui.mount({ plugin: 'office-view', surface: 'desktop', ...PANE })
    const svg = await desk.find({ type: 'Svg' })
    expect(String(svg?.props.source)).toContain('クリップ&amp;フリップの')
    expect(await desk.find({ type: 'Text', text: /0\.8\.2要件書の値が違う/ })).toBeDefined()
    await desk.unmount()

    const term = await $.ui.mount({ plugin: 'office-view', surface: 'terminal', ...PANE })
    expect((await term.findAll({ type: 'Raster' })).length).toBe(11)
    expect(await term.find({ type: 'Text', text: 'ヤフーフリマのモモ' })).toBeDefined()
    expect(await term.find({ type: 'Text', text: '退勤' })).toBeDefined()
    await term.unmount()
  })

  test('全部再生し終わると待機に戻り、返事待ちの席に「!」が残る', async ($, on) => {
    const { clock } = world(on, 'sess-sora')
    await start($)
    await office($, 'desk ソラ/本社')
    await office($, 'demo')
    await clock.advance(120 * 200)
    const ui = await $.ui.mount({ plugin: 'office-view', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /待機中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'クリップ&フリップのモモ!' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /💬 0\.8\.2要件書/ })).toBeDefined()
    await ui.unmount()
  })
})

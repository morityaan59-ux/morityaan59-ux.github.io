import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { OfficeEvent } from '../types'
import { charName, DEFAULT_LAYOUT, deskKey, findDesk, labelOf, nameOf, summarize } from '../hooks/lib/layout'
import { base64, frame, rect, toRaster, toSvg } from '../hooks/lib/pixels'
import { along, drawScene, walkPath, WALK_FRAMES } from '../hooks/lib/scene'

const PANE = {
  component: 'Pane',
  requestId: 'office',
  props: {
    title: 'オフィス',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
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

describe('席名と要約', () => {
  test('セッション名から席名とキャラ名を取り出す', () => {
    expect(deskKey('[モモ/PPPアプリ] 要件')).toBe('モモ/PPPアプリ')
    expect(deskKey('ソラ/本社')).toBe('ソラ/本社')
    expect(charName('[ソラ/本社] 社長秘書')).toBe('ソラ')
    expect(charName('開発プロジェクト相談')).toBe('開発プロジェクト相談')
  })

  test('同じキャラが何席もあるときは案件名で見分ける', () => {
    expect(labelOf(DEFAULT_LAYOUT, 'モモ/PPPアプリ')).toBe('PPPアプ')
    expect(labelOf(DEFAULT_LAYOUT, 'ソラ/本社')).toBe('ソラ')
    // 別の階に同じキャラがいても、同じ階でなければキャラ名のまま
    expect(labelOf(DEFAULT_LAYOUT, 'アオ/ヤフーフリマ')).toBe('アオ')
    expect(nameOf(DEFAULT_LAYOUT, '[モモ/PPPアプリ] 要件')).toBe('モモ/PPPアプリ')
    expect(nameOf({ ...DEFAULT_LAYOUT, labels: { 開発プロジェクト相談: '相談役' } }, '開発プロジェクト相談')).toBe('相談役')
  })

  test('宛先から席を探す（完全一致 → 同じキャラ → 来客）', () => {
    expect(findDesk(DEFAULT_LAYOUT, '[モモ/VideoFlow] 要件')).toEqual({ floor: 1, index: 2, desk: 'モモ/VideoFlow' })
    expect(findDesk(DEFAULT_LAYOUT, 'モモ')?.desk).toBe('モモ/PPPアプリ')
    expect(findDesk(DEFAULT_LAYOUT, '知らない人')).toBeNull()
  })

  test('要約は最初の行だけ、40 文字まで', () => {
    expect(summarize('\n  要件の確認を依頼  \n詳細はここ')).toBe('要件の確認を依頼')
    expect(Array.from(summarize('あ'.repeat(60))).length).toBe(40)
  })
})

describe('描画の部品', () => {
  test('違う階へは階段を経由して歩く', () => {
    const path = walkPath(DEFAULT_LAYOUT, 120, 'ソラ/本社', 'モモ/PPPアプリ')
    expect(path.length).toBe(4)
    expect(path[1]?.x).toBe(path[2]?.x)
    expect(along(path, 0)).toEqual(path[0])
    expect(along(path, 1)).toEqual(path[3])
    // 相手に重ならず、右隣に立つ
    const target = walkPath(DEFAULT_LAYOUT, 120, 'モモ/PPPアプリ', 'モモ/PPPアプリ')[0]
    expect((path[3]?.x ?? 0) - (target?.x ?? 0)).toBe(9)
  })

  test('Raster のセルは 縦 2 ピクセル = 1 セル', () => {
    const f = frame(4, 5)
    rect(f, 0, 0, 4, 5, 0xff0000)
    const r = toRaster(f)
    expect(r.columns).toBe(4)
    expect(r.rows).toBe(3)
    expect(r.cells.length).toBe(Math.ceil((4 * 3 * 12) / 3) * 4)
    expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
    expect(base64(new Uint8Array([77]))).toBe('TQ==')
  })

  test('SVG は文字数上限に十分収まる', () => {
    const scene = drawScene(DEFAULT_LAYOUT, 120, null, 'ソラ/本社')
    const svg = toSvg(scene.frame, { width: 480, background: '#fff', texts: scene.texts })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.length).toBeLessThan(131072)
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
    expect(await desk.find({ type: 'Svg' })).toBeDefined()
    expect(await desk.find({ type: 'Text', text: /要件の確認を依頼/ })).toBeDefined()
    expect(await desk.find({ text: /ソラ\/本社 → モモ\/PPPアプリ/ })).toBeDefined()
    await desk.unmount()

    const term = await $.ui.mount({ plugin: 'office-view', surface: 'terminal', ...PANE })
    const raster = await term.find({ type: 'Raster' })
    expect(raster?.props.columns).toBe(80)
    await term.unmount()
  })

  test('全部再生し終わると待機に戻る', async ($, on) => {
    const { clock } = world(on, 'sess-sora')
    await start($)
    await office($, 'desk ソラ/本社')
    await office($, 'demo')
    await clock.advance(120 * 200)
    const ui = await $.ui.mount({ plugin: 'office-view', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: /待機中/ })).toBeDefined()
    await ui.unmount()
  })
})

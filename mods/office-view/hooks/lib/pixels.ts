/** 透明（ターミナルでは既定の背景色）。Raster の「既定色」と同じ値。 */
export const CLEAR = 0x01000000

export type Frame = { w: number; h: number; px: Uint32Array }

export function frame(w: number, h: number): Frame {
  return { w, h, px: new Uint32Array(w * h).fill(CLEAR) }
}

export function hex(color: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  return m?.[1] !== undefined ? parseInt(m[1], 16) : 0x888888
}

export function rect(f: Frame, x: number, y: number, w: number, h: number, c: number): void {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(f.w, Math.round(x) + w)
  const y1 = Math.min(f.h, Math.round(y) + h)
  for (let yy = y0; yy < y1; yy++) f.px.fill(c, yy * f.w + x0, Math.max(yy * f.w + x0, yy * f.w + x1))
}

/** 文字列のドット絵を描く。'.' は透明、それ以外は palette の色。 */
export function sprite(
  f: Frame,
  x: number,
  y: number,
  rows: readonly string[],
  palette: Readonly<Record<string, number>>,
): void {
  const bx = Math.round(x)
  const by = Math.round(y)
  for (const [r, row] of rows.entries()) {
    for (let c = 0; c < row.length; c++) {
      const key = row[c]
      if (key === undefined || key === '.') continue
      const color = palette[key]
      if (color === undefined) continue
      const px = bx + c
      const py = by + r
      if (px < 0 || py < 0 || px >= f.w || py >= f.h) continue
      f.px[py * f.w + px] = color
    }
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20

/**
 * フレームをターミナルの Raster 用セルにする。縦 2 ピクセルを 1 セルに詰め、
 * 上半分を前景色の ▀、下半分を背景色で塗る。
 */
export function toRaster(f: Frame): { columns: number; rows: number; cells: string } {
  const columns = f.w
  const rows = Math.ceil(f.h / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = f.px[2 * r * f.w + c] ?? CLEAR
      const bottom = 2 * r + 1 < f.h ? (f.px[(2 * r + 1) * f.w + c] ?? CLEAR) : CLEAR
      const at = (r * columns + c) * 3
      if (top === CLEAR && bottom === CLEAR) {
        words[at] = SPACE
        words[at + 1] = CLEAR
        words[at + 2] = CLEAR
      } else if (top === CLEAR) {
        words[at] = LOWER
        words[at + 1] = bottom
        words[at + 2] = CLEAR
      } else {
        words[at] = UPPER
        words[at + 1] = top
        words[at + 2] = bottom
      }
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(words.buffer)) }
}

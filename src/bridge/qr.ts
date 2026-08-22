import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js'

/**
 * Renders a WhatsApp linking QR as a standalone SVG, using the encoder
 * `qrcode-terminal` already vendors for its ASCII-art renderer (see
 * socket.ts's printQr path) — so this needs no new dependency.
 *
 * Colors are hardcoded, not CSS variables: an inverted QR (as dark mode
 * would otherwise produce) isn't reliably scannable by phone cameras.
 */
export function renderQrSvg(payload: string, opts: { moduleSize?: number; quietZone?: number } = {}): string {
  if (!payload) throw new Error('renderQrSvg: payload must not be empty')

  const moduleSize = opts.moduleSize ?? 8
  const quietZone = opts.quietZone ?? 4

  // -1 = auto-select the smallest type number that fits the payload. `L` is
  // the same error-correction level socket.ts's printQr path already uses.
  const qr = new QRCode(-1, QRErrorCorrectLevel.L)
  qr.addData(payload)
  qr.make()

  const count = qr.getModuleCount()
  const size = (count + quietZone * 2) * moduleSize

  let path = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue
      const x = (col + quietZone) * moduleSize
      const y = (row + quietZone) * moduleSize
      path += `M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="WhatsApp linking QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  )
}

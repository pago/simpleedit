import { describe, it, expect } from 'vitest'
import { jsQrDecoder } from '../qr-scan'
import { qrMatrix } from '../../../shared/qr'

/** Draw the code the Mac's pane draws, as a camera would see it, onto a canvas. */
async function canvasOf(text: string, pixelsPerModule = 6): Promise<HTMLCanvasElement> {
  const { size, path } = qrMatrix(text)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * pixelsPerModule}" height="${size * pixelsPerModule}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size * pixelsPerModule
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas
}

// The fallback is the path every iPhone takes (BarcodeDetector is behind a
// flag there), so it is proved against the exact encoder the pane uses.
describe('jsQrDecoder', () => {
  it('reads the pairing code the Mac shows', async () => {
    const link = `https://mac.tailnet.ts.net/app/?k=${'9f'.repeat(32)}`
    const decode = await jsQrDecoder()
    expect(await decode(await canvasOf(link))).toBe(link)
  })

  it('reports no code in a frame without one', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#888'
    context.fillRect(0, 0, 200, 200)
    const decode = await jsQrDecoder()
    expect(await decode(canvas)).toBeNull()
  })
})

/**
 * Decoding a QR code from a camera frame.
 *
 * `BarcodeDetector` is used where it exists and says it reads QR codes; on iOS
 * it is still behind a flag, so the phone this exists for falls back to jsQR.
 * jsQR is loaded on first use — the scanner is a rare action, and the shell
 * every launch pays for should not carry it.
 */

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorInstance {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorInstance
  getSupportedFormats(): Promise<string[]>
}

/** Reads the frame currently drawn on `canvas`; null when no code is in it. */
export type FrameDecoder = (canvas: HTMLCanvasElement) => Promise<string | null>

async function nativeDecoder(): Promise<FrameDecoder | null> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector
  if (!Detector) return null
  try {
    if (!(await Detector.getSupportedFormats()).includes('qr_code')) return null
    const detector = new Detector({ formats: ['qr_code'] })
    return async (canvas) => (await detector.detect(canvas))[0]?.rawValue ?? null
  } catch {
    return null
  }
}

export async function jsQrDecoder(): Promise<FrameDecoder> {
  const { default: jsQR } = await import('jsqr')
  return async (canvas) => {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    const frame = context.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data ?? null
  }
}

export async function createDecoder(): Promise<FrameDecoder> {
  return (await nativeDecoder()) ?? (await jsQrDecoder())
}

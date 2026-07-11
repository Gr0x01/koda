import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** Render a string as a scannable QR image (white quiet-zone for camera reliability). Used to show the
 *  relay pairing blob so the phone camera can read it instead of typing a long code.
 *
 *  ECC 'L' + a spec-correct 4-module quiet zone are deliberate: the pairing blob is large (~530 chars →
 *  QR v16), and a phone camera needs enough on-screen pixels PER MODULE to decode it. On a clean, glare-free
 *  screen there's no damage to correct, so L (7% redundancy) beats M — it drops two QR versions, making each
 *  module bigger at the same display size. The callers size these generously for the same reason. */
export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, { width: size, margin: 4, errorCorrectionLevel: 'L' })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(''))
    return () => {
      cancelled = true
    }
  }, [value, size])
  if (!src) return null
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Pairing QR code"
      className="rounded-lg border border-border bg-white p-2"
    />
  )
}

import { PNG } from "pngjs"
import jpeg from "jpeg-js"

// Provider hard limit is 5 MiB (Bedrock/Anthropic reject a single image whose
// decoded base64 exceeds 5242880 bytes with a non-retryable 400). We compress
// below a slightly smaller ceiling so re-encode jitter can't push us back over.
export const DEFAULT_MAX_IMAGE_BYTES = 4_500_000

type Pixels = { data: Uint8Array | Buffer; width: number; height: number }

// jpeg-js only understands JPEG; pngjs only PNG. Anything else (webp, gif, ...)
// has no pure-JS decoder available here, so it can't be recompressed and the
// caller must fall back to a text placeholder.
function decode(mime: string, bytes: Buffer): Pixels | undefined {
  if (mime === "image/jpeg" || mime === "image/jpg") {
    const out = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 })
    return { data: out.data, width: out.width, height: out.height }
  }
  if (mime === "image/png") {
    const png = PNG.sync.read(bytes)
    return { data: png.data, width: png.width, height: png.height }
  }
  return undefined
}

// Nearest-neighbor downscale of an RGBA buffer by an integer-ish factor. Pure JS,
// no dependency; quality is fine for the "shrink a screenshot so the model can
// still read it" use case.
function downscale(src: Pixels, scale: number): Pixels {
  const width = Math.max(1, Math.round(src.width * scale))
  const height = Math.max(1, Math.round(src.height * scale))
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale))
      const si = (sy * src.width + sx) * 4
      const di = (y * width + x) * 4
      data[di] = src.data[si] ?? 0
      data[di + 1] = src.data[si + 1] ?? 0
      data[di + 2] = src.data[si + 2] ?? 0
      data[di + 3] = src.data[si + 3] ?? 255
    }
  }
  return { data, width, height }
}

// Re-encode oversized image bytes as JPEG below maxBytes. Always outputs JPEG
// (smaller than PNG for photos/screenshots and lets us trade quality for size).
// Returns { data (raw base64), mediaType } on success, or undefined if the
// format can't be decoded or we couldn't get under the limit — callers then
// strip the image to a text placeholder so a poison image can never wedge the
// session.
export function compressImage(
  mime: string,
  bytes: Buffer,
  maxBytes: number,
): { data: string; mediaType: string } | undefined {
  let pixels: Pixels | undefined
  try {
    pixels = decode(mime, bytes)
  } catch {
    return undefined
  }
  if (!pixels) return undefined

  // Try progressively lower quality, then progressively smaller dimensions.
  // Each dimension halving cuts pixel count ~4x, so a handful of steps covers
  // even very large source images.
  const scales = [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1]
  const qualities = [80, 60, 45, 30]
  for (const scale of scales) {
    const scaled = scale === 1 ? pixels : downscale(pixels, scale)
    for (const quality of qualities) {
      try {
        const encoded = jpeg.encode({ data: Buffer.from(scaled.data), width: scaled.width, height: scaled.height }, quality)
        if (encoded.data.length <= maxBytes) {
          return { data: Buffer.from(encoded.data).toString("base64"), mediaType: "image/jpeg" }
        }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

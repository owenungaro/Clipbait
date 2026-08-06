import { createReadStream, promises as fs } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LitterboxExpiry, ShareProvider } from '@shared/types'

interface Endpoint {
  host: string
  pathname: string
  maxBytes: number
  label: string
}

const ENDPOINTS: Record<ShareProvider, Endpoint> = {
  catbox: {
    host: 'catbox.moe',
    pathname: '/user/api.php',
    maxBytes: 200 * 1024 * 1024,
    label: 'Catbox'
  },
  litterbox: {
    host: 'litterbox.catbox.moe',
    pathname: '/resources/internals/api.php',
    maxBytes: 1024 * 1024 * 1024,
    label: 'Litterbox'
  }
}

const EXPIRY_MS: Record<LitterboxExpiry, number> = {
  '1h': 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '72h': 72 * 60 * 60 * 1000
}

export interface UploadResult {
  url: string
  provider: ShareProvider
  expiresAt: number | null
}

export class UploadError extends Error {}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${Math.round(n / 1024 / 1024)} MB`
}

function field(boundary: string, name: string, value: string): string {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  )
}

/**
 * Streams the file straight from disk into the request body so a 1 GB clip
 * never has to sit in memory, and so progress reflects bytes actually on the
 * wire rather than bytes read.
 */
export function upload(
  filePath: string,
  provider: ShareProvider,
  expiry: LitterboxExpiry,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    void (async () => {
      const endpoint = ENDPOINTS[provider]
      let size: number
      try {
        size = (await fs.stat(filePath)).size
      } catch {
        return reject(new UploadError('The clip file is missing.'))
      }

      if (size > endpoint.maxBytes) {
        return reject(
          new UploadError(
            `This clip is ${humanBytes(size)}. ${endpoint.label} accepts up to ${humanBytes(
              endpoint.maxBytes
            )} — shorten the buffer, lower the resolution, or switch provider in Sharing.`
          )
        )
      }

      const boundary = `----clipbait${randomBytes(16).toString('hex')}`
      const filename = path.basename(filePath)

      let prologue = field(boundary, 'reqtype', 'fileupload')
      if (provider === 'catbox') {
        prologue += field(boundary, 'userhash', '')
      } else {
        prologue += field(boundary, 'time', expiry)
      }
      prologue +=
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\n` +
        `Content-Type: video/mp4\r\n\r\n`
      const epilogue = `\r\n--${boundary}--\r\n`

      const head = Buffer.from(prologue, 'utf8')
      const tail = Buffer.from(epilogue, 'utf8')
      const contentLength = head.length + size + tail.length

      const req = https.request(
        {
          host: endpoint.host,
          path: endpoint.pathname,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(contentLength),
            'User-Agent': 'clipbait/1.0'
          },
          timeout: 15 * 60 * 1000
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim()
            if ((res.statusCode ?? 0) !== 200) {
              return reject(new UploadError(`${endpoint.label} returned HTTP ${res.statusCode}.`))
            }
            if (!/^https?:\/\//i.test(text)) {
              return reject(
                new UploadError(text.slice(0, 200) || `${endpoint.label} rejected the upload.`)
              )
            }
            onProgress(1)
            resolve({
              url: text,
              provider,
              expiresAt: provider === 'litterbox' ? Date.now() + EXPIRY_MS[expiry] : null
            })
          })
        }
      )

      const abort = (): void => {
        req.destroy(new UploadError('Upload cancelled.'))
      }
      signal?.addEventListener('abort', abort, { once: true })

      req.on('error', (err) => {
        reject(err instanceof UploadError ? err : new UploadError(err.message))
      })
      req.on('timeout', () => {
        req.destroy(new UploadError('Upload timed out.'))
      })

      req.write(head)

      let sent = 0
      const body = createReadStream(filePath)
      body.on('data', (chunk: string | Buffer) => {
        sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        // Cap at 0.99 so the bar only completes when the server answers.
        onProgress(Math.min(0.99, sent / size))
      })
      body.on('error', (err) => {
        req.destroy(new UploadError(err.message))
      })
      body.on('end', () => {
        req.end(tail)
      })
      body.pipe(req, { end: false })
    })()
  })
}

export function providerLimit(provider: ShareProvider): number {
  return ENDPOINTS[provider].maxBytes
}

export function providerLabel(provider: ShareProvider): string {
  return ENDPOINTS[provider].label
}

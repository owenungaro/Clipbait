import { Transform, type TransformCallback } from 'node:stream'

/**
 * Wraps a raw Annex-B H.264 elementary stream (what clipbait-capture.exe
 * writes to stdout) into a minimal FLV stream ffmpeg can read real
 * timestamps from.
 *
 * Raw H.264 has no per-frame timestamp of its own — a demuxer reading it can
 * only guess timing from when bytes happen to arrive, and that guess breaks
 * the moment two frames land in the same read (routine once anything is
 * competing with the encoder for the GPU, e.g. an actual game). FLV tags
 * carry an explicit millisecond timestamp per frame, which ffmpeg treats as
 * authoritative rather than inferring — the same reason OBS and other
 * capture tools timestamp every frame once, at the source, and carry that
 * timestamp through the pipeline instead of reconstructing it downstream.
 *
 * Scope: video only, single SPS/PPS, one NAL per frame (true for this
 * encoder's output — no slice partitioning is configured). Audio keeps
 * going through ffmpeg's stdin exactly as before; its own self-clocking
 * (sample count at a fixed rate) already reflects real time correctly and
 * was never the problem.
 */

const NAL_NONIDR = 1
const NAL_IDR = 5
const NAL_SPS = 7
const NAL_PPS = 8

const FLV_TAG_VIDEO = 9
const FLV_HEADER = Buffer.from([
  0x46, 0x4c, 0x56, // 'F' 'L' 'V'
  0x01, // version
  0x01, // flags: video present, audio absent
  0x00, 0x00, 0x00, 0x09 // header size (9)
])

/** Splits an Annex-B buffer on start codes, returning only NAL units that
 *  are fully bounded by a start code on both sides (the last one may be
 *  incomplete — still being written — and is left for the caller to prepend
 *  to the next chunk). */
function splitCompleteNals(buf: Buffer): { nals: Buffer[]; rest: Buffer } {
  const starts: number[] = []
  let i = 0
  while (i < buf.length - 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) {
        starts.push(i)
        i += 3
        continue
      }
      if (i < buf.length - 3 && buf[i + 2] === 0 && buf[i + 3] === 1) {
        starts.push(i)
        i += 4
        continue
      }
    }
    i++
  }
  if (starts.length < 2) return { nals: [], rest: buf }

  const nals: Buffer[] = []
  for (let n = 0; n < starts.length - 1; n++) {
    const start = starts[n] + (buf[starts[n] + 2] === 1 ? 3 : 4)
    nals.push(buf.subarray(start, starts[n + 1]))
  }
  return { nals, rest: buf.subarray(starts[starts.length - 1]) }
}

function buildAvcDecoderConfig(sps: Buffer, pps: Buffer): Buffer {
  const out = Buffer.alloc(11 + sps.length + pps.length)
  let o = 0
  out[o++] = 1 // configurationVersion
  out[o++] = sps[1] // AVCProfileIndication
  out[o++] = sps[2] // profile_compatibility
  out[o++] = sps[3] // AVCLevelIndication
  out[o++] = 0xff // reserved(6)=111111, lengthSizeMinusOne(2)=11 -> 4-byte lengths
  out[o++] = 0xe1 // reserved(3)=111, numOfSPS(5)=00001
  out.writeUInt16BE(sps.length, o); o += 2
  sps.copy(out, o); o += sps.length
  out[o++] = 1 // numOfPPS
  out.writeUInt16BE(pps.length, o); o += 2
  pps.copy(out, o); o += pps.length
  return out
}

function flvTag(type: number, payload: Buffer, timestampMs: number): Buffer {
  const header = Buffer.alloc(11)
  header[0] = type
  header.writeUIntBE(payload.length, 1, 3) // DataSize, 24-bit
  header.writeUIntBE(timestampMs & 0xffffff, 4, 3) // Timestamp, lower 24 bits
  header[7] = (timestampMs >>> 24) & 0xff // TimestampExtended, upper 8 bits
  // StreamID (bytes 8-10) stays zero.
  const prevTagSize = Buffer.alloc(4)
  prevTagSize.writeUInt32BE(header.length + payload.length, 0)
  return Buffer.concat([header, payload, prevTagSize])
}

export class H264ToFlv extends Transform {
  private carry: Buffer = Buffer.alloc(0)
  private sps: Buffer | null = null
  private pps: Buffer | null = null
  private sentHeader = false
  private sentSequenceHeader = false
  private lastTimestampMs = -1
  private readonly startedAt: number

  /**
   * `referenceStart` should be the same moment the audio pipeline measures
   * its own silence-padding from (see recorder.ts's captureStartedAt) — not
   * just "when this transform happened to be constructed". Video and audio
   * initialize on very different paths (a named pipe connecting vs. a
   * WebAudio graph spinning up), and if each timestamps itself from its own
   * start, ffmpeg's aresample=async filter has to continuously stretch
   * audio to correct the gap between them, which is audible as distortion.
   */
  constructor(referenceStart: number = Date.now()) {
    super()
    this.startedAt = referenceStart
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, callback: TransformCallback): void {
    this.carry = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const { nals, rest } = splitCompleteNals(this.carry)
    this.carry = rest

    if (!this.sentHeader) {
      this.push(FLV_HEADER)
      this.push(Buffer.from([0, 0, 0, 0])) // PreviousTagSize0
      this.sentHeader = true
    }

    for (const nal of nals) this.handleNal(nal)
    callback()
  }

  private handleNal(nal: Buffer): void {
    if (nal.length === 0) return
    const type = nal[0] & 0x1f

    if (type === NAL_SPS) {
      this.sps = Buffer.from(nal)
      this.maybeEmitSequenceHeader()
      return
    }
    if (type === NAL_PPS) {
      this.pps = Buffer.from(nal)
      this.maybeEmitSequenceHeader()
      return
    }
    if (type !== NAL_IDR && type !== NAL_NONIDR) return // drop SEI/AUD/etc.
    if (!this.sentSequenceHeader) return // frame arrived before SPS/PPS — drop it, next one will land fine

    const isKeyframe = type === NAL_IDR
    const payload = Buffer.alloc(5 + 4 + nal.length)
    payload[0] = isKeyframe ? 0x17 : 0x27 // FrameType<<4 | AVC codec id
    payload[1] = 1 // AVCPacketType = NALU
    payload.writeUIntBE(0, 2, 3) // CompositionTime (no B-frames)
    payload.writeUInt32BE(nal.length, 5)
    nal.copy(payload, 9)

    this.push(flvTag(FLV_TAG_VIDEO, payload, this.nextTimestamp()))
  }

  private maybeEmitSequenceHeader(): void {
    if (this.sentSequenceHeader || !this.sps || !this.pps) return
    const config = buildAvcDecoderConfig(this.sps, this.pps)
    const payload = Buffer.alloc(5 + config.length)
    payload[0] = 0x17 // keyframe, AVC
    payload[1] = 0 // AVCPacketType = sequence header
    payload.writeUIntBE(0, 2, 3)
    config.copy(payload, 5)
    this.push(flvTag(FLV_TAG_VIDEO, payload, this.nextTimestamp()))
    this.sentSequenceHeader = true
  }

  /** Real elapsed time, floored to strictly increasing — never equal to or
   *  behind the previous tag even if several NALs are processed in the same
   *  event-loop tick, which is exactly the scenario that produced
   *  non-monotonic, colliding timestamps when ffmpeg tried to infer this
   *  itself from raw Annex-B arrival timing. */
  private nextTimestamp(): number {
    const real = Date.now() - this.startedAt
    const ts = Math.max(real, this.lastTimestampMs + 1)
    this.lastTimestampMs = ts
    return ts
  }
}

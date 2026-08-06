/**
 * Source for the AudioWorklet processor. It is shipped to the worklet as a
 * blob URL rather than a separate chunk so the bundler cannot rewrite it into
 * something the worklet scope (no window, no imports) will not accept.
 *
 * The processor interleaves the mixed graph down to signed 16-bit PCM, which
 * is exactly what ffmpeg is reading on stdin.
 */
export const WORKLET_SOURCE = String.raw`
class PcmPump extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frames = (options && options.processorOptions && options.processorOptions.frames) || 2048
    this.channels = 2
    this.buffer = new Int16Array(frames * this.channels)
    this.fill = 0
    this.peak = 0
    this.alive = true
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.alive = false
    }
  }

  process(inputs) {
    const input = inputs[0]
    const frames = 128
    const left = input && input[0] ? input[0] : null
    const right = input && input[1] ? input[1] : left

    for (let i = 0; i < frames; i++) {
      let l = left ? left[i] : 0
      let r = right ? right[i] : 0

      const magnitude = Math.max(Math.abs(l), Math.abs(r))
      if (magnitude > this.peak) this.peak = magnitude

      if (l > 1) l = 1; else if (l < -1) l = -1
      if (r > 1) r = 1; else if (r < -1) r = -1

      this.buffer[this.fill++] = l < 0 ? l * 0x8000 : l * 0x7fff
      this.buffer[this.fill++] = r < 0 ? r * 0x8000 : r * 0x7fff

      if (this.fill >= this.buffer.length) {
        const copy = new Int16Array(this.buffer)
        this.port.postMessage({ pcm: copy.buffer, peak: this.peak }, [copy.buffer])
        this.fill = 0
        this.peak = 0
      }
    }

    return this.alive
  }
}

registerProcessor('pcm-pump', PcmPump)
`

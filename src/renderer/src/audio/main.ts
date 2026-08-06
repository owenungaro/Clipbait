import type { AudioStartRequest } from '@shared/types'
import { WORKLET_SOURCE } from './worklet'

/**
 * Audio front end for the recorder.
 *
 * Chromium is the only component here that can open a WASAPI loopback stream,
 * so this hidden window mixes desktop sound and microphone in a WebAudio graph
 * and pumps the result to the main process as raw PCM. The main process writes
 * that straight to ffmpeg's stdin.
 */

const api = window.clipbait

interface Session {
  context: AudioContext
  node: AudioWorkletNode
  streams: MediaStream[]
  silence: ConstantSourceNode
}

let session: Session | null = null
let starting = false

async function loadWorklet(context: AudioContext): Promise<void> {
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function captureDesktop(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    })
    // Only the audio is wanted; the video track is the price of the API.
    for (const track of stream.getVideoTracks()) track.stop()
    const audio = stream.getAudioTracks()
    if (audio.length === 0) {
      api.reportAudioError('Windows did not hand over system audio for this session.')
      return null
    }
    return new MediaStream(audio)
  } catch (err) {
    api.reportAudioError(
      `desktop audio unavailable (${err instanceof Error ? err.message : String(err)})`
    )
    return null
  }
}

async function captureMic(deviceId: string): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
        // Echo cancellation would treat game audio as echo and duck it.
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false
      }
    })
  } catch (err) {
    api.reportAudioError(
      `microphone unavailable (${err instanceof Error ? err.message : String(err)})`
    )
    return null
  }
}

async function start(request: AudioStartRequest): Promise<void> {
  if (starting) return
  starting = true
  await stop()

  try {
    const context = new AudioContext({
      sampleRate: request.sampleRate,
      latencyHint: 'interactive'
    })
    await loadWorklet(context)

    const node = new AudioWorkletNode(context, 'pcm-pump', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [request.channels],
      channelCount: request.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { frames: 2048 }
    })

    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      api.sendPcm(event.data.pcm, event.data.peak)
    }

    // A silent constant source guarantees the graph keeps rendering even if
    // every capture below fails. Without it ffmpeg would block waiting for
    // audio and stall video too.
    const silence = context.createConstantSource()
    silence.offset.value = 0
    silence.connect(node)
    silence.start()

    const streams: MediaStream[] = []

    if (request.desktopEnabled) {
      const desktop = await captureDesktop()
      if (desktop) {
        streams.push(desktop)
        const gain = context.createGain()
        gain.gain.value = request.desktopGain
        context.createMediaStreamSource(desktop).connect(gain).connect(node)
      }
    }

    if (request.micEnabled) {
      const mic = await captureMic(request.micDeviceId)
      if (mic) {
        streams.push(mic)
        const gain = context.createGain()
        gain.gain.value = request.micGain
        context.createMediaStreamSource(mic).connect(gain).connect(node)
      }
    }

    // Chromium can suspend a graph whose output goes nowhere, so terminate the
    // chain at the destination through a muted gain node.
    const sink = context.createGain()
    sink.gain.value = 0
    node.connect(sink).connect(context.destination)

    await context.resume()
    session = { context, node, streams, silence }
  } catch (err) {
    api.reportAudioError(err instanceof Error ? err.message : String(err))
  } finally {
    starting = false
  }
}

async function stop(): Promise<void> {
  const active = session
  session = null
  if (!active) return
  try {
    active.node.port.postMessage('stop')
    active.node.port.onmessage = null
    active.silence.stop()
    for (const stream of active.streams) {
      for (const track of stream.getTracks()) track.stop()
    }
    active.node.disconnect()
    await active.context.close()
  } catch {
    /* teardown is best effort */
  }
}

api.onAudioStart((request) => void start(request))
api.onAudioStop(() => void stop())

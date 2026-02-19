/// <reference path="../types/wav-decoder.d.ts" />

import WebSocket from 'ws'
import { decode as decodeWav } from 'wav-decoder'
import { chatService } from '../services/chatService'
import { generateBamborakAudioFromText } from '../services/bamborakService'
import {
  decodeSipAudioFrame,
  encodeSipAudioFrame,
  type SipAudioFrame,
} from './sipProtocol'
import {
  downsample16kTo8kPickEveryOtherPcm16le,
  float32ToPcm16le,
  mixDownToMono,
  resampleLinear,
} from './audio'

type PlaybackState = {
  timer: NodeJS.Timeout | null
  cancelled: boolean
}

type CallSession = {
  callId: string
  createdAt: number
  lastTranscript: string

  voskWs: WebSocket
  voskOpen: boolean
  pendingAudio: Buffer[]

  playback: PlaybackState | null
}

function extractTranscript(data: any): string {
  const candidates: Array<unknown> = [
    data?.text,
    data?.partial,
    data?.result?.text,
    data?.alternatives?.[0]?.transcript,
  ]

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }

  if (Array.isArray(data?.words)) {
    const t = data.words
      .map((w: any) => w?.word ?? w?.text)
      .filter(Boolean)
      .join(' ')
    if (t.trim()) return t
  }

  if (Array.isArray(data?.result)) {
    const t = data.result
      .map((w: any) => w?.word ?? w?.text)
      .filter(Boolean)
      .join(' ')
    if (t.trim()) return t
  }

  return ''
}

async function ttsToPcm16le16k(text: string): Promise<Buffer> {
  const trimmed = text.trim()
  if (!trimmed) return Buffer.alloc(0)

  const speaker_id = process.env['DEFAULT_BAMBORAK_SPEAKER_ID']
  const ttsResult = await generateBamborakAudioFromText({
    text: trimmed,
    format: 'wav',
    includeVisemes: false,
    ...(speaker_id ? { speaker_id } : {}),
  })

  const wavBuf = Buffer.from(ttsResult.audioBase64, 'base64')
  const decoded = await decodeWav(wavBuf)
  const mono = mixDownToMono(decoded.channelData)
  const resampled = resampleLinear(mono, decoded.sampleRate, 16000)
  return float32ToPcm16le(resampled)
}

function cancelPlayback(session: CallSession): void {
  const st = session.playback
  if (!st) return
  st.cancelled = true
  if (st.timer) clearTimeout(st.timer)
  session.playback = null
}

function startPlayback(
  ws: WebSocket,
  session: CallSession,
  audioPcm16le16k: Buffer,
): void {
  cancelPlayback(session)
  if (!audioPcm16le16k.length) return

  const frameBytes = 640 // 20ms @ 16kHz: 320 samples * 2 bytes
  const frameMs = 20

  let offset = 0
  const st: PlaybackState = { timer: null, cancelled: false }
  session.playback = st

  const sendNext = () => {
    if (st.cancelled) return
    if (ws.readyState !== WebSocket.OPEN) return
    if (offset >= audioPcm16le16k.length) {
      session.playback = null
      return
    }

    let chunk = audioPcm16le16k.subarray(offset, offset + frameBytes)
    offset += frameBytes

    if (chunk.length < frameBytes) {
      const padded = Buffer.alloc(frameBytes, 0)
      chunk.copy(padded)
      chunk = padded
    }

    ws.send(encodeSipAudioFrame(session.callId, chunk))
    st.timer = setTimeout(sendNext, frameMs)
  }

  sendNext()
}

function createVoskWs(callId: string): WebSocket {
  const voskBaseUrl = process.env['VOSK_SERVER_URL']
  if (!voskBaseUrl) {
    throw new Error('VOSK_SERVER_URL fehlt')
  }
  const voskUrl = `${voskBaseUrl.replace(/\/$/, '')}/vosk`

  const ws = new WebSocket(voskUrl)
  ws.binaryType = 'arraybuffer'

  ws.on('open', () => {
    const targetRate = 8000
    try {
      ws.send(`sample_rate=${targetRate},buffer_size=${20}`)
      // eslint-disable-next-line no-console
      console.log(`[SIP->VOSK] open callId=${callId} sampleRate=${targetRate}`)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[SIP->VOSK] config failed callId=${callId}`, e)
    }
  })

  ws.on('error', err => {
    // eslint-disable-next-line no-console
    console.error(`[SIP->VOSK] ws error callId=${callId}`, err)
  })

  return ws
}

function ensureSession(
  sessions: Map<string, CallSession>,
  callId: string,
): CallSession {
  const existing = sessions.get(callId)
  if (existing) return existing

  const voskWs = createVoskWs(callId)

  const s: CallSession = {
    callId,
    createdAt: Date.now(),
    lastTranscript: '',
    voskWs,
    voskOpen: false,
    pendingAudio: [],
    playback: null,
  }

  voskWs.on('open', () => {
    s.voskOpen = true
    // flush pending audio
    for (const a of s.pendingAudio) {
      try {
        voskWs.send(a)
      } catch {
        break
      }
    }
    s.pendingAudio = []
  })

  sessions.set(callId, s)
  return s
}

function closeSession(
  sessions: Map<string, CallSession>,
  callId: string,
): void {
  const s = sessions.get(callId)
  if (!s) return

  cancelPlayback(s)

  try {
    s.voskWs.close()
  } catch {
    // ignore
  }

  sessions.delete(callId)
}

export function startSipClientBridge(): void {
  const sipUrl = (process.env['SIP_CLIENT_WS_URL'] ?? '').trim()
  if (!sipUrl) {
    // eslint-disable-next-line no-console
    console.log('[SIP] SIP_CLIENT_WS_URL not set; SIP bridge disabled')
    return
  }

  const sessions = new Map<string, CallSession>()

  let ws: WebSocket | null = null
  let retryMs = 500

  const connect = () => {
    // eslint-disable-next-line no-console
    console.log(`[SIP] connecting ${sipUrl}`)
    ws = new WebSocket(sipUrl)

    ws.on('open', () => {
      retryMs = 500
      // eslint-disable-next-line no-console
      console.log('[SIP] connected')
    })

    ws.on('message', async (data, isBinary) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      if (!isBinary) {
        const str = data.toString('utf8')
        try {
          const msg = JSON.parse(str)
          if (msg?.type === 'call-end' && typeof msg?.callId === 'string') {
            closeSession(sessions, msg.callId)
          }
          return
        } catch {
          return
        }
      }

      const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      const frame: SipAudioFrame | null = decodeSipAudioFrame(b)
      if (!frame) return

      const session = ensureSession(sessions, frame.callId)

      // Vosk expects PCM16LE @ 8k in our setup; sip-client provides PCM16LE @ 16k.
      const pcm8k = downsample16kTo8kPickEveryOtherPcm16le(frame.audioPcm16le)

      if (session.voskOpen && session.voskWs.readyState === WebSocket.OPEN) {
        session.voskWs.send(pcm8k)
      } else {
        session.pendingAudio.push(pcm8k)
        // keep pending bounded (~2s @ 8kHz, 16-bit): 8000*2*2 = 32000 bytes
        let total = 0
        for (let i = session.pendingAudio.length - 1; i >= 0; i--) {
          total += session.pendingAudio[i]!.length
          if (total > 32000) {
            session.pendingAudio.splice(0, i)
            break
          }
        }
      }

      // Attach transcript handler once per session
      if ((session as any)._voskHandlerAttached) return
      ;(session as any)._voskHandlerAttached = true

      session.voskWs.on('message', async eventData => {
        const s = eventData.toString()
        let obj: any
        try {
          obj = JSON.parse(s)
        } catch {
          return
        }

        const plainText = extractTranscript(obj).trim()
        if (!plainText) return

        // ignore startup noise
        if (/whisper\.cpp|ggml-model|ggml-model-bin|ggml/i.test(plainText))
          return
        if (/^--\s*--$/.test(plainText) || plainText === '--') return

        if (plainText === session.lastTranscript) return
        session.lastTranscript = plainText

        cancelPlayback(session)

        let replyText: string | null = null
        try {
          const result = await chatService.handleChat({
            message: plainText,
            persist: false,
            isPhoneCall: true,
          })
          replyText = result.message || null
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[SIP] chat failed', e)
          return
        }

        if (!replyText) return
        // eslint-disable-next-line no-console
        console.log(`[SIP] reply callId=${session.callId} text=${replyText}`)

        try {
          const pcm16 = await ttsToPcm16le16k(replyText)
          if (!ws || ws.readyState !== WebSocket.OPEN) return
          startPlayback(ws, session, pcm16)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[SIP] tts failed', e)
        }
      })
    })

    ws.on('close', () => {
      // eslint-disable-next-line no-console
      console.warn('[SIP] disconnected; reconnecting')
      ws = null
      retryMs = Math.min(15000, Math.round(retryMs * 1.5))
      setTimeout(connect, retryMs)
    })

    ws.on('error', err => {
      // eslint-disable-next-line no-console
      console.error('[SIP] ws error', err)
    })
  }

  connect()
}

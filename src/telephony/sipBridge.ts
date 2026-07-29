/// <reference path="../types/wav-decoder.d.ts" />

import WebSocket from 'ws'
import { decode as decodeWav } from 'wav-decoder'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { chatService } from '../services/chatService'
import { generateBamborakAudioFromText } from '../services/bamborakService'
import { Visitor } from '../models/Visitor'
import { decodeSipAudioFrame, type SipAudioFrame } from './sipProtocol'
import { float32ToPcm16le, mixDownToMono, resampleLinear } from './audio'
import { VoskSendConfigService } from '../lib/vosk-config-service'

type WavDump = {
  fd: number
  filePath: string
  dataBytes: number
  sampleRateHz: number
  channels: number
}

type RawDump = {
  outDir: string
  counter: number
}

type VoskTxChunkDump = {
  outDir: string
  counter: number
  callId: string
}

type PcmDump = {
  fd: number
  filePath: string
  dataBytes: number
  sampleRateHz: number
  channels: number
  bitsPerSample: number
}

type PlaybackState = {
  timer: NodeJS.Timeout | null
  cancelled: boolean
  queue: Buffer[]
  current: Buffer | null
  currentOffset: number
}

type CallSession = {
  callId: string
  createdAt: number
  lastTranscript: string

  welcomeStarted: boolean
  welcomePlayed: boolean

  ignoredWhilePlaybackCount: number
  ignoredWhilePlaybackLastLogAt: number

  // We reuse Visitor.ipAddress as the stable key for history.
  // For phone calls we store the phone number (or callId) here.
  visitorIpAddress: string

  voskWs: WebSocket
  voskOpen: boolean
  pendingAudio: Buffer[]

  // Twilio-style timestamp stream to Vosk (13-digit ms string messages)
  voskTimestampMs: number

  // Optional dump of outgoing chunks sent to Vosk
  voskTxDump: VoskTxChunkDump | null

  rxDump: WavDump | null
  rxPcmDump: PcmDump | null

  playback: PlaybackState | null
  ttsGenerationId: number
}

function maybePlayWelcomeText(ws: WebSocket, session: CallSession): void {
  if (session.welcomeStarted) return

  const text = (process.env['SIP_WELCOME_TEXT'] ?? '').trim()
  if (!text) return

  session.welcomeStarted = true

  void (async () => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[SIP] welcome playback start callId=${session.callId}`)
      await streamTtsTextToPlayback(ws, session, text)
      session.welcomePlayed = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[SIP] welcome TTS failed', e)
    }
  })()
}

function normalizePhoneIdForVisitor(callId: string): string {
  const raw = (callId ?? '').trim()
  if (!raw) return ''
  // Keep digits and an optional leading +; strip separators.
  const cleaned = raw.replace(/[^\d+]/g, '')
  return cleaned || raw
}

async function ensurePhoneVisitor(ipAddress: string): Promise<void> {
  const key = (ipAddress ?? '').trim()
  if (!key) return

  await Visitor.findOneAndUpdate(
    { ipAddress: key },
    { $push: { lastVisitedAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
}

function to13DigitMsString(ms: number): string {
  const s = Math.max(0, Math.floor(ms)).toString()
  return s.padStart(13, '0').slice(-13)
}

const rawWsDump: RawDump | null = (() => {
  if (!envFlag('SIP_DUMP_WS_MESSAGES', false)) return null

  const dir = (process.env['SIP_DUMP_WS_MESSAGES_DIR'] ?? '').trim()
  const outDir = dir
    ? dir
    : path.join(process.cwd(), 'recordings', 'phone', 'ws')
  fs.mkdirSync(outDir, { recursive: true })
  // eslint-disable-next-line no-console
  console.log(`[SIP] dumping raw WS messages dir=${outDir}`)
  return { outDir, counter: 0 }
})()

function openVoskTxChunkDump(callId: string): VoskTxChunkDump | null {
  if (!envFlag('VOSK_DUMP_TX_CHUNKS', false)) return null

  const dir = (process.env['VOSK_DUMP_TX_CHUNKS_DIR'] ?? '').trim()
  const baseOutDir = dir
    ? dir
    : path.join(process.cwd(), 'recordings', 'phone', 'vosk-tx')

  fs.mkdirSync(baseOutDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeCallId = sanitizeForFileName(callId)
  const outDir = path.join(baseOutDir, `${stamp}-${safeCallId}`)
  fs.mkdirSync(outDir, { recursive: true })

  // eslint-disable-next-line no-console
  console.log(`[SIP->VOSK] dumping tx chunks callId=${callId} dir=${outDir}`)

  return { outDir, counter: 0, callId }
}

function dumpVoskTxChunk(
  dump: VoskTxChunkDump,
  kind: 'timestamp' | 'audio-mulaw8k',
  data: Buffer,
  meta: Record<string, unknown> = {},
): void {
  dump.counter++
  const idx = String(dump.counter).padStart(6, '0')
  const fileBase = path.join(dump.outDir, `${idx}-${kind}`)

  try {
    fs.writeFileSync(`${fileBase}.bin`, data)
    fs.writeFileSync(
      `${fileBase}.json`,
      JSON.stringify(
        {
          kind,
          callId: dump.callId,
          bytes: data.length,
          ...meta,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[SIP->VOSK] tx chunk dump failed', e)
  }
}

function dumpIncomingWsMessage(data: WebSocket.RawData, isBinary: boolean) {
  if (!rawWsDump) return

  rawWsDump.counter++
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const idx = String(rawWsDump.counter).padStart(6, '0')
  const kind = isBinary ? 'bin' : 'txt'

  const fileBase = path.join(rawWsDump.outDir, `wsmsg-${stamp}-${idx}`)
  const metaPath = `${fileBase}.json`
  const dataPath = `${fileBase}.${kind}`

  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    const meta = {
      isBinary,
      bytes: buf.length,
      magic: buf.subarray(0, 16).toString('ascii'),
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
    if (isBinary) {
      fs.writeFileSync(dataPath, buf)
    } else {
      fs.writeFileSync(dataPath, buf.toString('utf8'))
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[SIP] raw ws dump failed', e)
  }
}

function pcm16leToMulaw8k(pcm16le: Buffer): Buffer {
  // G.711 μ-law encode (8-bit), expects 8kHz mono PCM16LE input
  const BIAS = 0x84
  const CLIP = 32635
  const segEnd = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff]

  const outLen = Math.floor(pcm16le.length / 2)
  const out = Buffer.allocUnsafe(outLen)

  const searchSegment = (val: number): number => {
    for (let i = 0; i < 8; i++) {
      if (val <= segEnd[i]!) return i
    }
    return 7
  }

  const linearToMuLawByte = (sample: number): number => {
    let mask = 0xff
    let pcm = sample
    if (pcm < 0) {
      pcm = -pcm
      mask = 0x7f
    }

    if (pcm > CLIP) pcm = CLIP
    pcm += BIAS

    const seg = searchSegment(pcm)
    const uval = (seg << 4) | ((pcm >> (seg + 3)) & 0x0f)
    return (uval ^ mask) & 0xff
  }

  for (let i = 0; i < outLen; i++) {
    const s = pcm16le.readInt16LE(i * 2)
    out[i] = linearToMuLawByte(s)
  }

  return out
}

function sendAudioToVosk(session: CallSession, pcm16le8k: Buffer): void {
  if (!pcm16le8k.length) return
  if (!session.voskOpen) return
  if (session.voskWs.readyState !== WebSocket.OPEN) return

  // Match the legacy Twilio flow: send small raw audio chunks and (optionally) a 13-digit timestamp message.
  const chunkBytes = Math.max(
    1,
    Number.parseInt(
      (process.env['VOSK_AUDIO_CHUNK_BYTES'] ?? '160').trim(),
      10,
    ) || 160,
  )
  const includeTimestamp = envFlag('VOSK_SEND_TIMESTAMP', true)

  const mulaw = pcm16leToMulaw8k(pcm16le8k)
  for (let off = 0; off < mulaw.length; off += chunkBytes) {
    const chunk = mulaw.subarray(off, off + chunkBytes)
    if (!chunk.length) break
    if (includeTimestamp) {
      // Send timestamp as a binary WS frame too (ASCII digits in a Buffer).
      const tsStr = to13DigitMsString(session.voskTimestampMs)
      const tsBuf = Buffer.from(tsStr, 'utf8')
      if (session.voskTxDump) {
        dumpVoskTxChunk(session.voskTxDump, 'timestamp', tsBuf, {
          timestampMs: session.voskTimestampMs,
          timestampStr: tsStr,
        })
      }
      session.voskWs.send(tsBuf, { binary: true })
      // μ-law @ 8kHz: 1 byte == 1 sample
      session.voskTimestampMs += (chunk.length * 1000) / 8000
    }
    if (session.voskTxDump) {
      dumpVoskTxChunk(session.voskTxDump, 'audio-mulaw8k', chunk, {
        chunkOffset: off,
        chunkBytes: chunk.length,
      })
    }
    session.voskWs.send(chunk, { binary: true })
  }
}

function envFlag(name: string, def = false): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  if (!v) return def
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function sanitizeForFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

function normalizeSpeechText(input: string): string {
  // Lowercase + strip punctuation; keep unicode letters/numbers.
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isPlaybackInterruptPhraseSpoken(transcript: string): boolean {
  const raw = (process.env['SIP_PLAYBACK_INTERRUPT_WORD'] ?? 'Dzakuju').trim()
  if (!raw) return false

  const t = normalizeSpeechText(transcript)
  if (!t) return false

  const candidates = raw
    .split(/[,|;]/g)
    .map(s => normalizeSpeechText(s))
    .filter(Boolean)

  if (!candidates.length) return false

  const paddedT = ` ${t} `
  const compactT = t.replace(/\s+/g, '')

  for (const w of candidates) {
    // Whole-word/whole-phrase match against space-padded normalized string.
    if (paddedT.includes(` ${w} `)) return true

    // Also match ignoring spaces (Vosk sometimes inserts/omits word boundaries).
    const compactW = w.replace(/\s+/g, '')
    if (compactW && compactT.includes(compactW)) return true
  }

  return false
}

function wavHeaderPcm16le(
  dataBytes: number,
  sampleRateHz: number,
  channels: number,
): Buffer {
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRateHz * blockAlign

  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0, 4, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 4, 'ascii')
  buf.write('fmt ', 12, 4, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM format
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRateHz, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36, 4, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

const sampleRateHz = 8000
const BufferSize = 160 // 20ms of 8kHz mono audio

function openRxDump(callId: string): WavDump | null {
  if (!envFlag('SIP_DUMP_RX_AUDIO', false)) return null

  const channels = 1

  const dir = (process.env['SIP_DUMP_RX_AUDIO_DIR'] ?? '').trim()
  const outDir = dir ? dir : path.join(process.cwd(), 'recordings', 'phone')

  fs.mkdirSync(outDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeCallId = sanitizeForFileName(callId)
  const filePath = path.join(outDir, `rx-${stamp}-${safeCallId}.wav`)

  const fd = fs.openSync(filePath, 'w')
  const header = wavHeaderPcm16le(0, sampleRateHz, channels)
  fs.writeSync(fd, header)

  // eslint-disable-next-line no-console
  console.log(`[SIP] dumping rx audio callId=${callId} file=${filePath}`)

  return { fd, filePath, dataBytes: 0, sampleRateHz, channels }
}

function openRxPcmDump(callId: string): PcmDump | null {
  if (!envFlag('SIP_DUMP_RX_PCM', false)) return null

  const channels = 1
  const bitsPerSample = 16

  const dir = (process.env['SIP_DUMP_RX_PCM_DIR'] ?? '').trim()
  const outDir = dir ? dir : path.join(process.cwd(), 'recordings', 'phone')
  fs.mkdirSync(outDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeCallId = sanitizeForFileName(callId)
  const filePath = path.join(outDir, `rx-${stamp}-${safeCallId}.pcm16le`)

  const fd = fs.openSync(filePath, 'w')
  // eslint-disable-next-line no-console
  console.log(`[SIP] dumping rx pcm callId=${callId} file=${filePath}`)

  return { fd, filePath, dataBytes: 0, sampleRateHz, channels, bitsPerSample }
}

function appendRxPcmDump(dump: PcmDump, pcm16le: Buffer): void {
  if (!pcm16le.length) return
  fs.writeSync(dump.fd, pcm16le)
  dump.dataBytes += pcm16le.length
}

function closeRxPcmDump(dump: PcmDump): void {
  try {
    fs.closeSync(dump.fd)
  } catch {
    // ignore
  }
  // eslint-disable-next-line no-console
  console.log(
    `[SIP] dumped rx pcm file=${dump.filePath} bytes=${dump.dataBytes} format=pcm${dump.bitsPerSample}le ${dump.sampleRateHz}Hz ch=${dump.channels}`,
  )
}

function appendRxDump(dump: WavDump, pcm16le: Buffer): void {
  if (!pcm16le.length) return
  fs.writeSync(dump.fd, pcm16le)
  dump.dataBytes += pcm16le.length
}

function closeRxDump(dump: WavDump): void {
  try {
    const header = wavHeaderPcm16le(
      dump.dataBytes,
      dump.sampleRateHz,
      dump.channels,
    )
    fs.writeSync(dump.fd, header, 0, header.length, 0)
  } catch {
    // ignore
  }

  try {
    fs.closeSync(dump.fd)
  } catch {
    // ignore
  }

  // eslint-disable-next-line no-console
  console.log(
    `[SIP] dumped rx audio file=${dump.filePath} bytes=${dump.dataBytes}`,
  )
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

function previewForLog(input: string, maxLen = 1200): string {
  const s = input.replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…(+${s.length - maxLen} chars)`
}

async function ttsToPcm16le8k(text: string): Promise<Buffer> {
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
  const resampled = resampleLinear(mono, decoded.sampleRate, 8000)
  return float32ToPcm16le(resampled)
}

function clearPlayback(session: CallSession): void {
  const st = session.playback
  if (!st) return
  st.cancelled = true
  if (st.timer) clearTimeout(st.timer)
  st.timer = null
  session.playback = null
}

function cancelPlayback(session: CallSession): void {
  clearPlayback(session)
  // Invalidate any in-flight streamed TTS generation.
  session.ttsGenerationId++
}

function createPlaybackState(): PlaybackState {
  return {
    timer: null,
    cancelled: false,
    queue: [],
    current: null,
    currentOffset: 0,
  }
}

function pumpPlayback(
  ws: WebSocket,
  session: CallSession,
  st: PlaybackState,
): void {
  const frameBytes = 320 // 20ms @ 8kHz: 160 samples * 2 bytes
  const frameMs = 20

  const sendNext = () => {
    if (st.cancelled) return
    if (ws.readyState !== WebSocket.OPEN) return

    if (!st.current || st.currentOffset >= st.current.length) {
      st.current = st.queue.shift() ?? null
      st.currentOffset = 0
    }

    if (!st.current) {
      session.playback = null
      st.timer = null
      return
    }

    let chunk = st.current.subarray(
      st.currentOffset,
      st.currentOffset + frameBytes,
    )
    st.currentOffset += frameBytes

    if (chunk.length < frameBytes) {
      const padded = Buffer.alloc(frameBytes, 0)
      chunk.copy(padded)
      chunk = padded
    }

    // Send raw audio only (no custom AGTA header)
    ws.send(chunk)
    st.timer = setTimeout(sendNext, frameMs)
  }

  sendNext()
}

function enqueuePlayback(
  ws: WebSocket,
  session: CallSession,
  audioPcm16le8k: Buffer,
): void {
  if (!audioPcm16le8k.length) return
  if (ws.readyState !== WebSocket.OPEN) return

  let st = session.playback
  if (!st) {
    st = createPlaybackState()
    session.playback = st
  }

  st.queue.push(audioPcm16le8k)

  // Start pumping when idle.
  if (!st.timer && (!st.current || st.currentOffset >= st.current.length)) {
    pumpPlayback(ws, session, st)
  }
}

function splitTextForTts(text: string, maxChunkChars = 260): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const sentenceLike =
    trimmed
      .match(/[^.!?\n]+[.!?]?/g)
      ?.map(s => s.trim())
      .filter(Boolean) ?? []

  const sourceParts = sentenceLike.length ? sentenceLike : [trimmed]
  const out: string[] = []
  let current = ''

  for (const part of sourceParts) {
    if (!part) continue
    const next = current ? `${current} ${part}` : part
    if (next.length <= maxChunkChars) {
      current = next
      continue
    }

    if (current) out.push(current)

    if (part.length <= maxChunkChars) {
      current = part
      continue
    }

    // Very long sentence fallback: split around maxChunkChars on whitespace.
    let remaining = part
    while (remaining.length > maxChunkChars) {
      const cutAt = remaining.lastIndexOf(' ', maxChunkChars)
      const idx = cutAt > 30 ? cutAt : maxChunkChars
      out.push(remaining.slice(0, idx).trim())
      remaining = remaining.slice(idx).trim()
    }
    current = remaining
  }

  if (current) out.push(current)
  return out.filter(Boolean)
}

async function streamTtsTextToPlayback(
  ws: WebSocket,
  session: CallSession,
  text: string,
): Promise<void> {
  const chunks = splitTextForTts(text)
  if (!chunks.length) return

  // Replace any currently playing utterance with the new one.
  clearPlayback(session)
  session.ttsGenerationId++
  const generationId = session.ttsGenerationId

  for (const chunkText of chunks) {
    if (session.ttsGenerationId !== generationId) return
    if (ws.readyState !== WebSocket.OPEN) return

    let pcm16: Buffer
    try {
      pcm16 = await ttsToPcm16le8k(chunkText)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[SIP] chunk tts failed callId=${session.callId} chunk=${previewForLog(chunkText, 120)}`,
        e,
      )
      continue
    }

    if (session.ttsGenerationId !== generationId) return
    if (ws.readyState !== WebSocket.OPEN) return
    enqueuePlayback(ws, session, pcm16)
  }
}

function createVoskWs(callId: string): WebSocket {
  const voskBaseUrl = process.env['VOSK_SERVER_URL']
  if (!voskBaseUrl) {
    throw new Error('VOSK_SERVER_URL fehlt')
  }
  // Keep identical to the legacy Twilio bridge: use VOSK_SERVER_URL as-is.
  const ws = new WebSocket(voskBaseUrl)
  ws.binaryType = 'arraybuffer'

  ws.on('open', () => {
    VoskSendConfigService.sendConfig(ws, sampleRateHz, BufferSize)
    console.log(`[SIP->VOSK] open callId=${callId}`)
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

  const visitorIpAddress = normalizePhoneIdForVisitor(callId)

  const s: CallSession = {
    callId,
    createdAt: Date.now(),
    lastTranscript: '',

    welcomeStarted: false,
    welcomePlayed: false,

    ignoredWhilePlaybackCount: 0,
    ignoredWhilePlaybackLastLogAt: 0,
    visitorIpAddress,
    voskWs,
    voskOpen: false,
    pendingAudio: [],
    voskTimestampMs: 0,
    voskTxDump: openVoskTxChunkDump(callId),
    rxDump: openRxDump(callId),
    rxPcmDump: openRxPcmDump(callId),
    playback: null,
    ttsGenerationId: 0,
  }

  ensurePhoneVisitor(visitorIpAddress).catch(e => {
    // eslint-disable-next-line no-console
    console.warn(
      `[SIP] failed to ensure phone visitor ipAddress=${visitorIpAddress}`,
      e,
    )
  })

  voskWs.on('open', () => {
    s.voskOpen = true
    const chunklen =
      Number.parseInt(
        (process.env['VOSK_AUDIO_CHUNK_BYTES'] ?? '160').trim(),
        10,
      ) || 160
    VoskSendConfigService.sendChunkLength(voskWs, chunklen)
    VoskSendConfigService.sendConfig(voskWs, sampleRateHz, BufferSize)
    VoskSendConfigService.sendSampleFormat(voskWs, 'ULAW')
    // flush pending audio
    for (const a of s.pendingAudio) {
      try {
        sendAudioToVosk(s, a)
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

  if (s.rxDump) {
    try {
      closeRxDump(s.rxDump)
    } catch {
      // ignore
    }
    s.rxDump = null
  }

  if (s.rxPcmDump) {
    try {
      closeRxPcmDump(s.rxPcmDump)
    } catch {
      // ignore
    }
    s.rxPcmDump = null
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

    ws.on('unexpected-response', (_req, res) => {
      // eslint-disable-next-line no-console
      console.error(
        `[SIP] unexpected response status=${res.statusCode} ${res.statusMessage ?? ''}`,
      )
    })

    ws.on('open', () => {
      retryMs = 500
      // eslint-disable-next-line no-console
      console.log('[SIP] connected')
    })

    ws.on('close', (code, reason) => {
      // eslint-disable-next-line no-console
      console.log(
        `[SIP] ws close code=${code} reason=${reason ? reason.toString() : ''}`,
      )
    })

    ws.on('message', async (data, isBinary) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      dumpIncomingWsMessage(data, isBinary)

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
      maybePlayWelcomeText(ws, session)

      if (session.rxDump) {
        try {
          appendRxDump(session.rxDump, frame.audioPcm16le)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[SIP] rx dump write failed callId=${session.callId}`, e)
        }
      }

      if (session.rxPcmDump) {
        try {
          appendRxPcmDump(session.rxPcmDump, frame.audioPcm16le)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `[SIP] rx pcm dump write failed callId=${session.callId}`,
            e,
          )
        }
      }

      if (session.voskOpen && session.voskWs.readyState === WebSocket.OPEN) {
        sendAudioToVosk(session, frame.audioPcm16le)
      } else {
        session.pendingAudio.push(frame.audioPcm16le)
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
          // eslint-disable-next-line no-console
          console.warn(
            `[VOSK->SIP] callId=${session.callId} non-json message ignored`,
          )
          return
        }

        const plainText = extractTranscript(obj).trim()

        // Skip Vosk keepalive/noise messages like {"partial":"","listen":"true"}
        if (!plainText) return

        const playbackActive = !!session.playback
        const interruptSpoken = isPlaybackInterruptPhraseSpoken(plainText)

        if (playbackActive && !interruptSpoken) {
          // While we are speaking, ignore user input unless the interrupt word is spoken.
          session.ignoredWhilePlaybackCount++
          const now = Date.now()
          if (
            session.ignoredWhilePlaybackLastLogAt === 0 ||
            now - session.ignoredWhilePlaybackLastLogAt > 1500
          ) {
            session.ignoredWhilePlaybackLastLogAt = now
            // eslint-disable-next-line no-console
            console.log(
              `[SIP] ignore transcript during playback callId=${session.callId} count=${session.ignoredWhilePlaybackCount} text=${previewForLog(plainText, 180)}`,
            )
          }
          return
        }

        // eslint-disable-next-line no-console
        console.log(
          `[VOSK->SIP] callId=${session.callId} raw=${previewForLog(s)}`,
        )
        // eslint-disable-next-line no-console
        console.log(
          `[VOSK->SIP] callId=${session.callId} transcript=${previewForLog(plainText, 300)}`,
        )

        // ignore startup noise
        if (/whisper\.cpp|ggml-model|ggml-model-bin|ggml/i.test(plainText))
          return
        if (/^--\s*--$/.test(plainText) || plainText === '--') return

        if (interruptSpoken) {
          const configured =
            (process.env['SIP_PLAYBACK_INTERRUPT_WORD'] ?? 'Dźakuju').trim() ||
            'Dźakuju'
          // eslint-disable-next-line no-console
          console.log(
            `[SIP] interrupt word detected callId=${session.callId} playbackActive=${playbackActive} configured=${JSON.stringify(configured)} transcript=${previewForLog(plainText, 180)}`,
          )

          if (playbackActive) {
            // eslint-disable-next-line no-console
            console.log(
              `[SIP] interrupt -> cancelling playback callId=${session.callId}`,
            )
            cancelPlayback(session)
          }
        }

        if (plainText === session.lastTranscript) return
        session.lastTranscript = plainText

        let replyText: string | null = null
        try {
          // Ensure the Visitor exists for this phone identity before we fetch/persist history.
          await ensurePhoneVisitor(session.visitorIpAddress)
          const result = await chatService.handleChat({
            message: plainText,
            persist: true,
            ipAddress: session.visitorIpAddress,
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
          if (!ws || ws.readyState !== WebSocket.OPEN) return
          await streamTtsTextToPlayback(ws, session, replyText)
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

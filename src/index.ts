import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { connectDB } from './config/database'
import { errorHandler } from './middleware/errorHandler'
import routes from './routes'
import OpenAI from 'openai'
import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'
import {
  handleTranscriptAndCreateReplyText,
  ttsToMulaw8kBase64,
  TwilioMsg,
  to13DigitMsString,
  sendAudioToTwilio,
  clearTwilioPlayback,
} from './helpers/twilio-socket'
// import { schedulerService } from './services/scheduler'

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env['PORT'] || 3000
export const openAI = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'] || 'OPENAI_API_KEY',
})

// Middleware
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Routes
app.use('/api', routes)

// Health check route
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
  })
})

// Error handling middleware
app.use(errorHandler)

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

const server = http.createServer(app)
const wss = new WebSocketServer({
  server,
  path: '/api/hooks/twilio-websocket',
})

// ========= 3) WS: Twilio <-> Vosk Bridge =========
wss.on('connection', (twilioWs, req) => {
  console.log('Twilio WS connected:', req.socket.remoteAddress)

  const VOSK_DEBUG =
    process.env['VOSK_DEBUG'] === '1' ||
    process.env['VOSK_DEBUG'] === 'true' ||
    process.env['VOSK_DEBUG'] === 'yes'

  const VOSK_AUDIO_ENCODING = (process.env['VOSK_AUDIO_ENCODING'] ?? 'pcm16')
    .toLowerCase()
    .trim()
  const VOSK_TARGET_SAMPLE_RATE = Number(
    process.env['VOSK_TARGET_SAMPLE_RATE'] ?? '8000',
  )

  const TWILIO_SAVE_AUDIO =
    process.env['TWILIO_SAVE_AUDIO'] === '1' ||
    process.env['TWILIO_SAVE_AUDIO'] === 'true' ||
    process.env['TWILIO_SAVE_AUDIO'] === 'yes'
  const TWILIO_SAVE_AUDIO_PCM16 =
    process.env['TWILIO_SAVE_AUDIO_PCM16'] === '1' ||
    process.env['TWILIO_SAVE_AUDIO_PCM16'] === 'true' ||
    process.env['TWILIO_SAVE_AUDIO_PCM16'] === 'yes'
  const TWILIO_AUDIO_DIR =
    (process.env['TWILIO_AUDIO_DIR'] ?? './twilio-audio').trim() ||
    './twilio-audio'

  // Default: only log Vosk output; do not send any reply audio back to Twilio.
  const TWILIO_ENABLE_REPLY =
    process.env['TWILIO_ENABLE_REPLY'] === '1' ||
    process.env['TWILIO_ENABLE_REPLY'] === 'true' ||
    process.env['TWILIO_ENABLE_REPLY'] === 'yes'

  // Your Vosk endpoint only supports 8000/64000; Twilio delivers µ-law 8k.
  // Default behavior: convert µ-law -> PCM16LE (still 8k) so ASR backends can decode it.
  // Set VOSK_AUDIO_ENCODING=mulaw8k to forward raw Twilio bytes.
  const shouldConvertMulawToPcm16 =
    VOSK_AUDIO_ENCODING !== 'mulaw8k' &&
    VOSK_AUDIO_ENCODING !== 'mulaw' &&
    VOSK_AUDIO_ENCODING !== 'ulaw'

  const normalizeVoskSampleRate = (sr: number): 8000 | 64000 => {
    if (Number.isFinite(sr) && sr === 64000) return 64000
    return 8000
  }

  const targetSampleRate: 8000 | 64000 = shouldConvertMulawToPcm16
    ? normalizeVoskSampleRate(VOSK_TARGET_SAMPLE_RATE)
    : 8000

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

    // Common shapes: words/result arrays
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

    if (Array.isArray(data?.segments)) {
      const t = data.segments
        .map((s: any) => s?.text)
        .filter(Boolean)
        .join(' ')
      if (t.trim()) return t
    }

    return ''
  }

  function muLawToLinearPcm16Sample(muLawByte: number): number {
    // ITU-T G.711 µ-law decode
    const mu = ~muLawByte & 0xff
    const sign = mu & 0x80
    let exponent = (mu >> 4) & 0x07
    let mantissa = mu & 0x0f
    let sample = ((mantissa << 3) + 0x84) << exponent
    sample -= 0x84
    return sign ? -sample : sample
  }

  function decodeMulawToPcm16LE(mulaw: Buffer): Buffer {
    const out = Buffer.alloc(mulaw.length * 2)
    for (let i = 0; i < mulaw.length; i++) {
      const s = muLawToLinearPcm16Sample(mulaw[i]!)
      out.writeInt16LE(s, i * 2)
    }
    return out
  }

  function resamplePcm16LELinear(
    pcm16le: Buffer,
    inSampleRate: number,
    outSampleRate: number,
  ): Buffer {
    if (inSampleRate === outSampleRate) return pcm16le
    const inSamples = pcm16le.length / 2
    if (!Number.isFinite(inSamples) || inSamples <= 1) return pcm16le

    const ratio = outSampleRate / inSampleRate
    const outSamples = Math.max(1, Math.round(inSamples * ratio))
    const out = Buffer.alloc(outSamples * 2)

    const readSample = (idx: number) =>
      pcm16le.readInt16LE(Math.max(0, Math.min(inSamples - 1, idx)) * 2)

    for (let i = 0; i < outSamples; i++) {
      const pos = i / ratio
      const idx = Math.floor(pos)
      const frac = pos - idx
      const s0 = readSample(idx)
      const s1 = readSample(idx + 1)
      const v = Math.round(s0 + (s1 - s0) * frac)
      out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2)
    }

    return out
  }

  // Client-WS zu VOSK
  const voskBaseUrl = process.env['VOSK_SERVER_URL']
  if (!voskBaseUrl) {
    console.error('VOSK_SERVER_URL fehlt')
    twilioWs.close()
    return
  }

  const voskUrl = `${voskBaseUrl.replace(/\/$/, '')}/vosk`

  const voskWs = new WebSocket(voskUrl)
  voskWs.binaryType = 'arraybuffer'

  let streamSid: string | null = null
  let lastFinalText = '' // simple de-dupe
  let mediaFrameCount = 0
  let lastMediaLogAtMs = -1
  let twilioMsgCount = 0
  let voskOpen = false
  let syntheticTsMs = 0
  const pendingAudio: Array<{ tsMs: number; audio: Buffer }> = []
  const MAX_PENDING_AUDIO_BYTES = 8000 * 5 // ~5 seconds at 8kHz 8-bit
  let lastAudioActivityLogFrame = 0
  let voskMsgCount = 0
  let lastVoskDebugLogAt = 0
  let placeholderCount = 0
  let sentListenTrue = false

  let audioOutDir: string | null = null
  let mulawWriteStream: fs.WriteStream | null = null
  let pcm16WriteStream: fs.WriteStream | null = null
  let voskPacketsWriteStream: fs.WriteStream | null = null
  let voskPacketsIndexWriteStream: fs.WriteStream | null = null
  let packetSeq = 0

  const ensureAudioDir = (sid: string | null) => {
    if (!TWILIO_SAVE_AUDIO) return
    if (audioOutDir) return

    const safeSid = (sid ?? 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80)

    const baseDir = path.isAbsolute(TWILIO_AUDIO_DIR)
      ? TWILIO_AUDIO_DIR
      : path.join(process.cwd(), TWILIO_AUDIO_DIR)

    audioOutDir = path.join(baseDir, `${safeSid}-${Date.now()}`)
    fs.mkdirSync(audioOutDir, { recursive: true })

    mulawWriteStream = fs.createWriteStream(
      path.join(audioOutDir, 'incoming.mulaw'),
    )

    if (shouldConvertMulawToPcm16 || TWILIO_SAVE_AUDIO_PCM16) {
      pcm16WriteStream = fs.createWriteStream(
        path.join(audioOutDir, `incoming.pcm16le.${targetSampleRate}hz.raw`),
      )
    }

    // Packetized capture of what we send to Vosk (timestamp + exact audio bytes)
    packetSeq = 0
    voskPacketsWriteStream = fs.createWriteStream(
      path.join(audioOutDir, 'vosk_packets.bin'),
    )
    voskPacketsIndexWriteStream = fs.createWriteStream(
      path.join(audioOutDir, 'vosk_packets.jsonl'),
    )
    try {
      fs.writeFileSync(
        path.join(audioOutDir, 'vosk_packets_meta.json'),
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            streamSid: sid,
            inputFromTwilio: {
              encoding: 'mulaw',
              sampleRate: 8000,
              channels: 1,
            },
            outputToVosk: {
              encoding: shouldConvertMulawToPcm16 ? 'pcm_s16le' : 'mulaw',
              sampleRate: targetSampleRate,
              channels: 1,
            },
            format: {
              binary: 'vosk_packets.bin',
              packetHeader: {
                timestampMs: 'uint64le',
                audioBytes: 'uint32le',
              },
              packetBody: 'audio bytes as sent to Vosk',
              index: 'vosk_packets.jsonl (one JSON object per packet)',
            },
          },
          null,
          2,
        ),
      )
    } catch {}

    console.log('Twilio audio recording enabled:', {
      dir: audioOutDir,
      mulaw: true,
      pcm16le: Boolean(pcm16WriteStream),
      pcm16leSampleRate: targetSampleRate,
      voskPackets: true,
    })
  }

  const writeVoskPacket = (tsMs: number, audio: Buffer) => {
    if (!TWILIO_SAVE_AUDIO) return
    if (!voskPacketsWriteStream || !voskPacketsIndexWriteStream) return

    packetSeq++
    const ts = Math.max(0, Math.floor(tsMs))
    const header = Buffer.alloc(12)
    header.writeBigUInt64LE(BigInt(ts), 0)
    header.writeUInt32LE(audio.length, 8)
    try {
      voskPacketsWriteStream.write(header)
      voskPacketsWriteStream.write(audio)
      voskPacketsIndexWriteStream.write(
        JSON.stringify({
          i: packetSeq,
          tsMs: ts,
          ts13: to13DigitMsString(ts),
          bytes: audio.length,
        }) + '\n',
      )
    } catch {}
  }

  const closeAudioStreams = () => {
    try {
      mulawWriteStream?.end()
    } catch {}
    try {
      pcm16WriteStream?.end()
    } catch {}
    try {
      voskPacketsWriteStream?.end()
    } catch {}
    try {
      voskPacketsIndexWriteStream?.end()
    } catch {}
    mulawWriteStream = null
    pcm16WriteStream = null
    voskPacketsWriteStream = null
    voskPacketsIndexWriteStream = null
    audioOutDir = null
  }

  console.log('Vosk audio forward mode:', {
    encoding: shouldConvertMulawToPcm16 ? 'pcm16le' : 'mulaw8k',
    targetSampleRate,
  })

  voskWs.on('open', () => {
    voskOpen = true
    console.log('Connection to Vosk established 🚀')

    // Send initial config. Your Vosk proxy supports 8000 or 64000; default to 8000 for Twilio.
    const sampleRate = targetSampleRate

    try {
      // Many servers accept extra hints; harmless if ignored.
      voskWs.send(`sample_rate=${sampleRate}`)

      sentListenTrue = true
    } catch (e) {
      console.warn('Failed to send Vosk config:', e)
    }

    // flush any audio we received before Vosk was ready
    while (pendingAudio.length) {
      const chunk = pendingAudio.shift()
      if (!chunk) break
      try {
        voskWs.send(chunk.audio)
      } catch {
        break
      }
    }
  })

  voskWs.on('error', err => {
    console.error('Vosk WebSocket error:', (err as any)?.message ?? err)
    try {
      twilioWs.close()
    } catch {}
  })

  // VOSK -> zurück an Twilio WS (und optional speichern / reply generieren)
  voskWs.on('message', async eventData => {
    voskMsgCount++
    // 1) Wenn du willst, kannst du Vosk-Messages 1:1 an einen Client weiterreichen.
    // Hier schicken wir sie NICHT blind an Twilio (Twilio versteht nur Twilio-JSON Events).
    // Stattdessen: parse + business logic.
    const str = eventData.toString()

    let data: any
    try {
      data = JSON.parse(str)
    } catch {
      console.warn('Vosk non-JSON message:', str)
      return
    }

    // Some proxies require an explicit "listen": true to start decoding.
    if (
      !sentListenTrue &&
      (data?.listen === 'false' || data?.listen === false)
    ) {
      sentListenTrue = true
      try {
        if (VOSK_DEBUG) console.log('Sent Vosk listen:true')
      } catch {}
    }

    const rawText = extractTranscript(data)

    if (VOSK_DEBUG && !rawText) {
      const now = Date.now()
      if (now - lastVoskDebugLogAt >= 1000) {
        lastVoskDebugLogAt = now
        console.log('Vosk msg (no transcript):', {
          msgCount: voskMsgCount,
          keys: data && typeof data === 'object' ? Object.keys(data) : null,
          preview: str.slice(0, 200),
        })
      }
      return
    }

    // --- Hier kannst du wie bei dir tokens/plainText normalisieren ---
    // const tokens = normalizeInputWords(data?.tokens ?? data?.result ?? data?.words);
    // const plainText = tokens?.length
    //   ? tokens.map((t: any) => t.word).join(" ")
    //   : normalizePlainFromText(rawText);

    const plainText = rawText.trim()
    if (!plainText) return

    // Ignore known whisper.cpp startup/banner/status noise (not user speech)
    if (/whisper\.cpp|ggml-model|ggml-model-bin|ggml/i.test(plainText)) {
      console.log('Vosk/Whisper banner:', plainText)
      return
    }

    // Some proxies emit placeholders like "--  --" for silence/empty partials
    if (/^--\s*--$/.test(plainText) || plainText === '--') {
      placeholderCount++
      if (VOSK_DEBUG && placeholderCount % 50 === 0) {
        console.log('Vosk placeholder transcripts:', {
          count: placeholderCount,
          msgCount: voskMsgCount,
        })
      }
      return
    }

    // ✅ This is the recognized user speech
    console.log('Vosk transcript:', plainText)

    // Current goal: just log what Vosk recognized.
    // Enable reply/TTS to Twilio explicitly via TWILIO_ENABLE_REPLY.
    if (!TWILIO_ENABLE_REPLY) return

    // if (shouldIgnoreTranscriptionText(plainText)) return;

    // Optional DB Save (wie bei dir)
    // if (recordId) {
    //   await AudioRecord.findByIdAndUpdate(recordId, {
    //     $push: {
    //       originalText: {
    //         plain: plainText,
    //         ...(tokens?.length ? { tokens } : {}),
    //       },
    //     },
    //   });
    // }

    // 2) Reply-Logik + TTS + zurück an Twilio
    // Du willst i.d.R. nur “finale” Ergebnisse beantworten.
    // Vosk sendet je nach Setup partial/final unterschiedlich.
    // Hier sehr simpel: wenn Text sich geändert hat, antworte.
    if (plainText === lastFinalText) return
    lastFinalText = plainText

    if (!streamSid) {
      console.warn('Kein streamSid bekannt, kann nicht an Twilio zurücksenden.')
      return
    }

    const replyText = await handleTranscriptAndCreateReplyText(plainText)
    if (!replyText) return

    console.log('Reply text:', replyText)

    // Barge-in freundlich: laufende Ausgabe stoppen, bevor wir neue senden
    clearTwilioPlayback(twilioWs, streamSid)

    try {
      const b64 = await ttsToMulaw8kBase64(replyText)
      sendAudioToTwilio(twilioWs, streamSid, b64)
      console.log('Sent TTS audio back to Twilio')
    } catch (e) {
      console.error('TTS failed:', e)
      // fallback: nichts senden
    }
  })

  // Twilio -> VOSK (Audio forward)
  twilioWs.on('message', (data, isBinary) => {
    twilioMsgCount++
    if (isBinary) {
      console.warn('Twilio sent binary frame:', {
        bytes: (data as Buffer).length,
        msgCount: twilioMsgCount,
      })
      return
    }

    const msgStr = data.toString('utf8')

    let msg: TwilioMsg
    try {
      msg = JSON.parse(msgStr)
    } catch {
      console.warn('Twilio sent non-JSON:', msgStr)
      return
    }

    if (msg.event !== 'media') {
      console.log('Twilio event:', msg.event)
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid ?? null
      syntheticTsMs = 0
      pendingAudio.length = 0
      ensureAudioDir(streamSid)
      console.log('Twilio start:', {
        streamSid,
        callSid: msg.start?.callSid,
        tracks: msg.start?.tracks,
        mediaFormat: msg.start?.mediaFormat,
      })
      return
    }

    if (msg.event === 'media') {
      mediaFrameCount++

      // 1) timestamp framing for your Vosk proxy: always send 13 digits.
      // Twilio sometimes omits timestamp; in that case we synthesize it based on chunk duration.
      const tsFromTwilio = msg.media?.timestamp

      // 2) audio payload base64 -> binary -> an Vosk
      const payload = msg.media?.payload
      if (!payload) {
        if (mediaFrameCount % 50 === 0) {
          console.log('Twilio media (no payload):', {
            ts: typeof tsFromTwilio === 'number' ? tsFromTwilio : null,
            syntheticTsMs,
            frames: mediaFrameCount,
            msgCount: twilioMsgCount,
          })
        }
        return
      }

      const audioBuffer = Buffer.from(payload, 'base64') // mulaw 8k raw

      if (TWILIO_SAVE_AUDIO) {
        ensureAudioDir(streamSid)
        try {
          mulawWriteStream?.write(audioBuffer)
        } catch {}
      }

      // Basic audio activity signal: Twilio µ-law silence is typically 0xFF.
      // Log about once every 1000ms worth of frames (50 frames * 20ms).
      if (mediaFrameCount - lastAudioActivityLogFrame >= 50) {
        lastAudioActivityLogFrame = mediaFrameCount
        let nonSilence = 0
        for (let i = 0; i < audioBuffer.length; i++) {
          if (audioBuffer[i] !== 0xff) nonSilence++
        }
        const nonSilenceRatio = nonSilence / Math.max(1, audioBuffer.length)
        console.log('Twilio audio activity:', {
          frames: mediaFrameCount,
          bytes: audioBuffer.length,
          nonSilenceRatio: Number(nonSilenceRatio.toFixed(3)),
        })
      }

      const chunkMs = Math.max(1, Math.round(audioBuffer.length / 8)) // 8000 bytes/sec => 8 bytes/ms
      const effectiveTsMs =
        typeof tsFromTwilio === 'number' ? tsFromTwilio : syntheticTsMs
      if (typeof tsFromTwilio !== 'number') {
        syntheticTsMs += chunkMs
      }

      // Log roughly once per second (timestamp if available), otherwise every 50 frames
      if (typeof tsFromTwilio === 'number') {
        if (lastMediaLogAtMs < 0 || tsFromTwilio - lastMediaLogAtMs >= 1000) {
          lastMediaLogAtMs = tsFromTwilio
          console.log('Twilio media:', {
            ts: tsFromTwilio,
            bytes: audioBuffer.length,
            frames: mediaFrameCount,
            msgCount: twilioMsgCount,
          })
        }
      } else if (mediaFrameCount % 50 === 0) {
        console.log('Twilio media:', {
          ts: null,
          syntheticTsMs: effectiveTsMs,
          bytes: audioBuffer.length,
          frames: mediaFrameCount,
          msgCount: twilioMsgCount,
        })
      }

      if (voskOpen && voskWs.readyState === WebSocket.OPEN) {
        const outAudio = shouldConvertMulawToPcm16
          ? resamplePcm16LELinear(
              decodeMulawToPcm16LE(audioBuffer),
              8000,
              targetSampleRate,
            )
          : audioBuffer

        if (TWILIO_SAVE_AUDIO) writeVoskPacket(effectiveTsMs, outAudio)

        if (TWILIO_SAVE_AUDIO && pcm16WriteStream) {
          try {
            pcm16WriteStream.write(
              shouldConvertMulawToPcm16
                ? outAudio
                : resamplePcm16LELinear(
                    decodeMulawToPcm16LE(audioBuffer),
                    8000,
                    targetSampleRate,
                  ),
            )
          } catch {}
        }

        voskWs.send(outAudio)
      } else {
        // buffer a bit so we don't drop the initial utterance
        const outAudio = shouldConvertMulawToPcm16
          ? resamplePcm16LELinear(
              decodeMulawToPcm16LE(audioBuffer),
              8000,
              targetSampleRate,
            )
          : audioBuffer

        if (TWILIO_SAVE_AUDIO) writeVoskPacket(effectiveTsMs, outAudio)

        if (TWILIO_SAVE_AUDIO && pcm16WriteStream) {
          try {
            pcm16WriteStream.write(
              shouldConvertMulawToPcm16
                ? outAudio
                : resamplePcm16LELinear(
                    decodeMulawToPcm16LE(audioBuffer),
                    8000,
                    targetSampleRate,
                  ),
            )
          } catch {}
        }
        11826
        pendingAudio.push({ tsMs: effectiveTsMs, audio: outAudio })
        let total = 0
        for (let i = pendingAudio.length - 1; i >= 0; i--) {
          total += pendingAudio[i]!.audio.length
          if (total > MAX_PENDING_AUDIO_BYTES) {
            pendingAudio.splice(0, i)
            break
          }
        }
      }
      return
    }

    if (msg.event === 'stop') {
      console.log('Twilio stop:', msg.stop)
      closeAudioStreams()
      try {
        voskWs.close()
      } catch {}
      // twilioWs.close()

      return
    }
  })

  twilioWs.on('close', () => {
    console.log('Twilio WS disconnected')
    closeAudioStreams()
    try {
      voskWs.close()
    } catch {}
  })

  twilioWs.on('error', err => {
    console.error('Twilio WS error:', err)
    closeAudioStreams()
    try {
      voskWs.close()
    } catch {}
  })
})

// Start server
const startServer = async (): Promise<void> => {
  try {
    // Connect to database
    await connectDB()

    // Start scheduled data fetching
    // const fetchInterval = parseInt(
    //   process.env['DATA_FETCH_INTERVAL'] || '3600000'
    // )
    // schedulerService.startScheduledFetching(fetchInterval)
    // schedulerService.startScheduledFetching()
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`)
      console.log(`📊 Environment: ${process.env['NODE_ENV'] || 'development'}`)
      console.log(`🔗 Health check: http://localhost:${PORT}/health`)
      // console.log(`🔄 Data fetching interval: ${fetchInterval}ms`)
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

startServer()

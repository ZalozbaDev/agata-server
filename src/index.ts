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

  // Client-WS zu VOSK
  const voskUrl = process.env['VOSK_SERVER_URL'] + '/vosk'

  if (!voskUrl) {
    console.error('VOSK_SERVER_URL fehlt')
    twilioWs.close()
    return
  }

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

  voskWs.on('open', () => {
    voskOpen = true
    console.log('Connection to Vosk established 🚀')

    // flush any audio we received before Vosk was ready
    while (pendingAudio.length) {
      const chunk = pendingAudio.shift()
      if (!chunk) break
      try {
        voskWs.send(to13DigitMsString(chunk.tsMs))
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

    const rawText = typeof data?.text === 'string' ? data.text : ''

    // deine Filter aus dem Beispiel
    if (
      rawText === '-- ***/whisper/ggml-model.q8_0.bin --' ||
      rawText === '-- **/whisper/ggml-model.q8_0.bin --' ||
      rawText === '-- */whisper/ggml-model.q8_0.bin --'
    ) {
      return
    }

    // --- Hier kannst du wie bei dir tokens/plainText normalisieren ---
    // const tokens = normalizeInputWords(data?.tokens ?? data?.result ?? data?.words);
    // const plainText = tokens?.length
    //   ? tokens.map((t: any) => t.word).join(" ")
    //   : normalizePlainFromText(rawText);

    const plainText = rawText.trim()
    if (!plainText) return

    // Filter out whisper.cpp startup/banner/status noise (not user speech)
    if (
      plainText.startsWith('--') ||
      /whisper\.cpp|ggml-model|ggml-model-bin|ggml/i.test(plainText)
    ) {
      console.log('Vosk/Whisper banner:', plainText)
      return
    }

    // ✅ This is the recognized user speech
    console.log('User said (ASR):', plainText)

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

    // Barge-in freundlich: laufende Ausgabe stoppen, bevor wir neue senden
    clearTwilioPlayback(twilioWs, streamSid)

    try {
      const b64 = await ttsToMulaw8kBase64(replyText)
      sendAudioToTwilio(twilioWs, streamSid, b64)
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
        voskWs.send(to13DigitMsString(effectiveTsMs))
        voskWs.send(audioBuffer)
      } else {
        // buffer a bit so we don't drop the initial utterance
        pendingAudio.push({ tsMs: effectiveTsMs, audio: audioBuffer })
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
      try {
        voskWs.close()
      } catch {}
      // twilioWs.close()

      return
    }
  })

  twilioWs.on('close', () => {
    console.log('Twilio WS disconnected')
    try {
      voskWs.close()
    } catch {}
  })

  twilioWs.on('error', err => {
    console.error('Twilio WS error:', err)
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

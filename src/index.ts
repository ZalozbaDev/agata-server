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
  const voskUrl = process.env['VOSK_SERVER_URL']
  console.log('Connecting to Vosk server at:', voskUrl)
  if (!voskUrl) {
    console.error('VOSK_SERVER_URL fehlt')
    twilioWs.close()
    return
  }

  const voskWs = new WebSocket(voskUrl)
  voskWs.binaryType = 'arraybuffer'

  let streamSid: string | null = null
  let lastFinalText = '' // simple de-dupe

  voskWs.on('open', () => console.log('Connection to Vosk established 🚀'))

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
  twilioWs.on('message', data => {
    const msgStr = data.toString('utf8')

    let msg: TwilioMsg
    try {
      msg = JSON.parse(msgStr)
    } catch {
      console.warn('Twilio sent non-JSON:', msgStr)
      return
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid ?? null
      console.log('Twilio start:', {
        streamSid,
        callSid: msg.start?.callSid,
        tracks: msg.start?.tracks,
      })
      return
    }

    if (msg.event === 'media') {
      // 1) optional: timestamp -> dein bisheriges Format (13-stellig)
      const ts = msg.media?.timestamp
      if (typeof ts === 'number' && voskWs.readyState === WebSocket.OPEN) {
        voskWs.send(to13DigitMsString(ts))
      }

      // 2) audio payload base64 -> binary -> an Vosk
      const payload = msg.media?.payload
      if (!payload) return

      const audioBuffer = Buffer.from(payload, 'base64') // mulaw 8k raw
      if (voskWs.readyState === WebSocket.OPEN) {
        voskWs.send(audioBuffer)
      }
      return
    }

    if (msg.event === 'stop') {
      console.log('Twilio stop:', msg.stop)
      try {
        voskWs.close()
      } catch {}
      try {
        twilioWs.close()
      } catch {}
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

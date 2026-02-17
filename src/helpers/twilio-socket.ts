import WebSocket from 'ws'
import { decode as decodeWav } from 'wav-decoder'
import { generateBamborakAudioFromText } from '../services/bamborakService'

export type TwilioMsg =
  | { event: 'connected' }
  | {
      event: 'start'
      start: {
        streamSid: string
        callSid?: string
        tracks?: string[]
        mediaFormat?: any
      }
    }
  | {
      event: 'media'
      streamSid: string
      media: { payload: string; timestamp?: number }
    }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'stop'; streamSid: string; stop: any }
  | { event: string; [k: string]: any }

export function to13DigitMsString(ms: number) {
  // dein Vosk-Proxy checkt message.length === 13
  // also stellen wir 13-stellig dar (Millisekunden seit "irgendwas"; Twilio timestamp ist i.d.R. ms seit Start)
  const s = Math.max(0, Math.floor(ms)).toString()
  return s.padStart(13, '0').slice(-13)
}

// === Platzhalter: deine “was damit gemacht werden”-Logik ===
export async function handleTranscriptAndCreateReplyText(
  transcript: string,
): Promise<string | null> {
  // Beispiel: einfache Echo-Logik
  const t = transcript.trim()
  if (!t) return null

  // TODO: hier deine Logik (LLM, Regeln, Routing, DB, etc.)
  return `Du hast gesagt: ${t}`
}

// === Platzhalter: TTS -> mulaw 8k base64 ===
// Du musst hier deinen TTS Service einbauen.
// Twilio braucht: audio/x-mulaw, 8000 Hz, base64 (ohne WAV header)
function mixDownToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array(0)
  if (channelData.length === 1) return channelData[0]!

  const minLen = Math.min(...channelData.map(ch => ch.length))
  const out = new Float32Array(minLen)
  for (let i = 0; i < minLen; i++) {
    let sum = 0
    for (const ch of channelData) sum += ch[i] ?? 0
    out[i] = sum / channelData.length
  }
  return out
}

function resampleLinear(
  input: Float32Array,
  inSampleRate: number,
  outSampleRate: number,
): Float32Array {
  if (inSampleRate === outSampleRate) return input
  if (input.length === 0) return input

  const ratio = outSampleRate / inSampleRate
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLen)

  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s0 = input[Math.min(idx, input.length - 1)] ?? 0
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? 0
    out[i] = s0 + (s1 - s0) * frac
  }

  return out
}

function linearPcm16ToMuLawByte(sample: number): number {
  // G.711 µ-law (8-bit)
  const BIAS = 0x84
  const CLIP = 32635

  let pcm = sample
  let sign = 0
  if (pcm < 0) {
    sign = 0x80
    pcm = -pcm
  }

  pcm = Math.min(pcm, CLIP)
  pcm += BIAS

  let exponent = 7
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; ) {
    exponent--
    expMask >>= 1
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f
  const muLaw = ~(sign | (exponent << 4) | mantissa)
  return muLaw & 0xff
}

function floatPcmToMuLawBuffer(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    const pcm16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767)
    out[i] = linearPcm16ToMuLawByte(pcm16)
  }
  return out
}

export async function ttsToMulaw8kBase64(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const speaker_id = process.env['DEFAULT_BAMBORAK_SPEAKER_ID']
  const ttsResult = await generateBamborakAudioFromText({
    text: trimmed,
    ...(speaker_id ? { speaker_id } : {}),
  })

  const audioFileBuffer = Buffer.from(ttsResult.audioBase64, 'base64')

  let audioData
  try {
    audioData = await decodeWav(audioFileBuffer)
  } catch (e) {
    throw new Error(
      `Bamborak TTS returned non-WAV audio; cannot convert to mulaw 8k. (${String(
        e,
      )})`,
    )
  }

  const mono = mixDownToMono(audioData.channelData)
  const resampled = resampleLinear(mono, audioData.sampleRate, 8000)
  const muLaw = floatPcmToMuLawBuffer(resampled)
  return muLaw.toString('base64')
}

export function clearTwilioPlayback(ws: WebSocket, streamSid: string) {
  // stoppt gepufferte Ausgabe (wichtig bei Barge-in)
  ws.send(JSON.stringify({ event: 'clear', streamSid }))
}

export function sendAudioToTwilio(
  ws: WebSocket,
  streamSid: string,
  mulaw8kBase64: string,
) {
  ws.send(
    JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: mulaw8kBase64 },
    }),
  )
}

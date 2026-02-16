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
export async function ttsToMulaw8kBase64(_text: string): Promise<string> {
  // TODO: Implementiere das passend zu deinem Setup.
  // Optionen:
  // - TTS liefert direkt mulaw 8k (best case)
  // - TTS liefert PCM/WAV/MP3 -> du konvertierst (z.B. via ffmpeg) zu mulaw 8k raw
  throw new Error(
    'ttsToMulaw8kBase64() ist noch nicht implementiert (TTS Service fehlt).',
  )
}

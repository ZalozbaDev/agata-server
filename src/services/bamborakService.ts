import axios, { AxiosRequestConfig } from 'axios'
import { visemeGeneratorService } from './visemeGenerator'

const configuredBaseUrl = process.env['BAMBORAK_API_BASE_URL']?.trim()

if (!configuredBaseUrl) {
  throw new Error('Missing BAMBORAK_API_BASE_URL environment variable')
}

let bamborak_api_base_url = configuredBaseUrl.endsWith('/')
  ? configuredBaseUrl.slice(0, -1)
  : configuredBaseUrl
bamborak_api_base_url = `${bamborak_api_base_url}/api`

export type BamborakSpeakerId = string | number

export interface BamborakAudioFromTextParams {
  text: string
  speaker_id?: BamborakSpeakerId
  format?: 'wav' | 'mp3'
  includeVisemes?: boolean
}

export interface BamborakAudioFromTextResult {
  audioBase64: string
  audioByteLength: number
  visemes: unknown
  text: string
  duration: number
  sampleRate: number
}

export interface BamborakSpeaker {
  id: string
  name: string
  language: string
}

const SPEAKER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export function normalizeBamborakSpeakers(payload: unknown): BamborakSpeaker[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { speakers?: unknown }).speakers)
      ? (payload as { speakers: unknown[] }).speakers
      : []

  const speakers: BamborakSpeaker[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const speaker = speakerFromUnknown(item)
    if (!speaker || seen.has(speaker.id)) continue
    seen.add(speaker.id)
    speakers.push(speaker)
  }
  return speakers
}

function speakerFromUnknown(item: unknown): BamborakSpeaker | null {
  if (typeof item === 'string') {
    const id = item.trim()
    if (!SPEAKER_ID_PATTERN.test(id)) return null
    return { id, name: id, language: '' }
  }
  if (!item || typeof item !== 'object') return null
  const record = item as { id?: unknown; name?: unknown; language?: unknown }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!SPEAKER_ID_PATTERN.test(id)) return null
  const name =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id
  const language =
    typeof record.language === 'string' ? record.language.trim() : ''
  return { id, name, language }
}

export async function fetchBamborakSpeakers(): Promise<BamborakSpeaker[]> {
  const response = await axios.get(`${bamborak_api_base_url}/fetch_speakers/`)
  return normalizeBamborakSpeakers(response.data)
}

export async function generateBamborakAudioFromText(
  params: BamborakAudioFromTextParams,
): Promise<BamborakAudioFromTextResult> {
  const { text, speaker_id, format = 'mp3', includeVisemes = true } = params

  const config: AxiosRequestConfig = {
    method: 'post',
    maxBodyLength: Infinity,
    url: `${bamborak_api_base_url}/tts/`,
    headers: {
      'Content-Type': 'application/json',
    },
    data: { text, speaker_id, format },
    responseType: 'arraybuffer',
  }

  const resp = await axios.request(config)
  const audioBuffer = Buffer.isBuffer(resp.data)
    ? resp.data
    : Buffer.from(resp.data)

  const estimatedDuration = text.length * 0.1 // Rough estimate: 100ms per character
  const visemeTimeline = includeVisemes
    ? visemeGeneratorService.generateVisemesFromText(text, estimatedDuration)
    : null

  return {
    audioBase64: audioBuffer.toString('base64'),
    audioByteLength: audioBuffer.length,
    visemes: visemeTimeline,
    text,
    duration: estimatedDuration,
    sampleRate: 44100,
  }
}

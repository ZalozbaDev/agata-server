import axios, { AxiosRequestConfig } from 'axios'
import { visemeGeneratorService } from './visemeGenerator'

let bamborak_api_base_url = process.env['BAMBORAK_API_BASE_URL']
if (!bamborak_api_base_url) {
  throw new Error('Missing BAMBORAK_API_BASE_URL environment variable')
}
bamborak_api_base_url = bamborak_api_base_url.endsWith('/')
  ? bamborak_api_base_url.slice(0, -1)
  : bamborak_api_base_url
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

export async function fetchBamborakSpeakers(): Promise<unknown> {
  const response = await axios.get(`${bamborak_api_base_url}/fetch_speakers/`)
  return response.data
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

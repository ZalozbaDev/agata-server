import axios, { AxiosRequestConfig } from 'axios'
import { visemeGeneratorService } from './visemeGenerator'

const BAMBORAK_API_BASE_URL = 'https://bamborakapi.mudrowak.de/api'

export type BamborakSpeakerId = string | number

export interface BamborakAudioFromTextParams {
  text: string
  speaker_id?: BamborakSpeakerId
  format?: 'wav' | 'mp3'
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
  const response = await axios.get(`${BAMBORAK_API_BASE_URL}/fetch_speakers/`)
  return response.data
}

export async function generateBamborakAudioFromText(
  params: BamborakAudioFromTextParams,
): Promise<BamborakAudioFromTextResult> {
  const { text, speaker_id, format } = params

  const config: AxiosRequestConfig = {
    method: 'post',
    maxBodyLength: Infinity,
    url: `${BAMBORAK_API_BASE_URL}/tts/`,
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
  const visemeTimeline = visemeGeneratorService.generateVisemesFromText(
    text,
    estimatedDuration,
  )

  return {
    audioBase64: audioBuffer.toString('base64'),
    audioByteLength: audioBuffer.length,
    visemes: visemeTimeline,
    text,
    duration: estimatedDuration,
    sampleRate: 44100,
  }
}

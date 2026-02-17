declare module 'node-vad' {
  export interface VadOptions {
    mode?: number
    audioFrequency?: number
    debounceTime?: number
  }

  export class Vad {
    constructor(mode?: number)
    processAudio(audio: Buffer, sampleRate: number): Promise<number>
  }
}

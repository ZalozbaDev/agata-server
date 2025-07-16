export interface Viseme {
  startTime: number
  endTime: number
  viseme: string
  intensity: number
}

export interface VisemeTimeline {
  duration: number
  visemes: Viseme[]
  sampleRate: number
}

export class VisemeGeneratorService {
  private readonly visemeMap: { [key: string]: string } = {
    // Phoneme to viseme mapping
    A: 'ah', // Open mouth
    E: 'eh', // Slightly open
    I: 'ee', // Wide smile
    O: 'oh', // Rounded lips
    U: 'oo', // Puckered lips
    F: 'ff', // Lower lip to upper teeth
    V: 'ff', // Similar to F
    M: 'mm', // Closed lips
    B: 'mm', // Closed lips
    P: 'mm', // Closed lips
    L: 'll', // Tongue to roof
    R: 'rr', // Tongue curled
    S: 'ss', // Teeth together
    Z: 'ss', // Similar to S
    T: 'th', // Tongue to teeth
    D: 'th', // Similar to T
    N: 'nn', // Tongue to roof
    G: 'gg', // Back of throat
    K: 'gg', // Similar to G
    H: 'hh', // Breath
    W: 'ww', // Rounded lips
    Y: 'yy', // Tongue to roof
    X: 'rest', // Rest position
  }

  // Generate visemes from text (simplified approach)
  generateVisemesFromText(text: string, duration: number): VisemeTimeline {
    console.log('Generating visemes from text:', text)

    const visemes: Viseme[] = []
    const words = text.split(' ').filter(word => word.length > 0)

    if (words.length === 0) {
      // Return rest viseme for empty text
      return {
        duration,
        visemes: [
          {
            startTime: 0,
            endTime: duration,
            viseme: 'rest',
            intensity: 0.1,
          },
        ],
        sampleRate: 44100,
      }
    }

    const wordDuration = duration / words.length

    words.forEach((word, index) => {
      const startTime = index * wordDuration
      const endTime = (index + 1) * wordDuration

      // Generate visemes for each word
      const wordVisemes = this.generateVisemesForWord(word, startTime, endTime)
      visemes.push(...wordVisemes)
    })

    const timeline: VisemeTimeline = {
      duration,
      visemes,
      sampleRate: 44100,
    }

    console.log(
      `Generated ${visemes.length} visemes for ${duration.toFixed(2)}s text`
    )
    return timeline
  }

  // Generate visemes from audio buffer (placeholder for future implementation)
  async generateVisemesFromAudio(
    _audioBuffer: Buffer
  ): Promise<VisemeTimeline> {
    console.log(
      'Audio-based viseme generation not yet implemented, using fallback'
    )

    // For now, return a simple timeline with rest visemes
    const duration = 3.0 // Assume 3 seconds
    return {
      duration,
      visemes: [
        {
          startTime: 0,
          endTime: duration,
          viseme: 'rest',
          intensity: 0.1,
        },
      ],
      sampleRate: 44100,
    }
  }

  private generateVisemesForWord(
    word: string,
    startTime: number,
    endTime: number
  ): Viseme[] {
    const visemes: Viseme[] = []
    const phonemes = this.textToPhonemes(word)
    const phonemeDuration = (endTime - startTime) / Math.max(phonemes.length, 1)

    phonemes.forEach((phoneme, index) => {
      const phonemeStart = startTime + index * phonemeDuration
      const phonemeEnd = startTime + (index + 1) * phonemeDuration

      visemes.push({
        startTime: phonemeStart,
        endTime: phonemeEnd,
        viseme: this.visemeMap[phoneme] || 'rest',
        intensity: 0.7,
      })
    })

    return visemes
  }

  private textToPhonemes(text: string): string[] {
    const phonemes: string[] = []

    for (const char of text.toLowerCase()) {
      if ('aeiou'.includes(char)) {
        phonemes.push(char.toUpperCase())
      } else if ('bcdfghjklmnpqrstvwxyz'.includes(char)) {
        phonemes.push(char.toUpperCase())
      } else {
        phonemes.push('X') // Rest
      }
    }

    return phonemes
  }

  // Get available viseme types
  getAvailableVisemes(): string[] {
    return [
      'rest',
      'ah',
      'eh',
      'ee',
      'oh',
      'oo',
      'ff',
      'mm',
      'll',
      'rr',
      'ss',
      'th',
      'gg',
      'hh',
      'ww',
      'yy',
    ]
  }
}

export const visemeGeneratorService = new VisemeGeneratorService()

export type QueryLanguage = 'de' | 'hsb'

const HSB_CHARS = new Set(['ł', 'ń', 'ś', 'ź', 'ć', 'ž'])

const HSB_MARKERS = [
  'wón',
  'wonje',
  'chcy',
  'hdy',
  'nětko',
  'wob',
  'dźě',
  'serbski',
  'serbšćina',
  'hornjoserbšćina',
  'rěč',
  'wutrob',
  'wobsah',
  'přichod',
  'přeco',
]

export function detectQueryLanguage(text: string): QueryLanguage {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return 'de'

  if ([...normalized].some(char => HSB_CHARS.has(char))) {
    return 'hsb'
  }

  if (HSB_MARKERS.some(marker => normalized.includes(marker))) {
    return 'hsb'
  }

  return 'de'
}

import type {
  AnswerLanguage,
  LlmSourceContent,
  OllamaAnswer,
  Source,
} from '../types/source'
import type { DuckDuckGoResult } from './duckDuckGoClient'

export type RawRagSource = {
  source_type: string
  source_url: string
  title: string
  source_id?: string | null
  page?: number | null
  published_at?: string | null
  publishedAt?: string | null
  section?: string | null
  score?: number | null
}

const SOURCE_REF_RE = /\[\[(S\d+)\]\]|\[(S\d+)\]/g
const PAGE_IN_TITLE_RE = /(?:^|[|\-–—\s])(?:page|seite|strona)\s*(\d+)\b/i

export const OLLAMA_ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    language: {
      type: 'string',
      enum: ['hsb', 'de'],
    },
    title: {
      type: 'string',
    },
    answer: {
      type: 'string',
    },
    sources_used: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
  required: ['language', 'title', 'answer', 'sources_used'],
  additionalProperties: false,
} as const

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function parsePage(meta: RawRagSource | undefined, title: string): number | null {
  if (typeof meta?.page === 'number' && Number.isFinite(meta.page) && meta.page > 0) {
    return meta.page
  }
  const match = title.match(PAGE_IN_TITLE_RE)
  if (match?.[1]) return Number(match[1])
  return null
}

function parsePublishedAt(meta: RawRagSource | undefined): string | null {
  const value = meta?.published_at ?? meta?.publishedAt
  const trimmed = String(value ?? '').trim()
  return trimmed || null
}

function parseScore(
  meta: RawRagSource | undefined,
  scores: number[] | undefined,
  index: number,
): number | null {
  const fromMeta = meta?.score
  if (typeof fromMeta === 'number' && Number.isFinite(fromMeta)) {
    return fromMeta
  }
  const fromList = scores?.[index]
  if (typeof fromList === 'number' && Number.isFinite(fromList)) {
    return fromList
  }
  return null
}

/**
 * Pair RAG contexts with RAG source metadata by index.
 * Everything from the RAG endpoint stays type "rag".
 */
export function normalizeRagSources(
  contexts: string[],
  ragSources: RawRagSource[],
  scores?: number[],
): Omit<Source, 'id'>[] {
  const count = Math.max(contexts.length, ragSources.length)
  const normalized: Omit<Source, 'id'>[] = []

  for (let i = 0; i < count; i++) {
    const meta = ragSources[i]
    const snippet = String(contexts[i] ?? '').trim()
    const title = String(meta?.title ?? '').trim() || `Dokument ${i + 1}`
    const documentUrl = String(meta?.source_url ?? '').trim() || null
    const documentId = String(meta?.source_id ?? '').trim() || null
    const page = parsePage(meta, title)
    const publishedAt = parsePublishedAt(meta)
    const section = String(meta?.section ?? '').trim() || null
    const score = parseScore(meta, scores, i)

    if (!snippet && !meta) continue

    const domain = documentUrl ? domainFromUrl(documentUrl) : null

    normalized.push({
      type: 'rag',
      title,
      documentId,
      documentUrl,
      page,
      section,
      publishedAt,
      score,
      snippet: snippet || null,
      ...(documentUrl
        ? {
            url: documentUrl,
            domain,
          }
        : {}),
    })
  }

  return normalized
}

export function normalizeWebSources(
  results: DuckDuckGoResult[],
): Omit<Source, 'id'>[] {
  return results.map(result => ({
    type: 'web' as const,
    title: result.title,
    url: result.url,
    domain: domainFromUrl(result.url),
    publishedAt: null,
    imageUrl: null,
    snippet: result.snippet || null,
  }))
}

export function assignSourceIds(sources: Omit<Source, 'id'>[]): Source[] {
  return sources.map((source, index) => ({
    ...source,
    id: `S${index + 1}`,
  }))
}

export function toLlmSourceContent(sources: Source[]): LlmSourceContent[] {
  return sources.map(source => ({
    id: source.id,
    type: source.type,
    title: source.title,
    ...(source.type === 'rag' && source.page != null
      ? { page: source.page }
      : {}),
    content: String(source.snippet ?? '').trim(),
  }))
}

export function formatSourcesForPrompt(sources: LlmSourceContent[]): string {
  if (sources.length === 0) return '(keine Quellen)'

  return sources
    .map(source => {
      const lines = [
        `[${source.id}]`,
        `TYPE: ${source.type}`,
        `TITLE: ${source.title}`,
      ]
      if (source.page != null) {
        lines.push(`PAGE: ${source.page}`)
      }
      lines.push('CONTENT:')
      lines.push(source.content || '(kein Inhalt)')
      return lines.join('\n')
    })
    .join('\n\n')
}

export function buildResearchUserPrompt(params: {
  outputLanguage: AnswerLanguage
  originalQuestion: string
  germanTranslation: string | null
  sources: LlmSourceContent[]
  mode?: 'rag' | 'web'
}): string {
  const parts = [
    `OUTPUT_LANGUAGE: ${params.outputLanguage}`,
    '',
    'ORIGINAL_QUESTION:',
    params.originalQuestion.trim(),
  ]

  if (params.germanTranslation) {
    parts.push('', 'GERMAN_TRANSLATION:', params.germanTranslation.trim())
  }

  if (params.mode === 'rag') {
    parts.push(
      '',
      'SOURCE_PRIORITY: Prefer TYPE: rag. If RAG does not answer the question, you MUST use TYPE: web. Do not claim missing information while web sources can answer.',
    )
  } else if (params.mode === 'web') {
    parts.push(
      '',
      'SOURCE_PRIORITY: Answer from TYPE: web sources. Do not claim missing information if these sources contain an answer.',
    )
  }

  parts.push('', 'AVAILABLE_SOURCES:', '', formatSourcesForPrompt(params.sources))

  return parts.join('\n')
}

function sourceIdFromMatch(match: RegExpMatchArray): string | null {
  return match[1] ?? match[2] ?? null
}

export function extractSourceRefsFromAnswer(answer: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const match of answer.matchAll(SOURCE_REF_RE)) {
    const id = sourceIdFromMatch(match)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return ids
}

export function stripInvalidSourceRefs(
  answer: string,
  validIds: Set<string>,
): string {
  // Accept [[S1]] and [S1]; normalize valid refs to [[S1]] for the frontend.
  return answer.replace(SOURCE_REF_RE, (_full, doubleId?: string, singleId?: string) => {
    const id = doubleId ?? singleId
    if (!id || !validIds.has(id)) return ''
    return `[[${id}]]`
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

function readStringArrayField(
  record: Record<string, unknown>,
  ...keys: string[]
): string[] | null {
  for (const key of keys) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    if (!value.every(item => typeof item === 'string')) continue
    return value
  }
  return null
}

export function parseOllamaAnswerJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Ollama returned empty content')
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    // Models sometimes wrap JSON in markdown fences
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim())
    }

    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }

    throw new Error('Ollama response is not valid JSON')
  }
}

export function validateOllamaAnswer(
  raw: unknown,
  availableSources: Source[],
): OllamaAnswer {
  const record = asRecord(raw)
  if (!record) {
    throw new Error('Ollama JSON must be an object')
  }

  const languageRaw = readStringField(record, 'language')
  if (languageRaw !== 'hsb' && languageRaw !== 'de') {
    throw new Error('Ollama language must be "hsb" or "de"')
  }

  const title = readStringField(record, 'title')
  if (title == null) {
    throw new Error('Ollama title must be a string')
  }

  const answer = readStringField(record, 'answer')
  if (answer == null) {
    throw new Error('Ollama answer must be a string')
  }
  // An empty answer is a failed generation, not a valid response. Catching it
  // here keeps a blank bubble out of the UI and out of the database.
  if (!answer.trim()) {
    throw new Error('Ollama answer must not be empty')
  }

  const sourcesUsedRaw = readStringArrayField(
    record,
    'sources_used',
    'sourcesUsed',
  )
  if (sourcesUsedRaw == null) {
    throw new Error('Ollama sources_used must be a string array')
  }

  const availableIds = new Set(availableSources.map(source => source.id))
  const cleanedAnswer = stripInvalidSourceRefs(answer, availableIds)
  const refsInText = extractSourceRefsFromAnswer(cleanedAnswer)

  // Text references are authoritative for the final source list.
  const sourcesUsed =
    refsInText.length > 0
      ? refsInText
      : [
          ...new Set(
            sourcesUsedRaw.filter(id => availableIds.has(id)),
          ),
        ]

  return {
    language: languageRaw,
    title: title.trim() || 'Antwort',
    answer: cleanedAnswer.trim(),
    sourcesUsed,
  }
}

export function pickSourcesByIds(
  availableSources: Source[],
  ids: string[],
): Source[] {
  const byId = new Map(availableSources.map(source => [source.id, source]))
  const picked: Source[] = []
  const seen = new Set<string>()

  for (const id of ids) {
    if (seen.has(id)) continue
    const source = byId.get(id)
    if (!source) continue
    seen.add(id)
    picked.push(source)
  }

  return picked
}

export function countSourcesByType(sources: Source[]): {
  ragCount: number
  webCount: number
} {
  let ragCount = 0
  let webCount = 0
  for (const source of sources) {
    if (source.type === 'rag') ragCount += 1
    else if (source.type === 'web') webCount += 1
  }
  return { ragCount, webCount }
}

export function noSourcesMessage(language: AnswerLanguage): {
  title: string
  answer: string
} {
  if (language === 'hsb') {
    return {
      title: 'Žane dosć žórłow',
      answer:
        'Bohužel njejsym namakał dosć žórłow, zo bych na twoje prašenje społnosći wotmołwił. Prošu spytaj prašenje hinak formulować abo pozdźišo hišće raz.',
    }
  }

  return {
    title: 'Keine ausreichenden Quellen',
    answer:
      'Leider habe ich keine ausreichenden Quellen gefunden, um deine Frage zuverlässig zu beantworten. Bitte formuliere die Frage anders oder versuche es später erneut.',
  }
}

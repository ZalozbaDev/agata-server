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
}

const SOURCE_REF_RE = /\[\[(S\d+)\]\]/g

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
    sourcesUsed: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
  required: ['language', 'title', 'answer', 'sourcesUsed'],
  additionalProperties: false,
} as const

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function isWebSourceType(sourceType: string): boolean {
  return sourceType.trim().toLowerCase() === 'web'
}

/**
 * Pair RAG contexts with RAG source metadata by index.
 * Missing metadata fields (documentId, page, section) stay null.
 */
export function normalizeRagSources(
  contexts: string[],
  ragSources: RawRagSource[],
): Omit<Source, 'id'>[] {
  const count = Math.max(contexts.length, ragSources.length)
  const normalized: Omit<Source, 'id'>[] = []

  for (let i = 0; i < count; i++) {
    const meta = ragSources[i]
    const snippet = String(contexts[i] ?? '').trim()
    const title = String(meta?.title ?? '').trim() || `Dokument ${i + 1}`
    const documentUrl = String(meta?.source_url ?? '').trim() || null

    if (!snippet && !meta) continue

    // Upstream may label web-like hits inside RAG; treat explicit "web" as web.
    if (meta && isWebSourceType(meta.source_type)) {
      const url = documentUrl
      normalized.push({
        type: 'web',
        title,
        url,
        domain: url ? domainFromUrl(url) : null,
        publishedAt: null,
        imageUrl: null,
        snippet: snippet || null,
      })
      continue
    }

    normalized.push({
      type: 'rag',
      title,
      documentId: null,
      documentUrl,
      page: null,
      section: null,
      snippet: snippet || null,
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

  parts.push('', 'AVAILABLE_SOURCES:', '', formatSourcesForPrompt(params.sources))

  return parts.join('\n')
}

export function extractSourceRefsFromAnswer(answer: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const match of answer.matchAll(SOURCE_REF_RE)) {
    const id = match[1]
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
  return answer.replace(SOURCE_REF_RE, (full, id: string) =>
    validIds.has(id) ? full : '',
  )
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

  const sourcesUsedRaw = readStringArrayField(
    record,
    'sourcesUsed',
    'sources_used',
  )
  if (sourcesUsedRaw == null) {
    throw new Error('Ollama sourcesUsed must be a string array')
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

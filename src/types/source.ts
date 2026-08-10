export type SourceType = 'web' | 'rag'
export type AnswerLanguage = 'hsb' | 'de'

/**
 * Unified source model for RAG + web results.
 *
 * Currently available from upstream:
 * - RAG: title, source_url (mapped to documentUrl), context text (snippet)
 * - Web (DuckDuckGo): title, url, snippet
 *
 * Not yet available (kept nullable for later):
 * - RAG: documentId, page, section
 * - Web: publishedAt, imageUrl
 */
export type Source = {
  id: string
  type: SourceType
  title: string

  // Web
  url?: string | null
  domain?: string | null
  publishedAt?: string | null
  imageUrl?: string | null

  // RAG
  documentId?: string | null
  documentUrl?: string | null
  page?: number | null
  section?: string | null

  // Both
  snippet?: string | null
}

/** Content passed to the LLM — no URLs / internal IDs */
export type LlmSourceContent = {
  id: string
  type: SourceType
  title: string
  page?: number | null
  content: string
}

export type OllamaAnswer = {
  language: AnswerLanguage
  title: string
  answer: string
  sourcesUsed: string[]
}

export type ChatAnswerResponse = {
  language: AnswerLanguage
  title: string
  answer: string
  sources: Source[]
}

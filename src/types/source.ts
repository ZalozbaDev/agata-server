export type SourceType = 'web' | 'rag'
export type AnswerLanguage = 'hsb' | 'de'

/**
 * Unified source model for RAG + web results.
 *
 * RAG from /ask may include: title, source_url, source_id, page, published_at, section, snippet
 * Web (DuckDuckGo): title, url, snippet
 *
 * Not yet available:
 * - Web: publishedAt, imageUrl (unless later enriched)
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
  /** Retrieval score from the RAG server (when provided) */
  score?: number | null

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

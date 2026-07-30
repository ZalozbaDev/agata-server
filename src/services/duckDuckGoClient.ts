import { DDGS } from '@phukon/duckduckgo-search'
import { chatTimingLog, summarizeText } from '../utils/chatTimingLogger'

export type DuckDuckGoResult = {
  title: string
  url: string
  snippet: string
}

/** DDG results when RAG also returned usable contexts */
export const DUCKDUCKGO_WITH_RAG_COUNT = 5
/** DDG results when RAG returned nothing usable */
export const DUCKDUCKGO_WITHOUT_RAG_COUNT = 10
const MAX_SNIPPET_CHARS = 600

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function cleanSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_SNIPPET_CHARS) return normalized
  return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`
}

function normalizeResults(
  rawResults: Array<{ title?: string; href?: string; body?: string }>,
  maxResults: number,
): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = []
  const seenUrls = new Set<string>()

  for (const item of rawResults) {
    if (results.length >= maxResults) break

    const title = String(item.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const url = String(item.href ?? '').trim()
    const snippet = cleanSnippet(String(item.body ?? ''))

    if (!title || !isHttpUrl(url) || seenUrls.has(url)) continue
    if (url.includes('duckduckgo.com')) continue

    seenUrls.add(url)
    results.push({ title, url, snippet })
  }

  return results
}

export function formatDuckDuckGoContexts(results: DuckDuckGoResult[]): string[] {
  return results.map(result => {
    const parts = [`Titel: ${result.title}`, `URL: ${result.url}`]
    if (result.snippet) {
      parts.push(`Inhalt: ${result.snippet}`)
    }
    return parts.join('\n')
  })
}

export async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<DuckDuckGoResult[]> {
  const question = query.trim()
  if (!question) return []

  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()

  chatTimingLog(`${timestamp} | duckduckgo request`, {
    queryChars: question.length,
    queryPreview: summarizeText(question),
    maxResults,
  })

  try {
    const ddgs = new DDGS()
    const rawResults = await ddgs.text({
      keywords: question,
      maxResults: Math.max(maxResults * 2, maxResults),
      region: 'de-de',
      safesearch: 'moderate',
    })

    const results = normalizeResults(
      Array.isArray(rawResults) ? rawResults : [],
      maxResults,
    )
    const durationMs = Date.now() - startedAt

    chatTimingLog(
      `${new Date().toISOString()} | duckduckgo response | ${durationMs}ms`,
      {
        resultCount: results.length,
        results: results.map(result => ({
          title: result.title,
          url: result.url,
          snippetPreview: summarizeText(result.snippet, 200),
        })),
      },
    )

    return results
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)

    chatTimingLog(
      `${new Date().toISOString()} | duckduckgo error | ${durationMs}ms`,
      { error: message },
    )
    console.error('DuckDuckGo search failed:', message)
    return []
  }
}

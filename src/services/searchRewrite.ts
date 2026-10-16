import { completeChat } from './llmProvider'
import { chatTimingLog } from '../utils/chatTimingLogger'

export type SearchRewriteLanguage = 'de' | 'hsb' | 'dsb'

export type RewriteTurn = {
  role: 'user' | 'assistant'
  content: string
}

const ANSWER_EXCERPT_CHARS = 280
const MAX_REWRITE_CHARS = 240

const LANGUAGE_NAME: Record<SearchRewriteLanguage, string> = {
  de: 'Deutsch',
  hsb: 'Obersorbisch',
  dsb: 'Niedersorbisch',
}

function excerpt(text: string): string {
  const cleaned = text
    .replace(/\[\[S\d+\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= ANSWER_EXCERPT_CHARS) return cleaned
  const slice = cleaned.slice(0, ANSWER_EXCERPT_CHARS)
  const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
  return (stop > 80 ? slice.slice(0, stop + 1) : slice).trim()
}

/**
 * Prompt for a follow-up. Returns null when there is no previous user turn,
 * so the first question of a chat is searched as written.
 */
export function buildSearchRewritePrompt(params: {
  question: string
  history: RewriteTurn[]
  language: SearchRewriteLanguage
}): string | null {
  const users = params.history
    .filter(item => item.role === 'user')
    .map(item => item.content.trim())
    .filter(Boolean)
    .slice(-2)
  if (users.length === 0) return null

  const previousAnswer = [...params.history]
    .reverse()
    .map(item => (item.role === 'assistant' ? excerpt(item.content) : ''))
    .find(Boolean)

  const lines = [
    'Formuliere die letzte Frage als eigenständige Suchanfrage.',
    'Löse Pronomen wie "das", "so", "es" mit dem Thema aus dem Verlauf auf.',
    'Ist die letzte Frage ein neues Thema, gib sie unverändert zurück.',
    'Kein Erklärungstext.',
    `Schreibe die Suchanfrage auf ${LANGUAGE_NAME[params.language]}.`,
    'Genau eine Zeile.',
    '',
    'Verlauf:',
    ...users.map(text => `User: ${text}`),
  ]
  if (previousAnswer) {
    lines.push(`Assistant: ${previousAnswer}`)
  }
  lines.push('', 'Letzte Frage:', params.question.trim())
  return lines.join('\n')
}

/** Keep a single short question. Empty or unusable model output becomes null. */
export function cleanSearchRewrite(raw: string): string | null {
  const line = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean)
  if (!line) return null

  const stripped = line
    .replace(/^(suchanfrage|suchfrage|frage)\s*:\s*/i, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^["„“«»']+|["„“«»']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped || !/\p{L}/u.test(stripped)) return null
  if (stripped.length <= MAX_REWRITE_CHARS) return stripped

  const cut = stripped.slice(0, MAX_REWRITE_CHARS)
  const mark = Math.max(cut.lastIndexOf('?'), cut.lastIndexOf('.'))
  const shortened = (mark >= 20 ? cut.slice(0, mark + 1) : cut).trim()
  return shortened || null
}

export async function rewriteSearchQuery(params: {
  question: string
  history: RewriteTurn[]
  language: SearchRewriteLanguage
}): Promise<string | null> {
  const prompt = buildSearchRewritePrompt(params)
  if (!prompt) return null

  try {
    const raw = await completeChat(
      [
        {
          role: 'system',
          content:
            'Du formulierst Suchanfragen. Antworte mit genau einer Zeile und ohne Erklärung.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    )
    return cleanSearchRewrite(raw)
  } catch (error) {
    chatTimingLog('search query rewrite failed', {
      reason: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

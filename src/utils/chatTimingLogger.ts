export type ChatLogMode = 'none' | 'rag' | 'all'

function truncate(text: string, max = 400): string {
  const normalized = text.trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}… [${normalized.length} chars]`
}

/**
 * Chat pipeline log mode from env.
 *
 * - `none` — silent (default)
 * - `rag`  — compact question / persona / RAG hits / answer
 * - `all`  — full timing + provider logs (and the compact RAG summary)
 *
 * Backward compatible: `CHAT_TIMING_ENABLED=true` maps to `all`.
 */
export function getChatLogMode(): ChatLogMode {
  const raw = process.env['CHAT_LOG_MODE']?.trim().toLowerCase()
  if (raw === 'none' || raw === 'off' || raw === 'false' || raw === '0') {
    return 'none'
  }
  if (raw === 'rag') return 'rag'
  if (raw === 'all' || raw === 'true' || raw === '1') return 'all'

  if (process.env['CHAT_TIMING_ENABLED']?.trim().toLowerCase() === 'true') {
    return 'all'
  }

  return 'none'
}

export function isChatTimingEnabled(): boolean {
  return getChatLogMode() === 'all'
}

export function isRagChatLogEnabled(): boolean {
  const mode = getChatLogMode()
  return mode === 'rag' || mode === 'all'
}

export function chatTimingLog(
  message: string,
  payload?: Record<string, unknown>,
): void {
  if (!isChatTimingEnabled()) return

  if (payload) {
    console.log(`[chat-timing] ${message}`, payload)
  } else {
    console.log(`[chat-timing] ${message}`)
  }
}

export function summarizeText(text: string, max = 400): string {
  return truncate(text, max)
}

/** Turn a retrieval score into a readable match % (relative to the best hit). */
export function formatMatchPercent(
  score: number | null | undefined,
  maxScore: number | null | undefined,
): string {
  if (score == null || !Number.isFinite(score)) return '—'

  const max =
    maxScore != null && Number.isFinite(maxScore) && maxScore > 0
      ? maxScore
      : null

  if (max == null) {
    return score.toFixed(3)
  }

  return `${Math.round((score / max) * 100)}%`
}

export type RagHitLogItem = {
  title: string
  score?: number | null
  page?: number | null
  snippet?: string | null
}

export type CompactChatLogInput = {
  personaId: string
  question: string
  ragHits: RagHitLogItem[]
  /** Compact view of what the LLM actually received as sources */
  sentToAi: Array<{
    id: string
    type: string
    title: string
    snippetPreview: string
  }>
  answer: string
  sourceStrategy?: string
}

/**
 * One compact, readable block per chat turn (for CHAT_LOG_MODE=rag|all).
 */
export function logCompactChatTurn(input: CompactChatLogInput): void {
  if (!isRagChatLogEnabled()) return

  const maxScore = input.ragHits.reduce<number | null>((best, hit) => {
    if (hit.score == null || !Number.isFinite(hit.score)) return best
    if (best == null || hit.score > best) return hit.score
    return best
  }, null)

  const lines: string[] = [
    '──────── chat ────────',
    `persona:  ${input.personaId}`,
    `question: ${truncate(input.question, 240)}`,
  ]

  if (input.ragHits.length === 0) {
    lines.push('RAG:      (no hits)')
  } else {
    lines.push(`RAG top ${input.ragHits.length}:`)
    input.ragHits.forEach((hit, index) => {
      const pct = formatMatchPercent(hit.score, maxScore)
      const page =
        hit.page != null && Number.isFinite(hit.page) ? ` p.${hit.page}` : ''
      const title = truncate(hit.title || '(untitled)', 80)
      lines.push(`  ${index + 1}. ${pct.padStart(4)}  ${title}${page}`)
      const preview = truncate(String(hit.snippet ?? '').trim(), 120)
      if (preview) {
        lines.push(`         "${preview}"`)
      }
    })
  }

  if (input.sentToAi.length === 0) {
    lines.push('→ AI:     (no sources)')
  } else {
    lines.push(`→ AI (${input.sentToAi.length}):`)
    for (const source of input.sentToAi) {
      lines.push(
        `  [${source.id}] ${source.type}  ${truncate(source.title, 70)}`,
      )
      if (source.snippetPreview) {
        lines.push(`         "${source.snippetPreview}"`)
      }
    }
  }

  if (input.sourceStrategy) {
    lines.push(`strategy: ${input.sourceStrategy}`)
  }
  lines.push(`answer:   ${truncate(input.answer, 400)}`)
  lines.push('──────────────────────')

  console.log(lines.join('\n'))
}

export class ChatTimingLogger {
  private readonly startedAt = Date.now()
  private lastStepAt = this.startedAt
  private readonly requestId: string

  constructor(label = 'chat') {
    this.requestId = `${label}-${this.startedAt}`
  }

  step(step: string, payload?: Record<string, unknown>): void {
    if (!isChatTimingEnabled()) return

    const now = Date.now()
    const sinceLastMs = now - this.lastStepAt
    const totalMs = now - this.startedAt
    const timestamp = new Date(now).toISOString()

    chatTimingLog(
      `${timestamp} | ${this.requestId} | ${step} | +${sinceLastMs}ms | total=${totalMs}ms`,
      payload,
    )

    this.lastStepAt = now
  }

  done(summary: Record<string, unknown>): void {
    if (!isChatTimingEnabled()) return

    const now = Date.now()
    const sinceLastMs = now - this.lastStepAt
    const totalMs = now - this.startedAt
    const timestamp = new Date(now).toISOString()

    chatTimingLog(
      `${timestamp} | ${this.requestId} | done | +${sinceLastMs}ms | total=${totalMs}ms`,
      summary,
    )
  }
}

export async function timedStep<T>(
  logger: ChatTimingLogger,
  step: string,
  fn: () => Promise<T>,
  payload?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const result = await fn()
  logger.step(step, payload ? payload(result) : undefined)
  return result
}

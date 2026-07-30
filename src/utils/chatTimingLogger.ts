function truncate(text: string, max = 400): string {
  const normalized = text.trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}… [${normalized.length} chars]`
}

export function isChatTimingEnabled(): boolean {
  return process.env['CHAT_TIMING_ENABLED']?.trim().toLowerCase() === 'true'
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

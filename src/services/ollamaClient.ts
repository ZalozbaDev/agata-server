export type LlmProvider = 'openai' | 'ollama'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatCompletionOptions = {
  /** Ollama `format` / JSON schema for structured outputs */
  format?: unknown
  temperature?: number
}

export function getLlmProvider(): LlmProvider {
  const provider = process.env['LLM_CHAT_BACKEND']?.trim().toLowerCase()
  return provider === 'ollama' ? 'ollama' : 'openai'
}

export function getOllamaUrl(): string {
  const url = process.env['LLM_CHAT_ENDPOINT']?.trim()
  if (!url) {
    throw new Error('LLM_CHAT_ENDPOINT is missing')
  }
  return url.replace(/\/$/, '')
}

export function getOllamaChatModel(): string {
  return process.env['LLM_CHAT_MODEL']?.trim() || 'qwen3.5:4b'
}

export function getOllamaTimeoutMs(): number {
  return Number(process.env['OLLAMA_TIMEOUT_SECONDS'] ?? 60) * 1000
}

export function getChatTemperature(): number {
  const raw = Number(process.env['LLM_CHAT_TEMPERATURE'])
  return Number.isFinite(raw) ? raw : 0.2
}

function getOllamaApiKey(): string | undefined {
  const key = process.env['LLM_CHAT_API_KEY']?.trim()
  return key || undefined
}

type OllamaChatResponse = {
  message?: {
    content?: string
  }
}

export async function completeOllamaChat(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), getOllamaTimeoutMs())

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const apiKey = getOllamaApiKey()
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const body: Record<string, unknown> = {
      model: getOllamaChatModel(),
      messages,
      think: false,
      stream: false,
      options: {
        temperature: options?.temperature ?? getChatTemperature(),
      },
    }
    if (options?.format !== undefined) {
      body['format'] = options.format
    }

    const response = await fetch(`${getOllamaUrl()}/api/chat`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `Ollama /api/chat error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
      )
    }

    const data = (await response.json()) as OllamaChatResponse
    return String(data.message?.content ?? '').trim()
  } finally {
    clearTimeout(timeout)
  }
}

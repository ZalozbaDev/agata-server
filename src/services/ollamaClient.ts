export type LlmProvider = 'openai' | 'ollama'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function getLlmProvider(): LlmProvider {
  const provider = process.env['LLM_PROVIDER']?.trim().toLowerCase()
  return provider === 'ollama' ? 'ollama' : 'openai'
}

export function getOllamaUrl(): string {
  const url = process.env['OLLAMA_URL']?.trim()
  if (!url) {
    throw new Error('OLLAMA_URL is missing')
  }
  return url.replace(/\/$/, '')
}

export function getOllamaChatModel(): string {
  return process.env['OLLAMA_CHAT_MODEL']?.trim() || 'qwen3.5:4b'
}

export function getOllamaTimeoutMs(): number {
  return Number(process.env['OLLAMA_TIMEOUT_SECONDS'] ?? 60) * 1000
}

type OllamaChatResponse = {
  message?: {
    content?: string
  }
}

export async function completeOllamaChat(
  messages: ChatMessage[],
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), getOllamaTimeoutMs())

  try {
    const response = await fetch(`${getOllamaUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: getOllamaChatModel(),
        messages,
        think: false,
        stream: false,
      }),
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

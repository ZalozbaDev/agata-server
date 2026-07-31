import { chatTimingLog, summarizeText } from '../utils/chatTimingLogger'

type SotraDirection = 'hsb_de' | 'de_hsb'

function directionLabel(direction: SotraDirection): string {
  return direction === 'hsb_de' ? 'HSB→DE' : 'DE→HSB'
}

function isTruthyEnv(value?: string): boolean {
  return value?.trim().toLowerCase() === 'true'
}

async function translate(
  text: string,
  direction: SotraDirection,
): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return text

  const baseUrl = process.env['SOTRA_URL']?.trim()
  const apiKey = process.env['SOTRA_API_KEY']?.trim()
  const useLocalBackend = isTruthyEnv(process.env['SOTRA_LOCAL_BACKEND'])

  if (!baseUrl) {
    throw new Error('SOTRA_URL ist nicht gesetzt')
  }
  if (!apiKey) {
    throw new Error('SOTRA_API_KEY ist nicht gesetzt')
  }

  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()

  chatTimingLog(`${timestamp} | sotra request | ${directionLabel(direction)}`, {
    inputChars: trimmed.length,
    inputPreview: summarizeText(trimmed),
  })

  const timeoutMs = Number(process.env['SOTRA_TIMEOUT_SECONDS'] ?? 30) * 1000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const requestUrl = useLocalBackend
    ? new URL('/translate', baseUrl)
    : new URL(baseUrl.replace(/\/$/, ''))

  if (!useLocalBackend) {
    requestUrl.searchParams.set('uri', '/ws/translate/')
    requestUrl.searchParams.set('api_key', apiKey ?? '')
    requestUrl.searchParams.set('_version', '2.2.01')
  }

  const sourceLanguage = direction === 'hsb_de' ? 'hsb' : 'de'
  const targetLanguage = direction === 'hsb_de' ? 'de' : 'hsb'

  try {
    const response = await fetch(requestUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(
        useLocalBackend
          ? {
              text: trimmed,
              source_language: sourceLanguage,
              target_language: targetLanguage,
            }
          : {
              direction,
              warnings: false,
              text: trimmed,
            },
      ),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `Sotra Fehler: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
      )
    }

    const responseText = await response.text()
    let output = responseText.trim()

    try {
      const data = JSON.parse(responseText) as {
        output_html?: string
        output?: string
        translated_text?: string
        text?: string
      }
      output = String(
        data.output_html ??
          data.output ??
          data.translated_text ??
          data.text ??
          responseText,
      ).trim()
    } catch {
      // Keep plain-text responses as-is.
    }

    const durationMs = Date.now() - startedAt
    const finishedAt = new Date().toISOString()

    chatTimingLog(
      `${finishedAt} | sotra response | ${directionLabel(direction)} | ${durationMs}ms`,
      {
        outputChars: output.length,
        outputPreview: summarizeText(output),
      },
    )

    return output
  } finally {
    clearTimeout(timeout)
  }
}

export const sotraClient = {
  translateHsbToDe(text: string): Promise<string> {
    return translate(text, 'hsb_de')
  },

  translateDeToHsb(text: string): Promise<string> {
    return translate(text, 'de_hsb')
  },
}

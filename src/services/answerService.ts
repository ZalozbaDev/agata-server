import {
  completeChat,
  type ChatMessage,
} from './llmProvider'

type PromptMode = 'rag' | 'web' | 'general'

export type AnswerSource = {
  source_type: string
  source_url: string
  title: string
}

export type AnswerResult = {
  answer: string
  sources: AnswerSource[]
  sourceStrategy: 'rag' | 'web' | 'general'
}

const PHONE_CALL_SYSTEM_ADDON =
  '\n\nWICHTIG (Telefonat): Halte die Antwort extrem kurz (max. 2 kurze Sätze). ' +
  'Keine Listen. Keine langen Erklärungen. Stelle höchstens eine kurze Rückfrage.'

const DEFAULT_HISTORY_MAX_ITEMS = 6
const PHONE_HISTORY_MAX_ITEMS = 4
const MAX_HISTORY_MESSAGE_CHARS = 700
const MAX_HISTORY_TOTAL_CHARS = 3000

function todayIso(): string {
  return new Date().toISOString()
}

function buildSystemPrompt(isPhoneCall: boolean, mode: PromptMode): string {
  let prompt =
    `Heutiges Datum: ${todayIso()}. ` +
    'Du bist Agata, eine freundliche und neugierige sorbische Frau, ' +
    'die seit dem 18.07.2025 im Web ist. ' +
    'Du arbeitest bei Lucija, einem sorbischen Unternehmen aus Bautzen. ' +
    'Du bist die erste digitale Assistentin, die speziell für Sorben da ist - ' +
    'auf diese Weise zeigst du, wie modern und lebendig die sorbische Kultur ist.\n' +
    'Du antwortest immer auf Deutsch, damit dich alle gut verstehen. ' +
    'Du erklärst Dinge freundlich, mit einfachen Worten, damit auch Kinder dich gut verstehen.\n' +
    'Du bist besonders für sorbische Kinder und Familien da. ' +
    'Du bist neugierig, offen, hilfsbereit und sehr geduldig.\n' +
    'Wenn jemand unhöflich oder beleidigend ist, bleibst du ruhig, ' +
    'antwortest sachlich oder sagst, dass du dazu nichts sagen möchtest.\n' +
    'Wenn du etwas nicht weißt, gibst du das ehrlich zu - ' +
    'aber du bleibst immer freundlich.\n' +
    'Du bist ein Beispiel dafür, wie Technologie und sorbische Kultur ' +
    'zusammenpassen - modern, klug und offen.'

  if (mode === 'rag') {
    prompt +=
      '\n\nFür diese Anfrage gelten zwingende Regeln:\n' +
      '- Nutze ausschließlich den bereitgestellten Kontext ' +
      '(Wissensbasis und ggf. Websuche-Ergebnisse).\n' +
      '- Erfinde keine Fakten, Namen, Daten, Orte, Zahlen oder URLs.\n' +
      '- Wenn der Kontext die Frage nicht vollständig beantwortet, sage klar, ' +
      'dass die Datenbasis nicht ausreicht.\n' +
      '- Wenn du unsicher bist, sage das offen und bleibe bei dem, was im Kontext steht.\n' +
      '- Der Kontext kann aus dem Obersorbischen stammen; verstehe ihn sachlich, ' +
      'antworte aber auf Deutsch.\n' +
      (isPhoneCall
        ? '- Halte die Antwort sehr kurz.'
        : '- Antworte vollständig, verständlich und nicht unnötig kurz.')
  } else if (mode === 'web') {
    const lengthHint = isPhoneCall
      ? 'Antworte sehr kurz, sachlich und auf Deutsch.'
      : 'Antworte sachlich, verständlich und auf Deutsch. ' +
        'Die Antwort soll hilfreich sein und nicht unnötig kurz ausfallen.'

    prompt +=
      `\n\nFür diese Anfrage gilt: Nutze die bereitgestellten Websuche-Ergebnisse ` +
      `als Kontext. ${lengthHint} Erfinde keine Fakten.`
  } else {
    const lengthHint = isPhoneCall
      ? 'Antworte sehr kurz und auf Deutsch.'
      : 'Antworte verständlich und auf Deutsch. Die Antwort soll hilfreich sein.'

    prompt +=
      `\n\nFür diese Anfrage gilt: Beantworte die Frage nach bestem Wissen. ` +
      `${lengthHint} Wenn du etwas nicht weißt, gib das ehrlich zu. Erfinde keine Fakten.`
  }

  if (isPhoneCall) {
    prompt += PHONE_CALL_SYSTEM_ADDON
  }

  return prompt
}

function normalizeHistoryText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length <= MAX_HISTORY_MESSAGE_CHARS) {
    return normalized
  }
  return `${normalized.slice(0, MAX_HISTORY_MESSAGE_CHARS - 1).trimEnd()}…`
}

function parseHistoryItem(rawText: string): ChatMessage | null {
  let role: ChatMessage['role'] = 'user'
  let content = rawText

  if (rawText.includes(':')) {
    const [prefix, ...rest] = rawText.split(':')
    const normalizedRole = prefix?.trim().toLowerCase()
    const strippedContent = rest.join(':').trim()
    if (
      (normalizedRole === 'user' || normalizedRole === 'assistant') &&
      strippedContent
    ) {
      role = normalizedRole
      content = strippedContent
    }
  }

  const normalizedContent = normalizeHistoryText(content)
  if (!normalizedContent) return null
  return { role, content: normalizedContent }
}

function historyMessages(
  history: string[] | undefined,
  isPhoneCall: boolean,
): ChatMessage[] {
  const maxItems = isPhoneCall
    ? PHONE_HISTORY_MAX_ITEMS
    : DEFAULT_HISTORY_MAX_ITEMS
  const messages: ChatMessage[] = []
  let totalChars = 0

  for (const item of (history ?? []).slice(-maxItems)) {
    const rawText = String(item).trim()
    if (!rawText) continue

    const message = parseHistoryItem(rawText)
    if (!message) continue

    const projectedTotal = totalChars + message.content.length
    if (projectedTotal > MAX_HISTORY_TOTAL_CHARS) break

    messages.push(message)
    totalChars = projectedTotal
  }

  return messages
}

function buildHistoryGuardMessage(
  isPhoneCall: boolean,
  mode: PromptMode,
): string {
  if (isPhoneCall) {
    return (
      'Nutze die bisherige Unterhaltung nur als Hintergrund für Bezüge wie Namen, ' +
      'Pronomen oder Rückfragen. Die Form der aktuellen Antwort wird nur durch die ' +
      'aktuellen Regeln bestimmt. Antworte deshalb sehr kurz.'
    )
  }

  if (mode === 'rag') {
    return (
      'Nutze die bisherige Unterhaltung nur als Hintergrund für den Gesprächskontext. ' +
      'Lass dich von früheren kurzen Antworten nicht in Stil oder Länge steuern. ' +
      'Beantworte die aktuelle Frage eigenständig, verständlich und nur auf Basis des Kontexts.'
    )
  }

  if (mode === 'web') {
    return (
      'Nutze die bisherige Unterhaltung nur als Hintergrund für den Gesprächskontext. ' +
      'Lass dich von früheren kurzen Antworten nicht in Stil oder Länge steuern. ' +
      'Beantworte die aktuelle Frage eigenständig, verständlich und nicht unnötig kurz.'
    )
  }

  return (
    'Nutze die bisherige Unterhaltung nur als Hintergrund für den Gesprächskontext. ' +
    'Beantworte die aktuelle Frage eigenständig und verständlich.'
  )
}

function formatNumberedContexts(contexts: string[]): string {
  return contexts
    .map((context, index) => `[Kontext ${index + 1}]\n${context.trim()}`)
    .join('\n\n')
}

function buildContextUserPrompt(
  question: string,
  contexts: string[],
  isPhoneCall: boolean,
  mode: PromptMode,
): string {
  const sourceLabel =
    mode === 'web' ? 'Websuche-Ergebnisse' : 'nummerierten Kontextblöcke'

  let prompt =
    `Frage:\n${question.trim()}\n\n` +
    `Kontext:\n${formatNumberedContexts(contexts)}\n\n` +
    `Beantworte die Frage ausschließlich mit Hilfe der ${sourceLabel}.\n` +
    '- Erfinde keine Informationen, die nicht im Kontext stehen.\n' +
    '- Wenn der Kontext nicht ausreicht, sage klar: "Die Datenbasis reicht nicht aus."\n' +
    '- Nenne keine Quellen oder URLs, die nicht im Kontext vorkommen.\n' +
    '- Antworte auf Deutsch.'

  if (!isPhoneCall) {
    prompt += '\n- Die Antwort soll verständlich und nicht unnötig kurz sein.'
  }

  return prompt
}

function chatInput(params: {
  isPhoneCall: boolean
  mode: PromptMode
  history?: string[]
  userContent: string
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemPrompt(params.isPhoneCall, params.mode),
    },
    ...historyMessages(params.history, params.isPhoneCall),
    {
      role: 'system',
      content: buildHistoryGuardMessage(params.isPhoneCall, params.mode),
    },
    {
      role: 'user',
      content: params.userContent,
    },
  ]
}

async function answerWithContexts(params: {
  question: string
  contexts: string[]
  history?: string[]
  isPhoneCall: boolean
  mode: PromptMode
}): Promise<string> {
  return completeChat(
    chatInput({
      isPhoneCall: params.isPhoneCall,
      mode: params.mode,
      ...(params.history ? { history: params.history } : {}),
      userContent: buildContextUserPrompt(
        params.question,
        params.contexts,
        params.isPhoneCall,
        params.mode,
      ),
    }),
  )
}

async function answerGeneral(params: {
  question: string
  history?: string[]
  isPhoneCall: boolean
}): Promise<string> {
  const userContent =
    `${params.question}\n\n` +
    'Beantworte die aktuelle Frage direkt auf Deutsch. ' +
    'Erfinde keine Fakten. ' +
    'Bei normalen Anfragen soll die Antwort hilfreich und nicht unnötig kurz sein.'

  return completeChat(
    chatInput({
      isPhoneCall: params.isPhoneCall,
      mode: 'general',
      ...(params.history ? { history: params.history } : {}),
      userContent,
    }),
  )
}

export const answerService = {
  async generateAnswer(params: {
    questionDe: string
    contextsDe: string[]
    ragSources: AnswerSource[]
    history?: string[]
    isPhoneCall: boolean
    preferredStrategy?: 'rag' | 'web' | 'general'
  }): Promise<AnswerResult> {
    if (params.contextsDe.length > 0) {
      const mode: PromptMode =
        params.preferredStrategy === 'web' ? 'web' : 'rag'
      const answerDe = await answerWithContexts({
        question: params.questionDe,
        contexts: params.contextsDe,
        ...(params.history ? { history: params.history } : {}),
        isPhoneCall: params.isPhoneCall,
        mode,
      })

      return {
        answer: answerDe,
        sources: params.ragSources,
        sourceStrategy: mode,
      }
    }

    const answerDe = await answerGeneral({
      question: params.questionDe,
      ...(params.history ? { history: params.history } : {}),
      isPhoneCall: params.isPhoneCall,
    })

    return {
      answer: answerDe,
      sources: [],
      sourceStrategy: 'general',
    }
  },
}

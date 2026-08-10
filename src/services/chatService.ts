import mongoose from 'mongoose'
import { Prompt } from '../models/Prompt'
import { Visitor } from '../models/Visitor'
import { answerService } from './answerService'
import {
  DUCKDUCKGO_WITHOUT_RAG_COUNT,
  DUCKDUCKGO_WITH_RAG_COUNT,
  searchDuckDuckGo,
} from './duckDuckGoClient'
import { sotraClient } from './sotraClient'
import {
  assignSourceIds,
  countSourcesByType,
  normalizeRagSources,
  normalizeWebSources,
} from './sourceService'
import type { AnswerLanguage, Source } from '../types/source'
import { detectQueryLanguage } from '../utils/language'
import {
  ChatTimingLogger,
  chatTimingLog,
  summarizeText,
  timedStep,
} from '../utils/chatTimingLogger'

export type ChatServiceResult = {
  language: AnswerLanguage
  title: string
  /** Primary answer field for the stable API */
  answer: string
  /**
   * Alias of `answer` for existing clients (webapp/SIP) during transition.
   * Prefer `answer` for new code.
   */
  message: string
  timestamp: string
  sources: Source[]
}

export type ChatServiceInput = {
  message: string
  ipAddress?: string
  persist?: boolean
  isPhoneCall?: boolean
  /** Explicit UI language overrides detection when provided */
  outputLanguage?: AnswerLanguage
}

type HistoryItem = {
  role: 'assistant' | 'user'
  content: string
}

type RagAskResponse = {
  contexts: string[]
  sources: {
    source_type: string
    source_url: string
    title: string
  }[]
}

const MAX_CACHED_HISTORY_ITEMS = 3
const conversationHistoryCache = new Map<string, HistoryItem[]>()

function normalizeHistoryToStringArray(history: HistoryItem[]): string[] {
  return history
    .map(item => {
      const prefix = item.role === 'user' ? 'User' : 'Assistant'
      return `${prefix}: ${String(item.content ?? '').trim()}`
    })
    .filter(Boolean)
}

function summarizeRagResponse(response: RagAskResponse) {
  return {
    contextCount: response.contexts.length,
    sourceCount: response.sources.length,
    sources: response.sources.map(source => ({
      source_type: source.source_type,
      source_url: source.source_url,
      title: source.title,
    })),
    contextChars: response.contexts.map(context => context.length),
    contextPreviews: response.contexts.map(context =>
      summarizeText(context, 250),
    ),
  }
}

async function buildHistory(ipAddress?: string): Promise<HistoryItem[]> {
  if (!ipAddress) return []

  return conversationHistoryCache.get(ipAddress) ?? []
}

function rememberHistoryTurn(params: {
  ipAddress: string
  input_text: string
  output_text: string
}) {
  const inputText = String(params.input_text ?? '').trim()
  const outputText = String(params.output_text ?? '').trim()

  if (!inputText && !outputText) return

  const currentHistory = conversationHistoryCache.get(params.ipAddress) ?? []
  const nextHistory = [...currentHistory]

  if (inputText) {
    nextHistory.push({
      role: 'user',
      content: inputText,
    })
  }

  if (outputText) {
    nextHistory.push({
      role: 'assistant',
      content: outputText,
    })
  }

  conversationHistoryCache.set(
    params.ipAddress,
    nextHistory.slice(-MAX_CACHED_HISTORY_ITEMS),
  )
}

async function persistPrompt(params: {
  ipAddress: string
  input_text: string
  output_text: string
}) {
  const visitor = await Visitor.findOne({ ipAddress: params.ipAddress })
  if (!visitor) return

  const prompt = await Prompt.create({
    input_text: params.input_text,
    output_text: params.output_text,
    visitor: visitor._id,
  })

  visitor.prompts.push(prompt._id as unknown as mongoose.Types.ObjectId)
  await visitor.save()
}

async function askRagServer(
  question: string,
  logger: ChatTimingLogger,
): Promise<RagAskResponse> {
  const RAG_SERVER_URL = process.env['RAG_SERVER_URL']

  if (!RAG_SERVER_URL) {
    throw new Error('RAG_SERVER_URL ist nicht gesetzt')
  }

  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()
  chatTimingLog(`${timestamp} | rag request`, {
    questionChars: question.length,
    questionPreview: summarizeText(question),
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  try {
    const response = await fetch(`${RAG_SERVER_URL.replace(/\/$/, '')}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        question,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `RAG /ask Fehler: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
      )
    }

    const data = (await response.json()) as RagAskResponse
    const durationMs = Date.now() - startedAt
    const finishedAt = new Date().toISOString()

    chatTimingLog(
      `${finishedAt} | rag response | ${durationMs}ms`,
      summarizeRagResponse(data),
    )
    logger.step('rag', {
      durationMs,
      ...summarizeRagResponse(data),
    })

    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function questionToGerman(
  question: string,
  queryLanguage: ReturnType<typeof detectQueryLanguage>,
): Promise<string> {
  if (queryLanguage === 'de') return question
  return sotraClient.translateHsbToDe(question)
}

/**
 * Translate RAG context snippets to German for retrieval/LLM when needed.
 * Snippets stay server-side as source content; URLs are never sent to the LLM.
 */
async function translateRagSnippetsToGerman(
  contexts: string[],
  logger: ChatTimingLogger,
): Promise<string[]> {
  if (contexts.length === 0) return []

  return timedStep(
    logger,
    'contexts translated HSB→DE',
    () =>
      Promise.all(
        contexts.map(context => sotraClient.translateHsbToDe(context)),
      ),
    result => ({
      translatedContextCount: result.length,
      translatedContextChars: result.map(context => context.length),
      translatedContextPreviews: result.map(context =>
        summarizeText(context, 250),
      ),
    }),
  )
}

export const chatService = {
  async handleChat(input: ChatServiceInput): Promise<ChatServiceResult> {
    const message = (input.message ?? '').trim()

    if (!message) {
      return {
        language: 'hsb',
        title: '',
        answer: '',
        message: '',
        timestamp: new Date().toISOString(),
        sources: [],
      }
    }

    const logger = new ChatTimingLogger('chat')
    logger.step('start', {
      questionChars: message.length,
      questionPreview: summarizeText(message),
      isPhoneCall: input.isPhoneCall ?? false,
      hasIpAddress: Boolean(input.ipAddress),
    })

    const ipAddress = input.ipAddress
    const persist = input.persist ?? true
    const isPhoneCall = input.isPhoneCall ?? false

    const history = await timedStep(
      logger,
      'history loaded',
      () => buildHistory(ipAddress),
      result => ({ historyItems: result.length }),
    )
    const ragHistory = normalizeHistoryToStringArray(history)

    const ragResponse = await askRagServer(message, logger)
    const queryLanguage = detectQueryLanguage(message)
    // Explicit frontend/client language wins over detection.
    const outputLanguage: AnswerLanguage =
      input.outputLanguage ?? queryLanguage
    logger.step('query language detected', { queryLanguage, outputLanguage })

    const questionDe = await timedStep(
      logger,
      queryLanguage === 'de'
        ? 'question already DE'
        : 'question translated HSB→DE (before duckduckgo)',
      () => questionToGerman(message, queryLanguage),
      result => ({
        questionDeChars: result.length,
        questionDePreview: summarizeText(result),
      }),
    )

    const contextsDe = await translateRagSnippetsToGerman(
      ragResponse.contexts,
      logger,
    )

    const ragIsBad = contextsDe.length === 0
    const ddgCount = ragIsBad
      ? DUCKDUCKGO_WITHOUT_RAG_COUNT
      : DUCKDUCKGO_WITH_RAG_COUNT

    const ddgResults = await timedStep(
      logger,
      `duckduckgo search (${ddgCount})`,
      () => searchDuckDuckGo(questionDe, ddgCount),
      result => ({
        resultCount: result.length,
        requestedCount: ddgCount,
        ragIsBad,
        queryPreview: summarizeText(questionDe),
        results: result.map(item => ({
          title: item.title,
          url: item.url,
          snippetPreview: summarizeText(item.snippet, 200),
        })),
      }),
    )

    const ragSourcesNormalized = normalizeRagSources(
      contextsDe,
      ragResponse.sources,
    )
    const webSourcesNormalized = normalizeWebSources(ddgResults)
    const sources = assignSourceIds([
      ...ragSourcesNormalized,
      ...webSourcesNormalized,
    ])

    const { ragCount, webCount } = countSourcesByType(sources)
    logger.step('sources normalized', {
      ragSourceCount: ragCount,
      webSourceCount: webCount,
      sourcesForOllama: sources.length,
      sourceIds: sources.map(source => source.id),
    })

    let preferredStrategy: 'rag' | 'web' | 'general' | undefined
    if (sources.length === 0) {
      preferredStrategy = 'general'
    } else if (ragIsBad) {
      preferredStrategy = webCount > 0 ? 'web' : 'general'
    } else {
      preferredStrategy = 'rag'
    }

    const answerResult = await timedStep(
      logger,
      'llm answer generated',
      () =>
        answerService.generateAnswer({
          originalQuestion: message,
          questionDe,
          outputLanguage,
          sources,
          history: ragHistory,
          isPhoneCall,
          ...(preferredStrategy ? { preferredStrategy } : {}),
        }),
      result => ({
        sourceStrategy: result.sourceStrategy,
        language: result.language,
        titleChars: result.title.length,
        sourceCount: result.sources.length,
        sourceIds: result.sources.map(source => source.id),
        answerChars: result.answer.length,
        answerPreview: summarizeText(result.answer),
      }),
    )

    const responseMessage = answerResult.answer.trim()

    if (ipAddress) {
      rememberHistoryTurn({
        ipAddress,
        input_text: message,
        output_text: responseMessage,
      })
    }

    if (persist && ipAddress) {
      await timedStep(logger, 'prompt persisted', () =>
        persistPrompt({
          ipAddress,
          input_text: message,
          output_text: responseMessage,
        }),
      )
    }

    logger.done({
      sourceStrategy: answerResult.sourceStrategy,
      ragSourceCount: ragCount,
      webSourceCount: webCount,
      sourcesForOllama: sources.length,
      finalSourceCount: answerResult.sources.length,
      responseChars: responseMessage.length,
    })

    return {
      language: answerResult.language,
      title: answerResult.title,
      answer: responseMessage,
      message: responseMessage,
      timestamp: new Date().toISOString(),
      sources: answerResult.sources,
    }
  },
}

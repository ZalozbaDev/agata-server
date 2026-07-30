import mongoose from 'mongoose'
import { Prompt } from '../models/Prompt'
import { Visitor } from '../models/Visitor'
import { answerService } from './answerService'
import {
  DUCKDUCKGO_WITHOUT_RAG_COUNT,
  DUCKDUCKGO_WITH_RAG_COUNT,
  formatDuckDuckGoContexts,
  searchDuckDuckGo,
} from './duckDuckGoClient'
import { sotraClient } from './sotraClient'
import { detectQueryLanguage } from '../utils/language'
import {
  ChatTimingLogger,
  chatTimingLog,
  summarizeText,
  timedStep,
} from '../utils/chatTimingLogger'

export type ChatServiceResult = {
  message: string
  timestamp: string
  sources: {
    source_type: string
    source_url: string
    title: string
  }[]
}

export type ChatServiceInput = {
  message: string
  ipAddress?: string
  persist?: boolean
  isPhoneCall?: boolean
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
    contextPreviews: response.contexts.map(context => summarizeText(context, 250)),
  }
}

async function buildHistory(ipAddress?: string): Promise<HistoryItem[]> {
  if (!ipAddress) return []

  const visitor = await Visitor.findOne({ ipAddress }).populate({
    path: 'prompts',
    model: 'Prompt',
    select: 'input_text output_text',
    options: { sort: { _id: -1 }, limit: 3 },
  })

  const history: HistoryItem[] = []
  if (!visitor) return history

  for (let index = 0; index < visitor.prompts.length; index++) {
    const prompt = visitor.prompts[index] as any

    if (typeof prompt === 'object' && prompt !== null) {
      const inputText = String(prompt.input_text ?? '').trim()
      const outputText = String(prompt.output_text ?? '').trim()

      if (inputText) {
        history.push({
          role: 'user',
          content: inputText,
        })
      }

      if (outputText) {
        history.push({
          role: 'assistant',
          content: outputText,
        })
      }
    }
  }

  return history
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

    chatTimingLog(`${finishedAt} | rag response | ${durationMs}ms`, summarizeRagResponse(data))
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

export const chatService = {
  async handleChat(input: ChatServiceInput): Promise<ChatServiceResult> {
    const message = (input.message ?? '').trim()

    if (!message) {
      return {
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

    const history = await timedStep(logger, 'history loaded', () =>
      buildHistory(ipAddress),
      result => ({ historyItems: result.length }),
    )
    const ragHistory = normalizeHistoryToStringArray(history)

    const ragResponse = await askRagServer(message, logger)
    const queryLanguage = detectQueryLanguage(message)
    logger.step('query language detected', { queryLanguage })

    // Always have a German question before DuckDuckGo (and the LLM).
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

    let contextsDe =
      ragResponse.contexts.length > 0
        ? await timedStep(
            logger,
            'contexts translated HSB→DE',
            () =>
              Promise.all(
                ragResponse.contexts.map(context =>
                  sotraClient.translateHsbToDe(context),
                ),
              ),
            result => ({
              translatedContextCount: result.length,
              translatedContextChars: result.map(context => context.length),
              translatedContextPreviews: result.map(context =>
                summarizeText(context, 250),
              ),
            }),
          )
        : []

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

    let answerSources = [...ragResponse.sources]
    let preferredStrategy: 'rag' | 'web' | 'general' | undefined

    if (ddgResults.length > 0) {
      contextsDe = [...contextsDe, ...formatDuckDuckGoContexts(ddgResults)]
      answerSources = [
        ...answerSources,
        ...ddgResults.map(result => ({
          source_type: 'web',
          source_url: result.url,
          title: result.title,
        })),
      ]
      preferredStrategy = ragIsBad ? 'web' : 'rag'
    } else if (ragIsBad) {
      preferredStrategy = 'general'
    }

    const answerResult = await timedStep(
      logger,
      'llm answer generated',
      () =>
        answerService.generateAnswer({
          questionDe,
          contextsDe,
          ragSources: answerSources,
          history: ragHistory,
          isPhoneCall,
          ...(preferredStrategy ? { preferredStrategy } : {}),
        }),
      result => ({
        sourceStrategy: result.sourceStrategy,
        sourceCount: result.sources.length,
        answerDeChars: result.answer.length,
        answerDePreview: summarizeText(result.answer),
      }),
    )

    const responseMessage = (
      await timedStep(
        logger,
        'answer translated DE→HSB',
        () => sotraClient.translateDeToHsb(answerResult.answer),
        result => ({
          answerHsbChars: result.length,
          answerHsbPreview: summarizeText(result),
        }),
      )
    ).trim()

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
      contextCount: ragResponse.contexts.length,
      sourceCount: answerResult.sources.length,
      responseChars: responseMessage.length,
    })

    return {
      message: responseMessage,
      timestamp: new Date().toISOString(),
      sources: answerResult.sources,
    }
  },
}

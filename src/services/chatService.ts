import mongoose from 'mongoose'
import { Prompt } from '../models/Prompt'
import { Visitor } from '../models/Visitor'
import { answerService } from './answerService'
import { searchDuckDuckGo } from './duckDuckGoClient'
import { resolveOutputLanguage, SIP_PERSONA_ID, type Persona } from '../config/personas'
import { chatHistoryKey } from './personaPolicy'
import { personaService } from './personaService'
import { sotraClient } from './sotraClient'
import { rewriteSearchQuery, type SearchRewriteLanguage } from './searchRewrite'
import {
  assignSourceIds,
  countSourcesByType,
  normalizeRagSources,
  normalizeWebSources,
  stripInvalidSourceRefs,
} from './sourceService'
import type { AnswerLanguage, Source } from '../types/source'
import { detectQueryLanguage } from '../utils/language'
import {
  ChatTimingLogger,
  chatTimingLog,
  logCompactChatTurn,
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
  personaId: string
  /** Bamborak speaker that should read `answer` aloud. */
  speakerId: string
}

export type ChatServiceInput = {
  message: string
  ipAddress?: string
  persist?: boolean
  isPhoneCall?: boolean
  /** Explicit UI language overrides detection when provided */
  outputLanguage?: AnswerLanguage
  /** Missing ids use Main. Phone calls use Sip. Managed ids are loaded from MongoDB. */
  personaId?: string
  /** Set only after the admin middleware has already authorized the caller. */
  allowPrivatePersona?: boolean
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
    source_id?: string
    page?: number | null
    published_at?: string | null
    publishedAt?: string | null
    section?: string | null
    score?: number | null
  }[]
  scores?: number[]
}

/** Two full turns, so a follow-up still sees the previous user questions. */
const MAX_CACHED_HISTORY_ITEMS = 4
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
    scores: response.scores ?? response.sources.map(source => source.score ?? null),
    sources: response.sources.map(source => ({
      source_type: source.source_type,
      source_url: source.source_url,
      title: source.title,
      source_id: source.source_id ?? null,
      page: source.page ?? null,
      score: source.score ?? null,
      published_at: source.published_at ?? source.publishedAt ?? null,
    })),
    contextChars: response.contexts.map(context => context.length),
    contextPreviews: response.contexts.map(context =>
      summarizeText(context, 250),
    ),
  }
}

async function buildHistory(cacheKey?: string): Promise<HistoryItem[]> {
  if (!cacheKey) return []

  return conversationHistoryCache.get(cacheKey) ?? []
}

function rememberHistoryTurn(params: {
  cacheKey: string
  input_text: string
  output_text: string
}) {
  const inputText = String(params.input_text ?? '').trim()
  const outputText = String(params.output_text ?? '').trim()

  if (!inputText && !outputText) return

  const currentHistory = conversationHistoryCache.get(params.cacheKey) ?? []
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
    params.cacheKey,
    nextHistory.slice(-MAX_CACHED_HISTORY_ITEMS),
  )
}

async function persistPrompt(params: {
  ipAddress: string
  input_text: string
  output_text: string
}) {
  // Both fields are required by the schema, so an empty generation would turn
  // a degraded answer into a failed request.
  if (!params.input_text.trim() || !params.output_text.trim()) {
    chatTimingLog('prompt not persisted', {
      reason: 'empty input or output',
      inputChars: params.input_text.trim().length,
      outputChars: params.output_text.trim().length,
    })
    return
  }

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
  persona: Persona,
  logger: ChatTimingLogger,
  language: 'de' | 'hsb' | 'dsb',
): Promise<RagAskResponse> {
  const RAG_SERVER_URL = process.env['RAG_SERVER_URL']

  if (!RAG_SERVER_URL) {
    throw new Error('RAG_SERVER_URL ist nicht gesetzt')
  }

  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()
  const retrievalLanguage = language

  chatTimingLog(`${timestamp} | rag request`, {
    questionChars: question.length,
    questionPreview: summarizeText(question),
    collection: persona.collection,
    topK: persona.ragTopK,
    language: retrievalLanguage,
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
        collection: persona.collection,
        top_k: persona.ragTopK,
        language: retrievalLanguage,
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
 * German wording for the model. Upper Sorbian text is translated with Sotra.
 * Text that is already German stays as it is. Citations of Upper Sorbian
 * documents keep the original snippet and do not use this result.
 */
/** Private personas keep the answer, but not citation markers or source links. */
function answerWithoutSourceLinks(answer: string): string {
  return stripInvalidSourceRefs(answer, new Set())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
}

function withGermanRagSnippets(sources: Source[], germanSnippets: string[]): Source[] {
  const ragIds = sources
    .filter(source => source.type === 'rag')
    .map(source => source.id)
  const germanById = new Map(
    ragIds.map((id, index) => [id, germanSnippets[index]?.trim() ?? '']),
  )
  return sources.map(source => {
    const german = germanById.get(source.id)
    if (!german || german === String(source.snippet ?? '').trim()) return source
    return { ...source, snippet: german }
  })
}

async function translateRagSnippetsToGerman(
  contexts: string[],
  logger: ChatTimingLogger,
): Promise<string[]> {
  if (contexts.length === 0) return []

  return timedStep(
    logger,
    'contexts prepared for LLM (HSB→DE only when needed)',
    () =>
      Promise.all(
        contexts.map(async context => {
          if (detectQueryLanguage(context) === 'de') {
            return { text: context, translated: false }
          }
          return {
            text: await sotraClient.translateHsbToDe(context),
            translated: true,
          }
        }),
      ).then(prepared => ({
        texts: prepared.map(item => item.text),
        translatedHsbToDe: prepared.filter(item => item.translated).length,
        skippedAlreadyDe: prepared.filter(item => !item.translated).length,
      })),
    result => ({
      contextCount: result.texts.length,
      translatedHsbToDe: result.translatedHsbToDe,
      skippedAlreadyDe: result.skippedAlreadyDe,
      contextChars: result.texts.map(context => context.length),
      contextPreviews: result.texts.map(context => summarizeText(context, 250)),
    }),
  ).then(result => result.texts)
}

export const chatService = {
  async handleChat(input: ChatServiceInput): Promise<ChatServiceResult> {
    const message = (input.message ?? '').trim()
    const persona = await personaService.resolveChatPersona(
      input.isPhoneCall ? SIP_PERSONA_ID : input.personaId,
      { allowPrivate: input.allowPrivatePersona === true },
    )
    if (!message) {
      return {
        language: persona.language === 'auto' ? 'hsb' : persona.language,
        title: '',
        answer: '',
        message: '',
        timestamp: new Date().toISOString(),
        sources: [],
        personaId: persona.id,
        speakerId: persona.speakerId,
      }
    }

    const logger = new ChatTimingLogger('chat')
    logger.step('start', {
      questionChars: message.length,
      questionPreview: summarizeText(message),
      isPhoneCall: input.isPhoneCall ?? false,
      hasIpAddress: Boolean(input.ipAddress),
      persona: persona.id,
      collection: persona.collection,
    })

    const ipAddress = input.ipAddress
    const persist = input.persist ?? true
    const isPhoneCall = input.isPhoneCall ?? false
    const historyKey = ipAddress
      ? chatHistoryKey(persona.id, ipAddress)
      : undefined

    const history = await timedStep(
      logger,
      'history loaded',
      () => buildHistory(historyKey),
      result => ({ historyItems: result.length }),
    )
    const ragHistory = normalizeHistoryToStringArray(history)

    const queryLanguage = detectQueryLanguage(message)
    // Persona language wins; otherwise the explicit client language, then detection.
    const outputLanguage: AnswerLanguage = resolveOutputLanguage(
      persona,
      queryLanguage,
      input.outputLanguage,
    )
    logger.step('query language detected', {
      queryLanguage,
      outputLanguage,
      personaLanguage: persona.language,
      documentLanguage: persona.documentLanguage ?? null,
    })

    // Upper Sorbian documents are retrieved and cited in the original wording.
    // The model reads a German Sotra translation and writes the answer in German.
    // Only the finished title and answer are translated back to Upper Sorbian.
    // Lower Sorbian has no Sotra pair, so that text stays unchanged.
    const documentLanguage = persona.documentLanguage
    const preserveDocumentWording =
      documentLanguage === 'hsb' || documentLanguage === 'dsb'
    const reasonInGerman = documentLanguage === 'hsb'
    const keepOriginalText = documentLanguage === 'dsb' && queryLanguage === 'hsb'
    const rewriteLanguage: SearchRewriteLanguage =
      documentLanguage === 'de' || documentLanguage === 'hsb' || documentLanguage === 'dsb'
        ? documentLanguage
        : queryLanguage
    const hasPreviousUser = history.some(
      item => item.role === 'user' && item.content.trim().length > 0,
    )
    const rewritePromise = hasPreviousUser
      ? rewriteSearchQuery({
          question: message,
          history,
          language: rewriteLanguage,
        })
      : Promise.resolve(null)

    const questionDe = keepOriginalText
      ? message
      : await timedStep(
          logger,
          queryLanguage === 'de'
            ? 'question already DE'
            : reasonInGerman
              ? 'question translated HSB→DE (model)'
              : 'question translated HSB→DE (retrieval fallback)',
          () => questionToGerman(message, queryLanguage),
          result => ({
            questionDeChars: result.length,
            questionDePreview: summarizeText(result),
          }),
        )
    if (keepOriginalText) {
      logger.step('question kept in original language', { queryLanguage })
    }

    const rewrittenQuery = await rewritePromise
    logger.step(rewrittenQuery ? 'search query rewritten' : 'search query unchanged', {
      reason: !hasPreviousUser
        ? 'no previous turn'
        : rewrittenQuery
          ? 'follow-up'
          : 'rewrite failed',
      language: rewriteLanguage,
      queryPreview: summarizeText(rewrittenQuery ?? message),
    })

    // Search in the language the persona's documents were indexed with.
    // German documents are queried in German. Sorbian documents keep the
    // original wording, because a translation drops the lexical match.
    // A follow-up is rewritten into that same language; the answer model
    // still sees the original message.
    const germanQuestion = questionDe.trim()
    const fallbackQuery = documentLanguage === 'de' ? germanQuestion || message : message
    const ragQuery = rewrittenQuery ?? fallbackQuery
    let ragForAnswer
    if (documentLanguage === 'de') {
      ragForAnswer = await askRagServer(ragQuery, persona, logger, 'de')
    } else if (documentLanguage === 'hsb' || documentLanguage === 'dsb') {
      ragForAnswer = await askRagServer(ragQuery, persona, logger, documentLanguage)
    } else {
      const ragResponse = await askRagServer(ragQuery, persona, logger, queryLanguage)
      const originalHitCount = ragResponse.contexts?.length ?? 0
      const useGermanFallback =
        !rewrittenQuery &&
        originalHitCount === 0 &&
        germanQuestion.length > 0 &&
        germanQuestion !== message.trim()
      ragForAnswer = useGermanFallback
        ? await askRagServer(germanQuestion, persona, logger, 'de')
        : ragResponse
    }

    const contextsForAnswer = preserveDocumentWording
      ? (ragForAnswer.contexts ?? [])
      : await translateRagSnippetsToGerman(ragForAnswer.contexts ?? [], logger)
    if (reasonInGerman) {
      logger.step('contexts kept in Upper Sorbian for citations', {
        contextCount: contextsForAnswer.length,
      })
    } else if (preserveDocumentWording) {
      logger.step('contexts kept in document language', {
        documentLanguage,
        contextCount: contextsForAnswer.length,
      })
    }

    const ragSourcesNormalized = normalizeRagSources(
      contextsForAnswer,
      ragForAnswer.sources ?? [],
      ragForAnswer.scores,
    )
    const usableRagSources = ragSourcesNormalized.filter(
      source => String(source.snippet ?? '').trim().length > 0,
    )
    const ragIsBad = usableRagSources.length === 0
    const ddgCount = ragIsBad
      ? persona.webFallbackResultCount
      : persona.webResultCount

    let ddgResults: Awaited<ReturnType<typeof searchDuckDuckGo>> = []
    const webQuery = rewrittenQuery ?? questionDe

    if (ddgCount > 0) {
      ddgResults = await timedStep(
        logger,
        `duckduckgo search (${ddgCount})`,
        () => searchDuckDuckGo(webQuery, ddgCount),
        result => ({
          resultCount: result.length,
          requestedCount: ddgCount,
          ragIsBad,
          queryPreview: summarizeText(webQuery),
          results: result.map(item => ({
            title: item.title,
            url: item.url,
            snippetPreview: summarizeText(item.snippet, 200),
          })),
        }),
      )

      // If RAG is empty and the first web search fails, retry with a shorter query.
      if (ragIsBad && ddgResults.length === 0) {
        const shorterQuery = webQuery.split(/\s+/).slice(0, 8).join(' ')
        if (shorterQuery && shorterQuery !== webQuery) {
          ddgResults = await timedStep(
            logger,
            `duckduckgo fallback search (${ddgCount})`,
            () => searchDuckDuckGo(shorterQuery, ddgCount),
            result => ({
              resultCount: result.length,
              requestedCount: ddgCount,
              queryPreview: summarizeText(shorterQuery),
            }),
          )
        }
      }
    } else {
      logger.step('duckduckgo skipped', { reason: 'persona has web disabled' })
    }

    // RAG first (priority), then web supplements.
    const sources = assignSourceIds([
      ...usableRagSources,
      ...normalizeWebSources(ddgResults),
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

    const germanRagSnippets =
      reasonInGerman && usableRagSources.length > 0
        ? await translateRagSnippetsToGerman(
            usableRagSources.map(source => String(source.snippet ?? '')),
            logger,
          )
        : null
    const promptSources = germanRagSnippets
      ? withGermanRagSnippets(sources, germanRagSnippets)
      : undefined

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
          persona,
          ...(reasonInGerman ? { reasonInGerman: true } : {}),
          ...(promptSources ? { promptSources } : {}),
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

    const responseMessage = persona.showSourceLinks
      ? answerResult.answer.trim()
      : answerWithoutSourceLinks(answerResult.answer)
    const responseSources = persona.showSourceLinks ? answerResult.sources : []

    logCompactChatTurn({
      personaId: persona.id,
      question: message,
      ragHits: usableRagSources.map(source => ({
        title: source.title,
        score: source.score ?? null,
        page: source.page ?? null,
        snippet: source.snippet ?? null,
      })),
      sentToAi: (promptSources ?? sources).map(source => ({
        id: source.id,
        type: source.type,
        title: source.title,
        snippetPreview: summarizeText(String(source.snippet ?? ''), 120),
      })),
      answer: responseMessage,
      sourceStrategy: answerResult.sourceStrategy,
    })

    if (historyKey) {
      rememberHistoryTurn({
        cacheKey: historyKey,
        input_text: message,
        output_text: responseMessage,
      })
    }

    if (persist && ipAddress) {
      // Analytics storage must never cost the user their answer.
      try {
        await timedStep(logger, 'prompt persisted', () =>
          persistPrompt({
            ipAddress,
            input_text: message,
            output_text: responseMessage,
          }),
        )
      } catch (error) {
        console.error(
          'Failed to persist prompt:',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    logger.done({
      persona: persona.id,
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
      sources: responseSources,
      personaId: persona.id,
      speakerId: persona.speakerId,
    }
  },
}

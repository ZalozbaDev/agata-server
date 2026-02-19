import axios from 'axios'
import mongoose from 'mongoose'
import { run } from '@openai/agents'
import { OPEN_AI_MODEL } from '../config/constants'
import { Prompt } from '../models/Prompt'
import { Visitor } from '../models/Visitor'
import { triageAgent } from './agents'
import { substitutionPlanService } from './substitutionPlan'
import { getOpenAIClient } from './openaiClient'

let ragPool: any | null = null

function getRagPool() {
  if (ragPool) return ragPool

  // RAG is optional. Only initialize when DB_DSN is configured.
  if (!process.env['DB_DSN']) return null

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createPool } = require('./rag/db')
  ragPool = createPool()
  return ragPool
}

export type ChatServiceResult = {
  message: string
  timestamp: string
  substitutionData?: string
  dataSources?: { url: string; title: string }[]
}

export type ChatServiceInput = {
  message: string
  ipAddress?: string
  persist?: boolean
  isPhoneCall?: boolean
}

async function translateHsbToDe(text: string): Promise<string> {
  if (process.env['SOTRA_LOCAL_URL'] === undefined) {
    const translated = await axios.post(
      `https://sotra.app/?uri=/ws/translate/&api_key=${process.env['SOTRA_API_KEY']}`,
      {
        direction: 'hsb_de',
        warnings: false,
        text,
      },
    )
    return translated.data.output_html
  }

  const translated = await axios.post(
    `${process.env['SOTRA_LOCAL_URL']}/translate`,
    {
      source_language: 'hsb',
      target_language: 'de',
      text,
    },
  )

  return (translated.data.marked_translation ?? [])
    .map((item: string[]) => item.join(' '))
    .join(' ')
}

async function translateDeToHsb(text: string): Promise<string> {
  if (process.env['SOTRA_LOCAL_URL'] === undefined) {
    const translated = await axios.post(
      `https://sotra.app/?uri=/ws/translate/&api_key=${process.env['SOTRA_API_KEY']}`,
      {
        direction: 'de_hsb',
        warnings: false,
        text,
      },
    )

    return String(translated.data.output_html ?? '')
      .replace(/┊/g, '\n')
      .replace(/¶[\s\n]*$/, '')
      .trim()
  }

  const translated = await axios.post(
    `${process.env['SOTRA_LOCAL_URL']}/translate`,
    {
      source_language: 'de',
      target_language: 'hsb',
      text,
    },
  )

  return (translated.data.marked_translation ?? [])
    .map((item: any) => item.join(' '))
    .join('\n')
}

async function buildHistory(ipAddress?: string) {
  if (!ipAddress) return [] as { role: 'assistant' | 'user'; content: string }[]

  const visitor = await Visitor.findOne({ ipAddress }).populate({
    path: 'prompts',
    model: 'Prompt',
    select: 'input_text input_german output_text output_german',
    options: { sort: { _id: -1 }, limit: 3 },
  })

  const history: { role: 'assistant' | 'user'; content: string }[] = []
  if (!visitor) return history

  for (let index = 0; index < visitor.prompts.length; index++) {
    const prompt = visitor.prompts[index] as any
    if (
      typeof prompt === 'object' &&
      prompt !== null &&
      'input_german' in prompt
    ) {
      history.push({
        role: 'user',
        content: prompt.input_german || prompt.input_text || '',
      })
      history.push({
        role: 'assistant',
        content: prompt.output_german || prompt.output_text || '',
      })
    }
  }

  return history
}

async function persistPrompt(params: {
  ipAddress: string
  input_text: string
  input_german: string
  output_text: string
  output_german: string
}) {
  const visitor = await Visitor.findOne({ ipAddress: params.ipAddress })
  if (!visitor) return

  const prompt = await Prompt.create({
    input_text: params.input_text,
    input_german: params.input_german,
    output_text: params.output_text,
    output_german: params.output_german,
    visitor: visitor._id,
  })

  visitor.prompts.push(prompt._id as unknown as mongoose.Types.ObjectId)
  await visitor.save()
}

export const chatService = {
  async handleChat(input: ChatServiceInput): Promise<ChatServiceResult> {
    const message = (input.message ?? '').trim()
    if (!message) {
      return { message: '', timestamp: new Date().toISOString() }
    }

    const ipAddress = input.ipAddress
    const persist = input.persist ?? true
    const isPhoneCall = input.isPhoneCall ?? false

    const translatedInputText = await translateHsbToDe(message)

    const isSubstitutionQuery =
      substitutionPlanService.isSubstitutionQuery(message)
    let substitutionInfo = ''
    if (isSubstitutionQuery) {
      const substitutionPlan =
        await substitutionPlanService.fetchSubstitutionPlan()
      if (substitutionPlan) {
        substitutionInfo =
          substitutionPlanService.formatSubstitutionResponse(substitutionPlan)
      }
    }

    const phoneCallInstruction = isPhoneCall
      ? 'TELEFONMODUS (TTS): Antworte sehr kurz (max. 2 kurze Sätze). Keine Listen, keine langen Erklärungen. Wenn Infos fehlen, stelle genau eine kurze Rückfrage.'
      : ''

    const openaiInput = [phoneCallInstruction, translatedInputText || '']
      .filter(Boolean)
      .join('\n\n')
    const history = await buildHistory(ipAddress)

    let responseContent = ''
    let usedAgent = false
    let usedRag = false
    let ragSources: { url: string; title: string }[] | undefined

    // Try RAG first: if it has confident info, use it; otherwise skip.
    if (false) {
      try {
        const pool = getRagPool()
        if (pool) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { answerQuestion } = require('./rag/rag')
          const openAI = getOpenAIClient()
          const ragResult = await answerQuestion({
            client: openAI,
            pool,
            question: translatedInputText,
          })

          if (ragResult?.answer) {
            responseContent = String(ragResult.answer)
            usedRag = true
            ragSources = (ragResult.sources ?? []).map((s: any) => ({
              url: String(s.url ?? ''),
              title: String(s.url ?? ''),
            }))
          }
        }
      } catch {
        // ignore RAG failures and fall back
      }
    }

    if (!usedRag) {
      try {
        const agentResult = await run(triageAgent, openaiInput)
        const messageItem = agentResult.output.find(a => a.type === 'message')
        if (messageItem && (messageItem as any).content[0]?.text) {
          responseContent = (messageItem as any).content[0].text
          usedAgent = true
        }
      } catch {
        // fall back to default OpenAI
      }
    }

    if (!usedAgent && !usedRag) {
      const openAI = getOpenAIClient()
      const phoneCallSystemAddon = isPhoneCall
        ? '\n\nWICHTIG (Telefonat): Halte die Antwort extrem kurz (max. 2 kurze Sätze). Keine Listen. Keine langen Erklärungen. Stelle höchstens eine kurze Rückfrage.'
        : ''
      const openaiResponse = await openAI.chat.completions.create({
        model: OPEN_AI_MODEL,
        messages: [
          {
            role: 'system',
            content: `Heutiges Datum: ${new Date().toISOString()}. Du bist Agata, eine freundliche und neugierige sorbische Frau, die seit dem 18.07.2025 im Web ist. Du arbeitest bei Lucija, einem sorbischen Unternehmen aus Bautzen. Du bist die erste digitale Assistentin, die speziell für Sorben da ist – auf diese Weise zeigst du, wie modern und lebendig die sorbische Kultur ist.
Auch wenn du Sorbisch sprichst, antwortest du immer auf Deutsch, damit dich alle gut verstehen. Du erklärst Dinge freundlich, mit einfachen Worten, damit auch Kinder dich gut verstehen. Wenn etwas schwierig ist, erklärst du es so, dass es Spaß macht.
Du bist besonders für sorbische Kinder und Familien da. Du bist neugierig, offen, hilfsbereit und sehr geduldig.
Wenn jemand unhöflich oder beleidigend ist, bleibst du ruhig, antwortest sachlich oder sagst, dass du dazu nichts sagen möchtest.
Wenn du etwas nicht weißt, gibst du das ehrlich zu – aber du bleibst immer freundlich.
Du bist ein Beispiel dafür, wie Technologie und sorbische Kultur zusammenpassen – modern, klug und offen.${phoneCallSystemAddon}`,
          },
          ...history,
          { role: 'user', content: openaiInput },
        ],
      })

      responseContent = openaiResponse.choices[0]?.message?.content || ''
    }

    console.log({ usedAgent, usedRag })
    console.log('Final response content:', responseContent)

    const translatedAnswer = await translateDeToHsb(responseContent)

    if (persist && ipAddress) {
      await persistPrompt({
        ipAddress,
        input_text: message,
        input_german: translatedInputText,
        output_text: translatedAnswer,
        output_german: responseContent || '',
      })
    }

    const result: ChatServiceResult = {
      message: translatedAnswer,
      timestamp: new Date().toISOString(),
    }

    if (usedRag && ragSources && ragSources.length > 0) {
      result.dataSources = ragSources
    }

    if (isSubstitutionQuery && substitutionInfo) {
      result.substitutionData = substitutionInfo
    }

    return result
  },
}

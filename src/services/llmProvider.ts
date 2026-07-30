import OpenAI from 'openai'
import { chatTimingLog, summarizeText } from '../utils/chatTimingLogger'
import { getOpenAIClient } from './openaiClient'
import {
  completeOllamaChat,
  getLlmProvider,
  getOllamaChatModel,
  type ChatMessage,
} from './ollamaClient'

export type { ChatMessage } from './ollamaClient'

function getOpenAIChatModel(): string {
  return process.env['OPENAI_CHAT_MODEL']?.trim() || 'gpt-5-mini'
}

function summarizeMessages(messages: ChatMessage[]) {
  return messages.map(message => ({
    role: message.role,
    contentChars: message.content.length,
    contentPreview: summarizeText(message.content),
  }))
}

export async function completeChat(
  messages: ChatMessage[],
): Promise<string> {
  const provider = getLlmProvider()
  const model = provider === 'ollama' ? getOllamaChatModel() : getOpenAIChatModel()
  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()

  chatTimingLog(`${timestamp} | llm request | provider=${provider} model=${model}`, {
    messageCount: messages.length,
    messages: summarizeMessages(messages),
  })

  let answer: string
  if (provider === 'ollama') {
    answer = await completeOllamaChat(messages)
  } else {
    const client = getOpenAIClient()
    const response = await client.responses.create({
      model,
      input: messages as OpenAI.Responses.ResponseInput,
    })
    answer = response.output_text.trim()
  }

  const durationMs = Date.now() - startedAt
  const finishedAt = new Date().toISOString()

  chatTimingLog(
    `${finishedAt} | llm response | provider=${provider} model=${model} | ${durationMs}ms`,
    {
      answerChars: answer.length,
      answerPreview: summarizeText(answer),
    },
  )

  return answer
}

export function supportsWebSearch(): boolean {
  return getLlmProvider() === 'openai'
}

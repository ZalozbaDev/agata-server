import OpenAI from 'openai'
import { chatTimingLog, summarizeText } from '../utils/chatTimingLogger'
import { getOpenAIClient } from './openaiClient'
import {
  completeOllamaChat,
  getLlmProvider,
  getOllamaChatModel,
  type ChatCompletionOptions,
  type ChatMessage,
} from './ollamaClient'

export type { ChatCompletionOptions, ChatMessage } from './ollamaClient'

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
  options?: ChatCompletionOptions,
): Promise<string> {
  const provider = getLlmProvider()
  const model = provider === 'ollama' ? getOllamaChatModel() : getOpenAIChatModel()
  const startedAt = Date.now()
  const timestamp = new Date(startedAt).toISOString()

  chatTimingLog(`${timestamp} | llm request | provider=${provider} model=${model}`, {
    messageCount: messages.length,
    hasFormat: options?.format !== undefined,
    messages: summarizeMessages(messages),
  })

  let answer: string
  try {
    if (provider === 'ollama') {
      answer = await completeOllamaChat(messages, options)
    } else {
      const client = getOpenAIClient()
      const response = await client.responses.create({
        model,
        input: messages as OpenAI.Responses.ResponseInput,
        ...(options?.format
          ? {
              text: {
                format: {
                  type: 'json_schema',
                  name: 'ollama_answer',
                  schema: options.format as Record<string, unknown>,
                  strict: true,
                },
              },
            }
          : {}),
      })
      answer = response.output_text.trim()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`LLM request failed: ${message}`)
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

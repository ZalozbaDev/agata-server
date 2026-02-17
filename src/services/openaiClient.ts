import OpenAI from 'openai'

let client: OpenAI | null = null

export function getOpenAIClient(): OpenAI {
  if (client) return client

  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing')
  }

  client = new OpenAI({ apiKey })
  return client
}

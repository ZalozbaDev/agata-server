const OpenAI = require('openai')

function getEnv(name, fallback = undefined) {
  const v = process.env[name]
  if (v === undefined || String(v).trim() === '') return fallback
  return String(v)
}

function createClient() {
  const apiKey = getEnv('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')
  return new OpenAI({ apiKey })
}

function toEmbeddingVectorLiteral(vec) {
  // pgvector input format: '[0.1,0.2,...]'
  // Ensure finite numbers.
  const parts = vec.map(x => {
    const n = Number(x)
    if (!Number.isFinite(n)) throw new Error('Non-finite embedding value')
    return n.toString()
  })
  return `[${parts.join(',')}]`
}

async function embedText(client, text) {
  const model = getEnv('EMBED_MODEL', 'text-embedding-3-small')
  const resp = await client.embeddings.create({ model, input: text })
  const vec = resp.data?.[0]?.embedding
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error(
      `Embedding dim mismatch; expected 1536, got ${Array.isArray(vec) ? vec.length : 'n/a'}`,
    )
  }
  return vec
}

async function chatAnswer(client, { context, question }) {
  const model = getEnv('CHAT_MODEL', 'gpt-5-mini')
  const { systemPrompt } = require('./prompt')

  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        'KONTEXT:',
        context,
        '\nFRAGE:',
        question,
        '\nANTWORT:', // force direct answer
      ].join('\n'),
    },
  ]

  const resp = await client.chat.completions.create({
    model,
    messages,
    // temperature: 0.2,
  })

  const text = resp.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty chat response')
  return String(text).trim()
}

module.exports = {
  createClient,
  embedText,
  chatAnswer,
  toEmbeddingVectorLiteral,
}

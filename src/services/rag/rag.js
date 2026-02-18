function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.max(min, Math.min(max, i))
}

function extractKeywords(question) {
  const q = String(question || '')
  const raw = q
    .replace(/[\u2010-\u2015]/g, '-')
    .split(/[^\p{L}\p{N}:+-]+/u)
    .map(w => w.trim())
    .filter(w => w.length >= 3)

  const stop = new Set([
    'und',
    'oder',
    'der',
    'die',
    'das',
    'ein',
    'eine',
    'einer',
    'einem',
    'einen',
    'mit',
    'für',
    'von',
    'auf',
    'im',
    'in',
    'am',
    'an',
    'zu',
    'ist',
    'sind',
    'war',
    'wann',
    'wo',
    'was',
    'wie',
  ])

  const intentWords = new Set([
    'sonntag',
    'montag',
    'dienstag',
    'mittwoch',
    'donnerstag',
    'freitag',
    'samstag',
    'messe',
    'messen',
    'andacht',
    'gottesdienst',
    'gottesdienste',
    'uhr',
    'uhrzeit',
    'termin',
    'termine',
  ])

  const uniq = []
  const seen = new Set()
  for (const w of raw) {
    const lw = w.toLowerCase()
    if (stop.has(lw)) continue
    if (seen.has(lw)) continue
    seen.add(lw)
    uniq.push(w)
  }

  const hasUpper = w => /[A-ZÄÖÜ]/.test(w)
  const isTimeish = w =>
    /\d{1,2}[:.]\d{2}/.test(w) || /\d{1,2}(?:[:.]\d{2})?uhr/i.test(w)

  // Deterministic selection:
  // 1) strong proper nouns (capitalized) and explicit times
  // 2) schedule intent words (Sonntag, Messe, ...)
  // 3) remaining tokens
  const proper = []
  const timeish = []
  const intent = []
  const rest = []

  for (const w of uniq) {
    const lw = w.toLowerCase()
    if (isTimeish(w)) {
      timeish.push(w)
      continue
    }
    if (hasUpper(w) && !intentWords.has(lw)) {
      proper.push(w)
      continue
    }
    if (intentWords.has(lw)) {
      intent.push(w)
      continue
    }
    rest.push(w)
  }

  const picked = []
  const pickFrom = arr => {
    for (const w of arr) {
      if (picked.length >= 3) break
      if (picked.includes(w)) continue
      picked.push(w)
    }
  }

  pickFrom(proper)
  pickFrom(timeish)
  pickFrom(intent)
  pickFrom(rest)

  return picked.slice(0, 3)
}

function buildContext(rows) {
  const parts = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const snippet = String(r.text || '').slice(0, 900)
    parts.push(`SOURCE ${i + 1}: ${r.url}\n${snippet}`)
  }
  return parts.join('\n\n---\n\n')
}

function uniqueSourcesByBestScore(rows) {
  const best = new Map()
  for (const r of rows) {
    const prev = best.get(r.url)
    const s = Number.isFinite(r.finalScore) ? r.finalScore : r.score
    if (!prev || s > prev.score) best.set(r.url, { url: r.url, score: s })
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score)
}

async function answerQuestion({ client, pool, question, topK, sourcesFilter }) {
  const {
    embedText,
    chatAnswer,
    toEmbeddingVectorLiteral,
  } = require('./openai')
  const { vectorSearch } = require('./db')

  const q = String(question || '').trim()
  if (!q) throw new Error('question is required')

  const effectiveTopK = clampInt(
    topK,
    Number(process.env.DEFAULT_TOPK || 8),
    1,
    50,
  )

  const qEmbedding = await embedText(client, q)
  const vecLiteral = toEmbeddingVectorLiteral(qEmbedding)

  const keywords = extractKeywords(q)

  const rows = await vectorSearch(pool, {
    queryVectorLiteral: vecLiteral,
    topK: effectiveTopK,
    sourcesFilter,
    keywords,
  })

  const minFinalScoreRaw = process.env.RAG_MIN_FINAL_SCORE
  const minFinalScore = Number.isFinite(Number(minFinalScoreRaw))
    ? Number(minFinalScoreRaw)
    : 0.6

  if (!rows || rows.length === 0) return null

  const bestFinalScore = rows.reduce((best, r) => {
    const s = Number.isFinite(r?.finalScore)
      ? r.finalScore
      : Number.isFinite(r?.score)
        ? r.score
        : 0
    return Math.max(best, s)
  }, -Infinity)

  if (!Number.isFinite(bestFinalScore) || bestFinalScore < minFinalScore) {
    if (process.env.RAG_DEBUG === 'true') {
      console.log(
        '[RAG_DEBUG] skipping: bestFinalScore=',
        bestFinalScore,
        'minFinalScore=',
        minFinalScore,
      )
    }
    return null
  }

  const context = buildContext(rows)

  if (process.env.RAG_DEBUG === 'true') {
    console.log('[RAG_DEBUG] keywords=', keywords)
    console.log(
      '[RAG_DEBUG] topK=',
      rows.map(r => ({
        url: r.url,
        finalScore: r.finalScore,
        score: r.score,
        boost: r.boost,
      })),
    )
    console.log(
      '[RAG_DEBUG] context preview=',
      String(context || '').slice(0, 300),
    )
  }

  const answer = await chatAnswer(client, {
    context: context || '(kein Kontext gefunden)',
    question: q,
  })

  return {
    answer,
    sources: uniqueSourcesByBestScore(rows),
  }
}

module.exports = { answerQuestion, extractKeywords, buildContext }

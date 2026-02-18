const { Pool } = require('pg')

function getEnv(name, fallback = undefined) {
  const v = process.env[name]
  if (v === undefined || String(v).trim() === '') return fallback
  return String(v)
}

function createPool() {
  const connectionString = getEnv('DB_DSN')
  if (!connectionString) throw new Error('DB_DSN is required')
  return new Pool({ connectionString })
}

function buildSourcesFilterClause(prefixes, params) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    return { clause: '', params }
  }

  const cleaned = prefixes
    .map(s => String(s || '').trim())
    .filter(s => s.length > 0)

  if (cleaned.length === 0) return { clause: '', params }

  const parts = cleaned.map(p => {
    params.push(p + '%')
    return `d.url LIKE $${params.length}`
  })

  return { clause: ` AND (${parts.join(' OR ')})`, params }
}

async function health(pool) {
  const r = await pool.query('SELECT 1 AS ok')
  return r.rows?.[0]?.ok === 1
}

async function vectorSearch(
  pool,
  { queryVectorLiteral, topK, sourcesFilter, keywords },
) {
  // cosine distance operator: <=>
  // similarity score = 1 - cosine_distance
  // Hybrid ordering: distance - boost (lower is better)

  const kw = Array.isArray(keywords) ? keywords : []
  const kw1 = String(kw[0] || '')
  const kw2 = String(kw[1] || '')
  const kw3 = String(kw[2] || '')

  const params = []
  const p = v => {
    params.push(v)
    return `$${params.length}`
  }

  const vecP = p(queryVectorLiteral)
  const kw1P = p(kw1)
  const kw2P = p(kw2)
  const kw3P = p(kw3)
  const limitP = p(topK)

  const boostExpr = `(
    (CASE WHEN ${kw1P} <> '' AND c.text ILIKE '%'||${kw1P}||'%' THEN 0.18 ELSE 0 END) +
    (CASE WHEN ${kw2P} <> '' AND c.text ILIKE '%'||${kw2P}||'%' THEN 0.12 ELSE 0 END) +
    (CASE WHEN ${kw3P} <> '' AND c.text ILIKE '%'||${kw3P}||'%' THEN 0.08 ELSE 0 END)
  )`

  let innerSql = `
    SELECT
      d.url AS url,
      c.text AS text,
      c.meta AS meta,
      (c.embedding <=> ${vecP}::vector) AS distance,
      (1 - (c.embedding <=> ${vecP}::vector)) AS score,
      ${boostExpr} AS boost
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'active'
  `

  const built = buildSourcesFilterClause(sourcesFilter, params)
  innerSql += built.clause

  const sql = `
    SELECT *
    FROM (
      ${innerSql}
    ) t
    ORDER BY (t.distance - t.boost)
    LIMIT ${limitP}
  `

  const res = await pool.query(sql, params)
  return res.rows.map(r => {
    const score = Number(r.score)
    const boost = Number(r.boost)
    return {
      url: r.url,
      text: r.text,
      meta: r.meta,
      distance: Number(r.distance),
      score,
      boost,
      finalScore: score + boost,
    }
  })
}

async function keywordSearch(pool, { topK, sourcesFilter, keywords }) {
  const kw = Array.isArray(keywords) ? keywords : []
  const kw1 = String(kw[0] || '')
  const kw2 = String(kw[1] || '')
  const kw3 = String(kw[2] || '')

  const params = []
  const p = v => {
    params.push(v)
    return `$${params.length}`
  }

  const kw1P = p(kw1)
  const kw2P = p(kw2)
  const kw3P = p(kw3)
  const limitP = p(topK)

  let sql = `
    SELECT
      d.url AS url,
      c.text AS text,
      c.meta AS meta,
      (
        (CASE WHEN ${kw1P} <> '' AND c.text ILIKE '%'||${kw1P}||'%' THEN 1.0 ELSE 0 END) +
        (CASE WHEN ${kw2P} <> '' AND c.text ILIKE '%'||${kw2P}||'%' THEN 0.7 ELSE 0 END) +
        (CASE WHEN ${kw3P} <> '' AND c.text ILIKE '%'||${kw3P}||'%' THEN 0.4 ELSE 0 END)
      ) AS boost
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'active'
  `

  const built = buildSourcesFilterClause(sourcesFilter, params)
  sql += built.clause

  sql += `
    ORDER BY boost DESC
    LIMIT ${limitP}
  `

  const res = await pool.query(sql, params)
  return res.rows.map(r => ({
    url: r.url,
    text: r.text,
    meta: r.meta,
    boost: Number(r.boost),
  }))
}

module.exports = { createPool, health, vectorSearch, keywordSearch }

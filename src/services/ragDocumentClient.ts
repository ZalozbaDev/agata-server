import { Blob } from 'buffer'
import { HttpError, isPersonaCollectionName } from './personaPolicy'

export type IndexedPersonaDocument = {
  sourceId: string
  collection: string
  sectionCount: number
  chunkCount: number
  filename: string
}

function ragBaseUrl(): string {
  const raw = process.env['RAG_SERVER_URL']?.trim()
  if (!raw) {
    throw new HttpError(503, 'RAG_SERVER_URL ist nicht gesetzt.')
  }
  return raw.replace(/\/$/, '')
}

async function readRagError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 300)
  } catch {
    return ''
  }
  return ''
}

function germanRagDetail(status: number, detail: string): string {
  const text = detail.toLowerCase()
  if (status === 422 || text.includes('no indexable')) {
    return 'Das Dokument enthält keinen verwertbaren Text.'
  }
  if (text.includes('unsupported file')) {
    return 'Nur PDF- und HTML-Dateien können hochgeladen werden.'
  }
  if (text.includes('exceeds 20') || text.includes('20 mb')) {
    return 'Die Datei ist größer als 20 MB.'
  }
  if (text.includes('empty file')) return 'Die Datei ist leer.'
  if (text.includes('exactly one file') || text.includes('missing')) {
    return 'Es wurde keine gültige Datei übergeben.'
  }
  return ''
}

function mapRagStatus(status: number, detail: string, fallback: string): HttpError {
  const translated = germanRagDetail(status, detail)
  if (status === 400 || status === 422) {
    return new HttpError(status, translated || fallback)
  }
  if (status === 504) return new HttpError(504, 'Der RAG-Server hat nicht rechtzeitig geantwortet.')
  return new HttpError(502, detail || 'Der RAG-Server konnte die Anfrage nicht ausführen.')
}

async function ragFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Der RAG-Server hat nicht rechtzeitig geantwortet.')
    }
    throw new HttpError(502, 'Der RAG-Server ist nicht erreichbar.')
  } finally {
    clearTimeout(timeout)
  }
}

export async function indexPersonaDocument(params: {
  collection: string
  filename: string
  mimeType: string
  buffer: Buffer
}): Promise<IndexedPersonaDocument> {
  if (!isPersonaCollectionName(params.collection)) {
    throw new HttpError(400, 'Ungültige Persona-Collection.')
  }

  const form = new FormData()
  const bytes = new Uint8Array(
    params.buffer.buffer,
    params.buffer.byteOffset,
    params.buffer.byteLength,
  )
  form.append('file', new Blob([bytes], { type: params.mimeType }), params.filename)
  form.append('collection', params.collection)
  form.append('min_chars', '40')

  const response = await ragFetch(
    `${ragBaseUrl()}/documents`,
    { method: 'POST', body: form },
    120_000,
  )

  if (!response.ok) {
    const detail = await readRagError(response)
    throw mapRagStatus(
      response.status,
      detail,
      'Das Dokument konnte nicht indexiert werden.',
    )
  }

  const data = (await response.json()) as Partial<IndexedPersonaDocument> & {
    source_id?: string
    section_count?: number
    chunk_count?: number
  }
  const sourceId = String(data.source_id ?? data.sourceId ?? '').trim()
  const collection = String(data.collection ?? '').trim()
  if (!sourceId || collection !== params.collection) {
    throw new HttpError(502, 'Der RAG-Server hat eine unvollständige Antwort geliefert.')
  }

  return {
    sourceId,
    collection,
    sectionCount: Number(data.section_count ?? data.sectionCount ?? 0),
    chunkCount: Number(data.chunk_count ?? data.chunkCount ?? 0),
    filename: String(data.filename ?? params.filename),
  }
}

export async function deletePersonaSource(
  collection: string,
  sourceId: string,
): Promise<void> {
  if (!isPersonaCollectionName(collection)) {
    throw new HttpError(400, 'Ungültige Persona-Collection.')
  }
  const response = await ragFetch(
    `${ragBaseUrl()}/documents`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection, source_id: sourceId }),
    },
    30_000,
  )
  if (!response.ok) {
    const detail = await readRagError(response)
    throw mapRagStatus(response.status, detail, 'Die RAG-Einträge konnten nicht gelöscht werden.')
  }
}

export async function deletePersonaCollection(collection: string): Promise<void> {
  if (!isPersonaCollectionName(collection)) {
    throw new HttpError(400, 'Ungültige Persona-Collection.')
  }
  const response = await ragFetch(
    `${ragBaseUrl()}/collections/${encodeURIComponent(collection)}`,
    { method: 'DELETE' },
    30_000,
  )
  if (!response.ok) {
    const detail = await readRagError(response)
    throw mapRagStatus(
      response.status,
      detail,
      'Die Persona-Collection konnte nicht gelöscht werden.',
    )
  }
}

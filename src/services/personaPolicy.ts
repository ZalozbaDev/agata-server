import { randomBytes, timingSafeEqual } from 'crypto'
import {
  DEFAULT_PERSONA_ID,
  SIP_PERSONA_ID,
  type Persona,
  type PersonaDocumentLanguage,
} from '../config/personas'

export type PersonaVisibility = 'public' | 'private'
export type PersonaActor = 'admin' | 'token'

/** Short webview key: `schule`, `kindergarten`, `spielplatz`. */
export const PERSONA_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
export function isSystemPersonaSlug(value: string | undefined | null): boolean {
  const slug = String(value ?? '').trim().toLowerCase()
  return slug === DEFAULT_PERSONA_ID || slug === SIP_PERSONA_ID
}
export const MANAGED_PERSONA_ID_PATTERN = /^[a-f0-9]{24}$/
export const MAX_PROMPT_LENGTH = 20_000
export const MAX_NAME_LENGTH = 120
export const MAX_TAG_LENGTH = 80
export const MIN_TOP_K = 1
export const MAX_TOP_K = 50
export const MIN_WEB_RESULTS = 0
export const MAX_WEB_RESULTS = 20
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_DOCUMENTS_PER_PERSONA = 100

const FALLBACK_PROMPT =
  'Du bist eine sachliche Auskunfts-Assistentin und antwortest ausschließlich auf Basis der hinterlegten Dokumente.'

export class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

export class PersonaAccessError extends HttpError {
  constructor(message = 'Diese Persona ist privat.') {
    super(403, message)
    this.name = 'PersonaAccessError'
  }
}

export type PersonaWriteInput = {
  name?: unknown
  slug?: unknown
  prompt?: unknown
  language?: unknown
  topK?: unknown
  webResultCount?: unknown
  tag?: unknown
  visibility?: unknown
  allowExternalDelete?: unknown
}

export type NormalizedPersona = {
  name: string
  slug: string
  prompt: string
  language: PersonaDocumentLanguage
  topK: number
  webResultCount: number
  tag: string
  visibility: PersonaVisibility
  allowExternalDelete: boolean
}

export function generatePersonaToken(): string {
  return randomBytes(32).toString('base64url')
}

export function isManagedPersonaId(value: string | undefined | null): boolean {
  return MANAGED_PERSONA_ID_PATTERN.test(String(value ?? '').trim().toLowerCase())
}

export function collectionNameForPersona(personaId: string): string {
  const id = String(personaId ?? '').trim().toLowerCase()
  if (!MANAGED_PERSONA_ID_PATTERN.test(id)) {
    throw new HttpError(400, 'Ungültige Persona-ID.')
  }
  return `persona_${id}`
}

export function isPersonaCollectionName(name: string): boolean {
  return /^persona_[a-f0-9]{24}$/.test(name)
}

export function scopedDocumentQuery(
  personaId: string,
  documentId?: string,
): { personaId: string; _id?: string } {
  const id = String(personaId ?? '').trim().toLowerCase()
  if (!isManagedPersonaId(id)) {
    throw new HttpError(400, 'Ungültige Persona-ID.')
  }
  if (documentId === undefined) return { personaId: id }
  const docId = String(documentId).trim().toLowerCase()
  if (!isManagedPersonaId(docId)) {
    throw new HttpError(400, 'Ungültige Dokument-ID.')
  }
  return { personaId: id, _id: docId }
}

export function canViewDocuments(
  visibility: PersonaVisibility,
  actor: PersonaActor,
): boolean {
  return actor === 'admin' || visibility === 'public'
}

export function canUploadDocuments(
  visibility: PersonaVisibility,
  actor: PersonaActor,
): boolean {
  return actor === 'admin' || visibility === 'public'
}

export function canDeleteDocuments(
  visibility: PersonaVisibility,
  allowExternalDelete: boolean,
  actor: PersonaActor,
): boolean {
  if (actor === 'admin') return true
  return visibility === 'public' && allowExternalDelete
}

export function assertTokenDocumentAccess(params: {
  visibility: PersonaVisibility
  allowExternalDelete: boolean
  action: 'view' | 'upload' | 'delete'
}): void {
  const allowed =
    params.action === 'delete'
      ? canDeleteDocuments(
          params.visibility,
          params.allowExternalDelete,
          'token',
        )
      : params.action === 'upload'
        ? canUploadDocuments(params.visibility, 'token')
        : canViewDocuments(params.visibility, 'token')

  if (!allowed) {
    throw new PersonaAccessError(
      params.visibility === 'private'
        ? 'Diese Persona ist privat.'
        : 'Löschen ist für diese Persona nicht freigegeben.',
    )
  }
}

export function assertManagedPersonaChatAccess(
  visibility: PersonaVisibility,
  allowPrivate: boolean,
): void {
  if (visibility === 'private' && !allowPrivate) {
    throw new PersonaAccessError('Diese Persona ist privat.')
  }
}

export function tokenGrantsAccess(storedToken: string, presentedToken: string): boolean {
  const stored = Buffer.from(storedToken)
  const presented = Buffer.from(presentedToken)
  if (stored.length !== presented.length || stored.length === 0) return false
  return timingSafeEqual(stored, presented)
}

export function chatHistoryKey(personaId: string, ipAddress: string): string {
  return `${personaId}::${ipAddress}`
}

function duplicateKeyField(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; keyPattern?: Record<string, unknown> }
  if (candidate.code !== 11000) return null
  const field = candidate.keyPattern ? Object.keys(candidate.keyPattern)[0] : undefined
  return field ?? 'token'
}

export function isDuplicateTokenError(error: unknown): boolean {
  return duplicateKeyField(error) === 'token'
}

export function isDuplicateSlugError(error: unknown): boolean {
  return duplicateKeyField(error) === 'slug'
}

export function normalizePersonaSlug(value: string): string {
  return value.trim().toLowerCase()
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'dokument'
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').trim()
  return (cleaned || 'dokument').slice(0, 180)
}

export function classifyUpload(
  filename: string,
  mimeType: string,
): { kind: 'pdf' | 'html'; mimeType: string } {
  const loweredName = filename.toLowerCase()
  const loweredType = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const isPdf =
    loweredName.endsWith('.pdf') ||
    loweredType === 'application/pdf' ||
    loweredType === 'application/x-pdf'
  const isHtml =
    loweredName.endsWith('.html') ||
    loweredName.endsWith('.htm') ||
    loweredType === 'text/html' ||
    loweredType === 'application/xhtml+xml'

  if (isPdf && !loweredName.endsWith('.html') && !loweredName.endsWith('.htm')) {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  if (isHtml && !isPdf) {
    return { kind: 'html', mimeType: 'text/html' }
  }
  throw new HttpError(
    400,
    'Nur PDF- und HTML-Dateien können hochgeladen werden.',
  )
}

const PERSONA_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

export function classifyPersonaImage(filename: string, mimeType: string): string {
  const type = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const name = filename.toLowerCase()
  const fromName = name.endsWith('.png')
    ? 'image/png'
    : name.endsWith('.webp')
      ? 'image/webp'
      : name.endsWith('.gif')
        ? 'image/gif'
        : name.endsWith('.jpg') || name.endsWith('.jpeg')
          ? 'image/jpeg'
          : ''
  const mime = PERSONA_IMAGE_TYPES.has(type) ? type : fromName
  if (!mime) {
    throw new HttpError(400, 'Das Bild muss PNG, JPEG, WebP oder GIF sein.')
  }
  return mime
}

export function toRuntimePersona(persona: {
  id: string
  /** Mongo id that owns the Qdrant collection. Defaults to `id`. */
  collectionId?: string
  /** Fixed collection such as the shared `documents` index. */
  collection?: string
  name: string
  prompt: string
  topK: number
  webResultCount?: number
  webFallbackResultCount?: number
  documentLanguage?: PersonaDocumentLanguage
  allowGeneralKnowledge?: boolean
}): Persona {
  const prompt = persona.prompt.trim()
  const webResultCount = normalizeWebResultCount(persona.webResultCount)
  const webFallback =
    persona.webFallbackResultCount === undefined
      ? webResultCount
      : normalizeWebResultCount(persona.webFallbackResultCount)
  const namedCollection = persona.collection?.trim()
  return {
    id: persona.id,
    label: persona.name,
    collection:
      namedCollection ||
      collectionNameForPersona(persona.collectionId ?? persona.id),
    ragTopK: persona.topK,
    webResultCount,
    webFallbackResultCount: webFallback,
    language: 'auto',
    ...(persona.documentLanguage
      ? { documentLanguage: persona.documentLanguage }
      : {}),
    description: prompt || FALLBACK_PROMPT,
    allowGeneralKnowledge: persona.allowGeneralKnowledge === true,
  }
}

export type PublicPersonaView = {
  name: string
  tag: string
  language: PersonaDocumentLanguage | null
  visibility: 'public'
  canUpload: boolean
  canDelete: boolean
  documentCount: number
}

export function toPublicPersonaView(persona: {
  name: string
  tag: string
  language?: PersonaDocumentLanguage | null
  allowExternalDelete: boolean
  documentCount: number
}): PublicPersonaView {
  return {
    name: persona.name,
    tag: persona.tag,
    language: persona.language ?? null,
    visibility: 'public',
    canUpload: true,
    canDelete: persona.allowExternalDelete,
    documentCount: persona.documentCount,
  }
}

export function readDocumentLanguage(
  value: unknown,
  required: boolean,
): PersonaDocumentLanguage | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'Die Sprache ist ein Pflichtfeld.')
    return undefined
  }
  if (value !== 'de' && value !== 'hsb' && value !== 'dsb') {
    throw new HttpError(
      400,
      'Sprache muss Deutsch, Obersorbisch oder Niedersorbisch sein.',
    )
  }
  return value
}

function readString(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${label} ist ein Pflichtfeld.`)
    return ''
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} muss ein Text sein.`)
  }
  const trimmed = value.trim()
  if (required && !trimmed) throw new HttpError(400, `${label} ist ein Pflichtfeld.`)
  if (trimmed.length > max) {
    throw new HttpError(400, `${label} darf höchstens ${max} Zeichen haben.`)
  }
  return trimmed
}

function normalizeWebResultCount(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) return MIN_WEB_RESULTS
  return Math.min(MAX_WEB_RESULTS, Math.max(MIN_WEB_RESULTS, value))
}

function readWebResultCount(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HttpError(400, 'Die Anzahl der Web-Ergebnisse ist ein Pflichtfeld.')
    }
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_WEB_RESULTS ||
    parsed > MAX_WEB_RESULTS
  ) {
    throw new HttpError(
      400,
      `Web-Ergebnisse müssen eine ganze Zahl zwischen ${MIN_WEB_RESULTS} und ${MAX_WEB_RESULTS} sein.`,
    )
  }
  return parsed
}

function readTopK(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HttpError(400, 'Die Anzahl der RAG-Ergebnisse ist ein Pflichtfeld.')
    }
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(parsed) || parsed < MIN_TOP_K || parsed > MAX_TOP_K) {
    throw new HttpError(
      400,
      `RAG-Ergebnisse müssen eine ganze Zahl zwischen ${MIN_TOP_K} und ${MAX_TOP_K} sein.`,
    )
  }
  return parsed
}

function readVisibility(value: unknown, required: boolean): PersonaVisibility | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) return 'private'
    return undefined
  }
  if (value !== 'public' && value !== 'private') {
    throw new HttpError(400, 'Sichtbarkeit muss public oder private sein.')
  }
  return value
}

function readBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${label} muss true oder false sein.`)
  }
  return value
}

function readSlug(
  value: unknown,
  required: boolean,
  allowSystemSlug = false,
): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw new HttpError(400, 'Der Kurzname ist ein Pflichtfeld.')
    return undefined
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Der Kurzname muss ein Text sein.')
  }
  const slug = normalizePersonaSlug(value)
  if (!PERSONA_SLUG_PATTERN.test(slug)) {
    throw new HttpError(
      400,
      'Der Kurzname muss 2 bis 32 Zeichen haben und darf nur Buchstaben, Ziffern und Bindestriche enthalten.',
    )
  }
  if (!allowSystemSlug && isSystemPersonaSlug(slug)) {
    throw new HttpError(400, 'Dieser Kurzname ist für eine feste Persona reserviert.')
  }
  return slug
}

export function parseCreatePersona(input: PersonaWriteInput): NormalizedPersona {
  const visibility = readVisibility(input.visibility, true) ?? 'private'
  const topK = readTopK(input.topK, true)
  if (topK === undefined) {
    throw new HttpError(400, 'Die Anzahl der RAG-Ergebnisse ist ein Pflichtfeld.')
  }
  const slug = readSlug(input.slug, true)
  if (!slug) throw new HttpError(400, 'Der Kurzname ist ein Pflichtfeld.')
  const language = readDocumentLanguage(input.language, true)
  if (!language) throw new HttpError(400, 'Die Sprache ist ein Pflichtfeld.')
  return {
    name: readString(input.name, 'Name', MAX_NAME_LENGTH, true),
    slug,
    prompt: readString(input.prompt, 'Prompt', MAX_PROMPT_LENGTH, false),
    language,
    topK,
    webResultCount: readWebResultCount(input.webResultCount, false) ?? MIN_WEB_RESULTS,
    tag: readString(input.tag, 'Tag', MAX_TAG_LENGTH, false),
    visibility,
    allowExternalDelete: readBoolean(input.allowExternalDelete, 'Externes Löschen') ?? false,
  }
}

export function parseUpdatePersona(
  input: PersonaWriteInput,
): Partial<NormalizedPersona> {
  const next: Partial<NormalizedPersona> = {}
  if ('name' in input) next.name = readString(input.name, 'Name', MAX_NAME_LENGTH, true)
  if ('slug' in input) {
    const slug = readSlug(input.slug, true, true)
    if (!slug) throw new HttpError(400, 'Der Kurzname darf nicht leer sein.')
    next.slug = slug
  }
  if ('prompt' in input) {
    next.prompt = readString(input.prompt, 'Prompt', MAX_PROMPT_LENGTH, false)
  }
  if ('topK' in input) {
    const topK = readTopK(input.topK, true)
    if (topK === undefined) {
      throw new HttpError(400, 'Die Anzahl der RAG-Ergebnisse ist ein Pflichtfeld.')
    }
    next.topK = topK
  }
  if ('webResultCount' in input) {
    const webResultCount = readWebResultCount(input.webResultCount, true)
    if (webResultCount === undefined) {
      throw new HttpError(400, 'Die Anzahl der Web-Ergebnisse ist ein Pflichtfeld.')
    }
    next.webResultCount = webResultCount
  }
  if ('tag' in input) next.tag = readString(input.tag, 'Tag', MAX_TAG_LENGTH, false)
  if ('visibility' in input) {
    const visibility = readVisibility(input.visibility, true)
    if (visibility) next.visibility = visibility
  }
  if ('allowExternalDelete' in input) {
    const allow = readBoolean(input.allowExternalDelete, 'Externes Löschen')
    if (allow === undefined) {
      throw new HttpError(400, 'Externes Löschen muss true oder false sein.')
    }
    next.allowExternalDelete = allow
  }
  if (Object.keys(next).length === 0) {
    throw new HttpError(400, 'Es wurden keine Änderungen übergeben.')
  }
  return next
}

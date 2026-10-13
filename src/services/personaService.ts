import { Types } from 'mongoose'
import type { Persona } from '../config/personas'
import { isKnownPersona, resolvePersona } from '../config/personas'
import { Persona as PersonaModel, type IPersona } from '../models/Persona'
import {
  PersonaDocument,
  type IPersonaDocument,
} from '../models/PersonaDocument'
import {
  deletePersonaCollection,
  deletePersonaSource,
  indexPersonaDocument,
} from './ragDocumentClient'
import { deleteStoredFile, saveStoredFile } from './personaFileStore'
import {
  HttpError,
  MAX_DOCUMENTS_PER_PERSONA,
  MAX_UPLOAD_BYTES,
  type NormalizedPersona,
  type PersonaWriteInput,
  type PublicPersonaView,
  assertManagedPersonaChatAccess,
  assertTokenDocumentAccess,
  classifyUpload,
  collectionNameForPersona,
  generatePersonaToken,
  isDuplicateSlugError,
  isDuplicateTokenError,
  isManagedPersonaId,
  normalizePersonaSlug,
  parseCreatePersona,
  PERSONA_SLUG_PATTERN,
  parseUpdatePersona,
  sanitizeFilename,
  scopedDocumentQuery,
  toPublicPersonaView,
  toRuntimePersona,
  tokenGrantsAccess,
} from './personaPolicy'

export type AdminPersonaDto = {
  id: string
  name: string
  slug: string
  prompt: string
  token: string
  topK: number
  webResultCount: number
  tag: string
  visibility: 'public' | 'private'
  allowExternalDelete: boolean
  documentCount: number
  createdAt: string
  updatedAt: string
}

export type PersonaDocumentDto = {
  id: string
  filename: string
  mimeType: string
  size: number
  uploadedAt: string
}

export type UploadedFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

function iso(value: Date | undefined): string {
  return value ? value.toISOString() : new Date(0).toISOString()
}

function idOf(value: { _id: unknown }): string {
  return String(value._id)
}

function toAdminDto(persona: IPersona, documentCount: number): AdminPersonaDto {
  return {
    id: idOf(persona),
    name: persona.name,
    slug: persona.slug ?? '',
    prompt: persona.prompt ?? '',
    token: persona.token,
    topK: persona.topK,
    webResultCount: persona.webResultCount ?? 0,
    tag: persona.tag ?? '',
    visibility: persona.visibility,
    allowExternalDelete: persona.allowExternalDelete,
    documentCount,
    createdAt: iso(persona.createdAt),
    updatedAt: iso(persona.updatedAt),
  }
}

function toDocumentDto(document: IPersonaDocument): PersonaDocumentDto {
  return {
    id: idOf(document),
    filename: document.filename,
    mimeType: document.mimeType,
    size: document.size,
    uploadedAt: iso(document.createdAt),
  }
}

async function documentCounts(
  personaIds: string[],
): Promise<Map<string, number>> {
  if (personaIds.length === 0) return new Map()
  const rows = await PersonaDocument.aggregate<{ _id: { toString(): string }; count: number }>([
    {
      $match: {
        personaId: { $in: personaIds.map(id => new Types.ObjectId(id)) },
      },
    },
    { $group: { _id: '$personaId', count: { $sum: 1 } } },
  ])
  return new Map(rows.map(row => [String(row._id), row.count]))
}

async function countFor(personaId: string): Promise<number> {
  return PersonaDocument.countDocuments(scopedDocumentQuery(personaId))
}

async function requirePersona(id: string): Promise<IPersona> {
  if (!isManagedPersonaId(id)) throw new HttpError(400, 'Ungültige Persona-ID.')
  const persona = await PersonaModel.findById(id)
  if (!persona) throw new HttpError(404, 'Persona nicht gefunden.')
  return persona
}

async function requirePersonaByToken(token: string): Promise<IPersona> {
  const presented = token.trim()
  if (!presented) throw new HttpError(404, 'Persona nicht gefunden.')
  const persona = await PersonaModel.findOne({ token: presented })
  if (!persona || !tokenGrantsAccess(persona.token, presented)) {
    throw new HttpError(404, 'Persona nicht gefunden oder der Link ist ungültig.')
  }
  return persona
}

function rethrowDuplicate(error: unknown): never {
  if (isDuplicateSlugError(error)) {
    throw new HttpError(409, 'Dieser Kurzname ist bereits vergeben.')
  }
  if (isDuplicateTokenError(error)) {
    throw new HttpError(409, 'Dieser Token ist bereits vergeben.')
  }
  throw error
}

async function savePersona(persona: IPersona): Promise<IPersona> {
  try {
    return await persona.save()
  } catch (error) {
    rethrowDuplicate(error)
  }
}

function applyNormalized(
  persona: IPersona,
  next: Partial<NormalizedPersona>,
  generatedToken: string | null,
): void {
  if (next.name !== undefined) persona.name = next.name
  if (next.slug !== undefined) persona.slug = next.slug
  if (next.prompt !== undefined) persona.prompt = next.prompt
  if (next.topK !== undefined) persona.topK = next.topK
  if (next.webResultCount !== undefined) persona.webResultCount = next.webResultCount
  if (next.tag !== undefined) persona.tag = next.tag
  if (next.visibility !== undefined) persona.visibility = next.visibility
  if (next.allowExternalDelete !== undefined) {
    persona.allowExternalDelete = next.allowExternalDelete
  }
  if (generatedToken) persona.token = generatedToken
  else if (typeof next.token === 'string') persona.token = next.token
}

export const personaService = {
  generateToken(): { token: string } {
    return { token: generatePersonaToken() }
  },

  async list(): Promise<AdminPersonaDto[]> {
    const personas = await PersonaModel.find().sort({ updatedAt: -1 })
    const counts = await documentCounts(personas.map(persona => idOf(persona)))
    return personas.map(persona =>
      toAdminDto(persona, counts.get(idOf(persona)) ?? 0),
    )
  },

  async get(id: string): Promise<AdminPersonaDto> {
    const persona = await requirePersona(id)
    return toAdminDto(persona, await countFor(idOf(persona)))
  },

  async create(input: PersonaWriteInput): Promise<AdminPersonaDto> {
    const parsed = parseCreatePersona(input)
    const persona = new PersonaModel({
      name: parsed.name,
      slug: parsed.slug,
      prompt: parsed.prompt,
      token: parsed.token ?? generatePersonaToken(),
      topK: parsed.topK,
      webResultCount: parsed.webResultCount,
      tag: parsed.tag,
      visibility: parsed.visibility,
      allowExternalDelete: parsed.allowExternalDelete,
    })
    const saved = await savePersona(persona)
    return toAdminDto(saved, 0)
  },

  async update(id: string, input: PersonaWriteInput): Promise<AdminPersonaDto> {
    const persona = await requirePersona(id)
    const parsed = parseUpdatePersona(input)
    applyNormalized(persona, parsed, null)
    const saved = await savePersona(persona)
    return toAdminDto(saved, await countFor(idOf(saved)))
  },

  async remove(id: string): Promise<void> {
    const persona = await requirePersona(id)
    const collection = collectionNameForPersona(idOf(persona))
    const documents = await PersonaDocument.find(scopedDocumentQuery(idOf(persona)))
    await deletePersonaCollection(collection)
    for (const document of documents) {
      await deleteStoredFile(document.fileId).catch(error => {
        console.error(
          'Stored file cleanup failed:',
          error instanceof Error ? error.name : 'unknown',
        )
      })
    }
    await PersonaDocument.deleteMany(scopedDocumentQuery(idOf(persona)))
    await persona.deleteOne()
  },

  async listDocuments(personaId: string): Promise<PersonaDocumentDto[]> {
    await requirePersona(personaId)
    const documents = await PersonaDocument.find(scopedDocumentQuery(personaId)).sort({
      createdAt: -1,
    })
    return documents.map(toDocumentDto)
  },

  async addDocument(
    personaId: string,
    file: UploadedFile | undefined,
  ): Promise<PersonaDocumentDto> {
    const persona = await requirePersona(personaId)
    if (!file || !file.buffer || file.size <= 0) {
      throw new HttpError(400, 'Es wurde keine Datei übergeben.')
    }
    if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, 'Die Datei ist größer als 20 MB.')
    }
    const existing = await countFor(idOf(persona))
    if (existing >= MAX_DOCUMENTS_PER_PERSONA) {
      throw new HttpError(
        400,
        `Eine Persona kann höchstens ${MAX_DOCUMENTS_PER_PERSONA} Dokumente haben.`,
      )
    }

    const filename = sanitizeFilename(file.originalname || 'dokument')
    const classified = classifyUpload(filename, file.mimetype || '')
    const collection = collectionNameForPersona(idOf(persona))
    const indexed = await indexPersonaDocument({
      collection,
      filename,
      mimeType: classified.mimeType,
      buffer: file.buffer,
    })

    let document: IPersonaDocument
    try {
      document = await PersonaDocument.create({
        personaId: persona._id,
        filename,
        mimeType: classified.mimeType,
        size: file.size,
        ragSourceId: indexed.sourceId,
      })
    } catch (error) {
      if (isDuplicateSourceError(error)) {
        const existing = await PersonaDocument.findOne({
          personaId: persona._id,
          ragSourceId: indexed.sourceId,
        })
        if (existing && !existing.fileId) {
          try {
            existing.fileId = await saveStoredFile({
              filename,
              mimeType: classified.mimeType,
              buffer: file.buffer,
              personaId: idOf(persona),
              documentId: idOf(existing),
              ragSourceId: indexed.sourceId,
            })
            await existing.save()
            return toDocumentDto(existing)
          } catch (storeError) {
            await deleteStoredFile(existing.fileId).catch(() => undefined)
            console.error(
              'Stored file write failed:',
              storeError instanceof Error ? storeError.name : 'unknown',
            )
            throw new HttpError(502, 'Die Datei konnte nicht gespeichert werden.')
          }
        }
        throw new HttpError(409, 'Dieses Dokument ist für die Persona bereits vorhanden.')
      }
      await deletePersonaSource(collection, indexed.sourceId).catch(cleanupError => {
        console.error(
          'RAG cleanup after failed metadata write failed:',
          cleanupError instanceof Error ? cleanupError.name : 'unknown',
        )
      })
      throw error
    }

    try {
      document.fileId = await saveStoredFile({
        filename,
        mimeType: classified.mimeType,
        buffer: file.buffer,
        personaId: idOf(persona),
        documentId: idOf(document),
        ragSourceId: indexed.sourceId,
      })
      await document.save()
      return toDocumentDto(document)
    } catch (error) {
      await deleteStoredFile(document.fileId).catch(() => undefined)
      await document.deleteOne().catch(() => undefined)
      await deletePersonaSource(collection, indexed.sourceId).catch(() => undefined)
      console.error(
        'Stored file write failed:',
        error instanceof Error ? error.name : 'unknown',
      )
      throw new HttpError(502, 'Die Datei konnte nicht gespeichert werden.')
    }
  },

  async removeDocument(personaId: string, documentId: string): Promise<void> {
    const persona = await requirePersona(personaId)
    const document = await PersonaDocument.findOne(
      scopedDocumentQuery(idOf(persona), documentId),
    )
    if (!document) throw new HttpError(404, 'Dokument nicht gefunden.')
    const collection = collectionNameForPersona(idOf(persona))
    await deletePersonaSource(collection, document.ragSourceId)
    await deleteStoredFile(document.fileId).catch(error => {
      console.error(
        'Stored file cleanup failed:',
        error instanceof Error ? error.name : 'unknown',
      )
    })
    await document.deleteOne()
  },

  async publicPersona(token: string): Promise<PublicPersonaView> {
    const persona = await requirePersonaByToken(token)
    assertTokenDocumentAccess({
      visibility: persona.visibility,
      allowExternalDelete: persona.allowExternalDelete,
      action: 'view',
    })
    return toPublicPersonaView({
      name: persona.name,
      tag: persona.tag ?? '',
      allowExternalDelete: persona.allowExternalDelete,
      documentCount: await countFor(idOf(persona)),
    })
  },

  async publicDocuments(token: string): Promise<PersonaDocumentDto[]> {
    const persona = await requirePersonaByToken(token)
    assertTokenDocumentAccess({
      visibility: persona.visibility,
      allowExternalDelete: persona.allowExternalDelete,
      action: 'view',
    })
    const documents = await PersonaDocument.find(
      scopedDocumentQuery(idOf(persona)),
    ).sort({ createdAt: -1 })
    return documents.map(toDocumentDto)
  },

  async addPublicDocument(
    token: string,
    file: UploadedFile | undefined,
  ): Promise<PersonaDocumentDto> {
    const persona = await requirePersonaByToken(token)
    assertTokenDocumentAccess({
      visibility: persona.visibility,
      allowExternalDelete: persona.allowExternalDelete,
      action: 'upload',
    })
    return this.addDocument(idOf(persona), file)
  },

  async removePublicDocument(token: string, documentId: string): Promise<void> {
    const persona = await requirePersonaByToken(token)
    assertTokenDocumentAccess({
      visibility: persona.visibility,
      allowExternalDelete: persona.allowExternalDelete,
      action: 'delete',
    })
    await this.removeDocument(idOf(persona), documentId)
  },

  async personaIdForTokenChat(token: string): Promise<string> {
    const persona = await requirePersonaByToken(token)
    assertTokenDocumentAccess({
      visibility: persona.visibility,
      allowExternalDelete: false,
      action: 'view',
    })
    return idOf(persona)
  },

  async resolveChatPersona(
    id: string | undefined | null,
    options?: { allowPrivate?: boolean },
  ): Promise<Persona> {
    if (isKnownPersona(id)) return resolvePersona(id)

    const normalized = String(id ?? '').trim()
    const slug = normalizePersonaSlug(normalized)
    const lookupBySlug =
      !isManagedPersonaId(normalized) && PERSONA_SLUG_PATTERN.test(slug)

    let doc: IPersona | null
    try {
      doc = lookupBySlug
        ? await PersonaModel.findOne({ slug })
        : isManagedPersonaId(normalized)
          ? await PersonaModel.findById(normalized)
          : null
    } catch (error) {
      console.error(
        'Managed persona lookup failed:',
        error instanceof Error ? error.name : 'unknown',
      )
      throw new HttpError(503, 'Die Persona konnte nicht geladen werden.')
    }
    if (!doc) {
      if (lookupBySlug || !isManagedPersonaId(normalized)) return resolvePersona(id)
      throw new HttpError(404, 'Persona nicht gefunden.')
    }
    if (lookupBySlug) return runtimeFromDocument(doc)

    assertManagedPersonaChatAccess(
      doc.visibility,
      options?.allowPrivate === true,
    )
    return runtimeFromDocument(doc)
  },
}

function runtimeFromDocument(doc: IPersona): Persona {
  const mongoId = idOf(doc)
  return toRuntimePersona({
    id: doc.slug || mongoId,
    collectionId: mongoId,
    name: doc.name,
    prompt: doc.prompt ?? '',
    topK: doc.topK,
    webResultCount: doc.webResultCount ?? 0,
  })
}

function isDuplicateSourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; keyPattern?: Record<string, unknown> }
  return candidate.code === 11000 && Boolean(candidate.keyPattern?.['ragSourceId'])
}

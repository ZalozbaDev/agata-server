import { Types } from 'mongoose'
import {
  DEFAULT_PERSONA_ID,
  SIP_PERSONA_ID,
  type Persona,
  type PersonaDocumentLanguage,
} from '../config/personas'
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
import { deleteStoredFile, deletePersonaImageFile, savePersonaImage, saveStoredFile } from './personaFileStore'
import {
  HttpError,
  MAX_DOCUMENTS_PER_PERSONA,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  type NormalizedPersona,
  type PersonaWriteInput,
  type PublicPersonaView,
  assertManagedPersonaChatAccess,
  assertTokenDocumentAccess,
  classifyPersonaImage,
  classifyUpload,
  collectionNameForPersona,
  generatePersonaToken,
  isDuplicateSlugError,
  isDuplicateTokenError,
  isManagedPersonaId,
  isPersonaCollectionName,
  isSystemPersonaSlug,
  normalizePersonaSlug,
  parseCreatePersona,
  PERSONA_SLUG_PATTERN,
  parseUpdatePersona,
  readDocumentLanguage,
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
  language: PersonaDocumentLanguage | null
  token: string
  topK: number
  webResultCount: number
  hasImage: boolean
  tag: string
  visibility: 'public' | 'private'
  allowExternalDelete: boolean
  protected: boolean
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
    language: persona.language ?? null,
    token: persona.token,
    topK: persona.topK,
    webResultCount: persona.webResultCount ?? 0,
    hasImage: Boolean(persona.imageFileId),
    tag: persona.tag ?? '',
    visibility: persona.visibility,
    allowExternalDelete: persona.allowExternalDelete,
    protected: persona.protected === true || isSystemPersonaSlug(persona.slug),
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
): void {
  if (next.name !== undefined) persona.name = next.name
  if (next.slug !== undefined) persona.slug = next.slug
  if (next.prompt !== undefined) persona.prompt = next.prompt
  if (next.topK !== undefined) persona.topK = next.topK
  if (next.webResultCount !== undefined) {
    if (next.webResultCount !== persona.webResultCount) {
      persona.webFallbackResultCount = next.webResultCount
    }
    persona.webResultCount = next.webResultCount
  }
  if (next.tag !== undefined) persona.tag = next.tag
  if (next.visibility !== undefined) persona.visibility = next.visibility
  if (next.allowExternalDelete !== undefined) {
    persona.allowExternalDelete = next.allowExternalDelete
  }
}

export const personaService = {
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
      language: parsed.language,
      token: generatePersonaToken(),
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
    const incomingLanguage = readDocumentLanguage(input.language, false)
    if (parsed.slug && parsed.slug !== (persona.slug ?? '')) {
      if (persona.protected || isSystemPersonaSlug(persona.slug)) {
        throw new HttpError(
          400,
          'Der Kurzname von Main und Sip kann nicht geändert werden.',
        )
      }
      if (isSystemPersonaSlug(parsed.slug)) {
        throw new HttpError(400, 'Dieser Kurzname ist für eine feste Persona reserviert.')
      }
    }
    applyNormalized(persona, parsed)
    if (!persona.language && incomingLanguage) {
      persona.language = incomingLanguage
    }
    const saved = await savePersona(persona)
    return toAdminDto(saved, await countFor(idOf(saved)))
  },

  async setImage(
    personaId: string,
    file: UploadedFile | undefined,
  ): Promise<AdminPersonaDto> {
    const persona = await requirePersona(personaId)
    if (!file || !file.buffer || file.size <= 0) {
      throw new HttpError(400, 'Es wurde kein Bild übergeben.')
    }
    if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
      throw new HttpError(400, 'Das Bild ist größer als 5 MB.')
    }
    const filename = sanitizeFilename(file.originalname || 'bild')
    const mimeType = classifyPersonaImage(filename, file.mimetype || '')
    const previous = persona.imageFileId
    const imageId = await savePersonaImage({
      filename,
      mimeType,
      buffer: file.buffer,
      personaId: idOf(persona),
    })
    try {
      persona.imageFileId = imageId
      persona.imageMimeType = mimeType
      const saved = await savePersona(persona)
      if (previous && String(previous) !== String(imageId)) {
        await deletePersonaImageFile(previous).catch(() => undefined)
      }
      return toAdminDto(saved, await countFor(idOf(saved)))
    } catch (error) {
      await deletePersonaImageFile(imageId).catch(() => undefined)
      throw error
    }
  },

  async clearImage(personaId: string): Promise<AdminPersonaDto> {
    const persona = await requirePersona(personaId)
    await deletePersonaImageFile(persona.imageFileId).catch(error => {
      console.error(
        'Persona image cleanup failed:',
        error instanceof Error ? error.name : 'unknown',
      )
    })
    await PersonaModel.updateOne(
      { _id: persona._id },
      { $unset: { imageFileId: 1, imageMimeType: 1 } },
    )
    const fresh = await requirePersona(personaId)
    return toAdminDto(fresh, await countFor(idOf(fresh)))
  },

  async openImage(
    key: string,
  ): Promise<{ fileId: Types.ObjectId; mimeType: string } | null> {
    const normalized = key.trim().toLowerCase()
    if (!normalized) return null
    const persona = isManagedPersonaId(normalized)
      ? await PersonaModel.findById(normalized).catch(() => null)
      : PERSONA_SLUG_PATTERN.test(normalized)
        ? await PersonaModel.findOne({ slug: normalized })
        : null
    if (!persona?.imageFileId) return null
    return {
      fileId: persona.imageFileId,
      mimeType: persona.imageMimeType || 'image/png',
    }
  },

  async remove(id: string): Promise<void> {
    const persona = await requirePersona(id)
    if (persona.protected || isSystemPersonaSlug(persona.slug)) {
      throw new HttpError(403, 'Main und Sip können nicht gelöscht werden.')
    }
    const collection = ragCollectionFor(persona)
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
    await deletePersonaImageFile(persona.imageFileId).catch(error => {
      console.error(
        'Persona image cleanup failed:',
        error instanceof Error ? error.name : 'unknown',
      )
    })
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
    const collection = ragCollectionFor(persona)
    const indexed = await indexPersonaDocument({
      collection,
      filename,
      mimeType: classified.mimeType,
      buffer: file.buffer,
      ...(persona.language ? { language: persona.language } : {}),
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
    const collection = ragCollectionFor(persona)
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
      language: persona.language ?? null,
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
    const requested = String(id ?? '').trim().toLowerCase()
    if (!requested || requested === DEFAULT_PERSONA_ID) {
      return requireSystemPersona(DEFAULT_PERSONA_ID)
    }
    if (requested === SIP_PERSONA_ID) {
      return requireSystemPersona(SIP_PERSONA_ID)
    }

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
      if (lookupBySlug || !isManagedPersonaId(normalized)) {
        return requireSystemPersona(DEFAULT_PERSONA_ID)
      }
      throw new HttpError(404, 'Persona nicht gefunden.')
    }
    if (lookupBySlug) return runtimeFromDocument(doc)

    assertManagedPersonaChatAccess(
      doc.visibility,
      options?.allowPrivate === true,
    )
    return runtimeFromDocument(doc)
  },

  async publicName(key: string): Promise<string | null> {
    const normalized = key.trim().toLowerCase()
    if (!normalized || normalized.length > 128) return null
    if (normalized === DEFAULT_PERSONA_ID || normalized === SIP_PERSONA_ID) {
      const persona = await PersonaModel.findOne({ slug: normalized }).select('name')
      return persona?.name?.trim() || null
    }

    try {
      const persona = PERSONA_SLUG_PATTERN.test(normalized)
        ? await PersonaModel.findOne({ slug: normalized }).select('name')
        : isManagedPersonaId(normalized)
          ? await PersonaModel.findById(normalized).select('name')
          : null
      const name = persona?.name?.trim() ?? ''
      return name || null
    } catch (error) {
      console.error(
        'Persona name lookup failed:',
        error instanceof Error ? error.name : 'unknown',
      )
      return null
    }
  },
}

function ragCollectionFor(persona: IPersona): string {
  const named = persona.ragCollection?.trim()
  if (named && isPersonaCollectionName(named)) return named
  return collectionNameForPersona(idOf(persona))
}

async function requireSystemPersona(slug: string): Promise<Persona> {
  const doc = await PersonaModel.findOne({ slug })
  if (!doc) {
    throw new HttpError(503, 'Die Standard-Persona ist nicht vorhanden.')
  }
  return runtimeFromDocument(doc)
}

function runtimeFromDocument(doc: IPersona): Persona {
  const mongoId = idOf(doc)
  const webFallback = doc.webFallbackResultCount
  return toRuntimePersona({
    id: doc.slug || mongoId,
    collectionId: mongoId,
    name: doc.name,
    prompt: doc.prompt ?? '',
    topK: doc.topK,
    webResultCount: doc.webResultCount ?? 0,
    allowGeneralKnowledge: doc.allowGeneralKnowledge === true,
    ...(doc.language ? { documentLanguage: doc.language } : {}),
    ...(doc.ragCollection?.trim() && isPersonaCollectionName(doc.ragCollection.trim())
      ? { collection: doc.ragCollection.trim() }
      : {}),
    ...(typeof webFallback === 'number' ? { webFallbackResultCount: webFallback } : {}),
  })
}

function isDuplicateSourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; keyPattern?: Record<string, unknown> }
  return candidate.code === 11000 && Boolean(candidate.keyPattern?.['ragSourceId'])
}

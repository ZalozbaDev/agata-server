import mongoose, { Types } from 'mongoose'
import { HttpError } from './personaPolicy'

const BUCKET_NAME = 'personaFiles'
const IMAGE_BUCKET_NAME = 'personaImages'

function fileBucket(name = BUCKET_NAME): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db
  if (!db) throw new HttpError(503, 'Die Datenbank ist nicht verbunden.')
  return new mongoose.mongo.GridFSBucket(db, { bucketName: name })
}

export async function saveStoredFile(params: {
  filename: string
  mimeType: string
  buffer: Buffer
  personaId: string
  documentId: string
  ragSourceId: string
}): Promise<Types.ObjectId> {
  const bucket = fileBucket()
  const upload = bucket.openUploadStream(params.filename, {
    contentType: params.mimeType,
    metadata: {
      personaId: params.personaId,
      documentId: params.documentId,
      ragSourceId: params.ragSourceId,
    },
  })

  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    upload.on('finish', () => resolve())
    upload.end(params.buffer)
  })

  return upload.id
}

async function deleteBucketFile(
  bucketName: string,
  fileId: Types.ObjectId,
): Promise<void> {
  try {
    await fileBucket(bucketName).delete(fileId)
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('not found') || message.includes('does not exist')) return
    throw error
  }
}

async function deleteMatchingFiles(
  bucketName: string,
  filter: mongoose.mongo.Filter<mongoose.mongo.GridFSFile>,
): Promise<void> {
  const files = await fileBucket(bucketName).find(filter).toArray()
  for (const file of files) {
    await deleteBucketFile(bucketName, file._id)
  }
}

export async function deleteStoredFile(
  fileId: Types.ObjectId | string | null | undefined,
): Promise<void> {
  if (!fileId) return
  await deleteBucketFile(BUCKET_NAME, new Types.ObjectId(String(fileId)))
}

export async function deleteStoredFilesForDocument(
  fileId: Types.ObjectId | string | null | undefined,
  documentId: string,
): Promise<void> {
  const clauses: mongoose.mongo.Filter<mongoose.mongo.GridFSFile>[] = [
    { 'metadata.documentId': documentId },
  ]
  if (fileId) clauses.push({ _id: new Types.ObjectId(String(fileId)) })
  await deleteMatchingFiles(BUCKET_NAME, { $or: clauses })
}

export async function deleteStoredFilesForPersona(personaId: string): Promise<void> {
  await deleteMatchingFiles(BUCKET_NAME, { 'metadata.personaId': personaId })
}

export function openStoredFile(fileId: Types.ObjectId | string): mongoose.mongo.GridFSBucketReadStream {
  return fileBucket().openDownloadStream(new Types.ObjectId(String(fileId)))
}

export async function savePersonaImage(params: {
  filename: string
  mimeType: string
  buffer: Buffer
  personaId: string
}): Promise<Types.ObjectId> {
  const upload = fileBucket(IMAGE_BUCKET_NAME).openUploadStream(params.filename, {
    contentType: params.mimeType,
    metadata: { personaId: params.personaId, kind: 'persona-image' },
  })
  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    upload.on('finish', () => resolve())
    upload.end(params.buffer)
  })
  return upload.id
}

export async function deletePersonaImageFile(
  fileId: Types.ObjectId | string | null | undefined,
): Promise<void> {
  if (!fileId) return
  await deleteBucketFile(IMAGE_BUCKET_NAME, new Types.ObjectId(String(fileId)))
}

export async function deletePersonaImagesForPersona(
  personaId: string,
  imageFileId?: Types.ObjectId | string | null,
): Promise<void> {
  const clauses: mongoose.mongo.Filter<mongoose.mongo.GridFSFile>[] = [
    { 'metadata.personaId': personaId },
  ]
  if (imageFileId) clauses.push({ _id: new Types.ObjectId(String(imageFileId)) })
  await deleteMatchingFiles(IMAGE_BUCKET_NAME, { $or: clauses })
}

export function openPersonaImage(
  fileId: Types.ObjectId | string,
): mongoose.mongo.GridFSBucketReadStream {
  return fileBucket(IMAGE_BUCKET_NAME).openDownloadStream(new Types.ObjectId(String(fileId)))
}

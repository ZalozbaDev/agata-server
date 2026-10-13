import mongoose, { Types } from 'mongoose'
import { HttpError } from './personaPolicy'

const BUCKET_NAME = 'personaFiles'

function fileBucket(): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db
  if (!db) throw new HttpError(503, 'Die Datenbank ist nicht verbunden.')
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME })
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

export async function deleteStoredFile(
  fileId: Types.ObjectId | string | null | undefined,
): Promise<void> {
  if (!fileId) return
  try {
    await fileBucket().delete(new Types.ObjectId(String(fileId)))
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('not found') || message.includes('does not exist')) return
    throw error
  }
}

export function openStoredFile(fileId: Types.ObjectId | string): mongoose.mongo.GridFSBucketReadStream {
  return fileBucket().openDownloadStream(new Types.ObjectId(String(fileId)))
}

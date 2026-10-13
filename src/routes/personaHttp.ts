import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { HttpError, MAX_UPLOAD_BYTES } from '../services/personaPolicy'
import type { UploadedFile } from '../services/personaService'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
})

type StoredFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

export function sendPersonaError(res: Response, error: unknown): void {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message })
    return
  }
  console.error(
    'Persona request failed:',
    error instanceof Error ? error.name : 'unknown',
  )
  res.status(500).json({ error: 'Die Anfrage konnte nicht verarbeitet werden.' })
}

export function singleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next()
      return
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Die Datei ist größer als 20 MB.' })
      return
    }
    res.status(400).json({ error: 'Die Datei konnte nicht gelesen werden.' })
  })
}

export function uploadedFile(req: Request): UploadedFile | undefined {
  const file = (req as Request & { file?: StoredFile }).file
  if (!file) return undefined
  return {
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  }
}

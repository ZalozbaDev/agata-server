import { Router, type Request, type Response } from 'express'
import { PersonaDocument } from '../models/PersonaDocument'
import { isManagedPersonaId } from '../services/personaPolicy'
import { openStoredFile } from '../services/personaFileStore'

const router = Router()
const SOURCE_ID_PATTERN = /^(pdf|html):[a-f0-9]{64}$/

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '')
  return `inline; filename="${ascii || 'dokument'}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function missingFile(res: Response): void {
  res
    .status(404)
    .type('html')
    .send(
      '<!doctype html><meta charset="utf-8"><title>Datei</title>' +
        '<p>Diese Datei ist nicht mehr gespeichert. Bitte lade sie in der Persona-Verwaltung erneut hoch.</p>',
    )
}

router.get('/', async (req: Request, res: Response) => {
  const documentId = String(req.query['document'] ?? '').trim().toLowerCase()
  const sourceId = String(req.query['source'] ?? '').trim().toLowerCase()

  try {
    if (!documentId && !sourceId) {
      res.status(400).json({ error: 'Dokument oder Quelle fehlt.' })
      return
    }
    if (documentId && !isManagedPersonaId(documentId)) {
      res.status(400).json({ error: 'Ungültige Dokument-ID.' })
      return
    }
    if (sourceId && !SOURCE_ID_PATTERN.test(sourceId)) {
      res.status(400).json({ error: 'Ungültige Quellen-ID.' })
      return
    }

    const document = documentId
      ? await PersonaDocument.findById(documentId)
      : await PersonaDocument.findOne({ ragSourceId: sourceId })

    if (!document?.fileId) {
      missingFile(res)
      return
    }

    const filename = document.filename || 'dokument'
    const mimeType = document.mimeType || 'application/octet-stream'
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', String(document.size))
    res.setHeader('Content-Disposition', contentDisposition(filename))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.removeHeader('X-Frame-Options')
    res.setHeader(
      'Content-Security-Policy',
      mimeType.includes('html')
        ? "frame-ancestors *; sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:"
        : 'frame-ancestors *',
    )

    const stream = openStoredFile(document.fileId)
    stream.on('error', () => {
      if (!res.headersSent) missingFile(res)
      else res.destroy()
    })
    stream.pipe(res)
  } catch (error) {
    console.error(
      'Stored file read failed:',
      error instanceof Error ? error.name : 'unknown',
    )
    if (!res.headersSent) {
      res.status(500).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Datei</title><p>Die Datei konnte nicht geladen werden.</p>',
      )
    }
  }
})

export default router

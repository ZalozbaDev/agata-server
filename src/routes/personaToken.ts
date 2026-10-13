import { Router, type Request, type Response } from 'express'
import { uploadRateLimit } from '../middleware/uploadRateLimit'
import { chatService } from '../services/chatService'
import { personaService } from '../services/personaService'
import { sendPersonaError, singleFile, uploadedFile } from './personaHttp'

const router = Router()

function tokenFrom(req: Request): string {
  return String(req.params['token'] ?? '')
}

router.get('/:token', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.publicPersona(tokenFrom(req))
    res.json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.get('/:token/documents', async (req: Request, res: Response) => {
  try {
    const documents = await personaService.publicDocuments(tokenFrom(req))
    res.json({ documents })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post(
  '/:token/documents',
  uploadRateLimit,
  singleFile,
  async (req: Request, res: Response) => {
    try {
      const document = await personaService.addPublicDocument(
        tokenFrom(req),
        uploadedFile(req),
      )
      res.status(201).json({ document })
    } catch (error) {
      sendPersonaError(res, error)
    }
  },
)

router.delete('/:token/documents/:documentId', async (req: Request, res: Response) => {
  try {
    await personaService.removePublicDocument(
      tokenFrom(req),
      String(req.params['documentId'] ?? ''),
    )
    res.json({ deleted: true })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post('/:token/chat', async (req: Request, res: Response) => {
  try {
    const personaId = await personaService.personaIdForTokenChat(tokenFrom(req))
    const message = String((req.body as { message?: unknown } | undefined)?.message ?? '')
    const ipAddress = (req.body as { ipAddress?: unknown } | undefined)?.ipAddress
    const result = await chatService.handleChat({
      message,
      persist: false,
      personaId,
      ...(typeof ipAddress === 'string' && ipAddress.trim()
        ? { ipAddress: ipAddress.trim() }
        : {}),
    })
    res.json(result)
  } catch (error) {
    sendPersonaError(res, error)
  }
})

export default router

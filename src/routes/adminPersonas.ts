import { Router, type Request, type Response } from 'express'
import { requireAdmin } from '../middleware/requireAdmin'
import { chatService } from '../services/chatService'
import { personaService } from '../services/personaService'
import { sendPersonaError, singleFile, singleImage, uploadedFile } from './personaHttp'

const router = Router()

router.use(requireAdmin)

router.get('/', async (_req: Request, res: Response) => {
  try {
    const personas = await personaService.list()
    res.json({ personas })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post('/token', async (_req: Request, res: Response) => {
  res.json(personaService.generateToken())
})

router.post('/', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.create(req.body ?? {})
    res.status(201).json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.get(String(req.params['id'] ?? ''))
    res.json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.update(
      String(req.params['id'] ?? ''),
      req.body ?? {},
    )
    res.json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post('/:id/image', singleImage, async (req: Request, res: Response) => {
  try {
    const persona = await personaService.setImage(
      String(req.params['id'] ?? ''),
      uploadedFile(req),
    )
    res.json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.delete('/:id/image', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.clearImage(String(req.params['id'] ?? ''))
    res.json({ persona })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await personaService.remove(String(req.params['id'] ?? ''))
    res.json({ deleted: true })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const documents = await personaService.listDocuments(String(req.params['id'] ?? ''))
    res.json({ documents })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post('/:id/documents', singleFile, async (req: Request, res: Response) => {
  try {
    const document = await personaService.addDocument(
      String(req.params['id'] ?? ''),
      uploadedFile(req),
    )
    res.status(201).json({ document })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.delete('/:id/documents/:documentId', async (req: Request, res: Response) => {
  try {
    await personaService.removeDocument(
      String(req.params['id'] ?? ''),
      String(req.params['documentId'] ?? ''),
    )
    res.json({ deleted: true })
  } catch (error) {
    sendPersonaError(res, error)
  }
})

router.post('/:id/chat', async (req: Request, res: Response) => {
  try {
    const persona = await personaService.get(String(req.params['id'] ?? ''))
    const message = String((req.body as { message?: unknown } | undefined)?.message ?? '')
    const result = await chatService.handleChat({
      message,
      persist: false,
      personaId: persona.id,
      allowPrivatePersona: true,
    })
    res.json(result)
  } catch (error) {
    sendPersonaError(res, error)
  }
})

export default router

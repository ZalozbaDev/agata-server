import { Router, type Request, type Response } from 'express'
import { openPersonaImage } from '../services/personaFileStore'
import { personaService } from '../services/personaService'

const router = Router()

router.get('/:key/appearance', async (req: Request, res: Response) => {
  try {
    const appearance = await personaService.publicAppearance(
      String(req.params['key'] ?? ''),
    )
    if (!appearance) {
      res.status(404).json({ error: 'Persona nicht gefunden.' })
      return
    }
    res.json(appearance)
  } catch {
    res.status(404).json({ error: 'Persona nicht gefunden.' })
  }
})

router.get('/:key/name', async (req: Request, res: Response) => {
  try {
    const name = await personaService.publicName(String(req.params['key'] ?? ''))
    if (!name) {
      res.status(404).json({ error: 'Persona nicht gefunden.' })
      return
    }
    res.json({ name })
  } catch {
    res.status(404).json({ error: 'Persona nicht gefunden.' })
  }
})

router.get('/:key/image', async (req: Request, res: Response) => {
  try {
    const image = await personaService.openImage(String(req.params['key'] ?? ''))
    if (!image) {
      res.status(404).end()
      return
    }
    res.setHeader('Content-Type', image.mimeType)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const stream = openPersonaImage(image.fileId)
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end()
      else res.destroy()
    })
    stream.pipe(res)
  } catch {
    if (!res.headersSent) res.status(404).end()
  }
})

export default router

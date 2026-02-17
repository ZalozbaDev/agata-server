import { Response, Router, Request } from 'express'
import { visemeGeneratorService } from '../services/visemeGenerator'
import {
  fetchBamborakSpeakers,
  generateBamborakAudioFromText,
} from '../services/bamborakService'

const router = Router()

// POST /api/bamborak/audioFromText - Generate audio and visemes
router.post('/audioFromText', async (req: Request, res: Response) => {
  const { text, speaker_id } = req.body

  if (!text) {
    return res.status(400).json({ error: 'Text is required' })
  }

  try {
    const result = await generateBamborakAudioFromText({ text, speaker_id })

    // Set response headers
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Length', result.audioByteLength)

    // Return both audio and viseme data
    return res.status(200).json({
      audio: result.audioBase64, // Send audio as base64
      visemes: result.visemes,
      text: result.text,
      duration: result.duration,
      sampleRate: result.sampleRate,
    })
  } catch (error) {
    console.error('Bamborak error: ', error)
    return res.status(400).json({ error: 'Failed to generate audio' })
  }
})

// GET /api/bamborak/visemes - Get available viseme types
router.get('/visemes', (_req: Request, res: Response) => {
  const availableVisemes = visemeGeneratorService.getAvailableVisemes()
  res.json({
    visemes: availableVisemes,
    count: availableVisemes.length,
  })
})

// GET /api/bamborak/speakers - Get available speakers
router.get('/speakers', async (_req: Request, res: Response) => {
  try {
    const speakers = await fetchBamborakSpeakers()
    res.json(speakers)
  } catch (error) {
    console.error('Error fetching speakers:', error)
    res.status(400).json({ error: 'Failed to fetch speakers' })
  }
})

export default router

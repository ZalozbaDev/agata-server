import axios, { AxiosRequestConfig } from 'axios'
import { Response, Router, Request } from 'express'
import { visemeGeneratorService } from '../services/visemeGenerator'

const router = Router()

// POST /api/bamborak/audioFromText - Generate audio and visemes
router.post('/audioFromText', async (req: Request, res: Response) => {
  const { text, speaker_id } = req.body

  if (!text) {
    return res.status(400).json({ error: 'Text is required' })
  }

  const config: AxiosRequestConfig = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://bamborakapi.mudrowak.de/api/tts/',
    headers: {
      'Content-Type': 'application/json',
    },
    data: { text, speaker_id },
    responseType: 'arraybuffer',
  }

  try {
    const resp = await axios.request(config)

    // Generate visemes from the text
    const estimatedDuration = text.length * 0.1 // Rough estimate: 100ms per character
    const visemeTimeline = visemeGeneratorService.generateVisemesFromText(
      text,
      estimatedDuration
    )

    // Set response headers
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Length', resp.data.length)

    // Return both audio and viseme data
    return res.status(200).json({
      audio: resp.data.toString('base64'), // Send audio as base64
      visemes: visemeTimeline,
      text: text,
      duration: estimatedDuration,
      sampleRate: 44100,
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
    const response = await axios.get(
      'https://bamborakapi.mudrowak.de/api/fetch_speakers/'
    )
    res.json(response.data)
  } catch (error) {
    console.error('Error fetching speakers:', error)
    res.status(400).json({ error: 'Failed to fetch speakers' })
  }
})

export default router

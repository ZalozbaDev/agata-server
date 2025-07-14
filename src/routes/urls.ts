import { Router, Request, Response } from 'express'
import { Url } from '../models/Url'

const router = Router()

// GET /api/urls - Fetch all URLs
router.get('/', async (_req: Request, res: Response) => {
  try {
    const urls = await Url.find().sort({ createdAt: -1 })
    return res.json({
      success: true,
      data: urls,
      count: urls.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error fetching URLs:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch URLs',
      timestamp: new Date().toISOString(),
    })
  }
})

// GET /api/urls/:id - Fetch a specific URL by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const url = await Url.findById(req.params['id'])
    if (!url) {
      return res.status(404).json({
        success: false,
        error: 'URL not found',
        timestamp: new Date().toISOString(),
      })
    }
    return res.json({
      success: true,
      data: url,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error fetching URL:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch URL',
      timestamp: new Date().toISOString(),
    })
  }
})

// POST /api/urls - Create a new URL entry
router.post('/', async (req: Request, res: Response) => {
  try {
    const { url, username, password, description } = req.body

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required',
        timestamp: new Date().toISOString(),
      })
    }

    const newUrl = new Url({
      url,
      username,
      password,
      description,
    })

    const savedUrl = await newUrl.save()
    console.log('New URL created:', savedUrl)

    return res.status(201).json({
      success: true,
      data: savedUrl,
      message: 'URL created successfully',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error creating URL:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to create URL',
      timestamp: new Date().toISOString(),
    })
  }
})

export default router

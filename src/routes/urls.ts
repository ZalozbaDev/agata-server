import { Router, Request, Response } from 'express'
import { Url } from '../models/Url'
import { dataManagerService } from '../services/dataManager'

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

// POST /api/urls/process - Process all stored URLs and fetch their content
router.post('/process', async (req: Request, res: Response) => {
  try {
    const { type } = req.body // Optional: 'news', 'private', or 'general'

    console.log('Starting URL processing...')
    const processedData = await dataManagerService.processStoredUrls(type)

    return res.json({
      success: true,
      message: `Successfully processed ${processedData.length} URLs`,
      data: {
        processedCount: processedData.length,
        processedUrls: processedData.map(item => ({
          url: item.url,
          title: item.title,
          type: item.type,
        })),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error processing URLs:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to process URLs',
      timestamp: new Date().toISOString(),
    })
  }
})

// GET /api/urls/stats - Get URL processing statistics
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await dataManagerService.getUrlStats()

    return res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error fetching URL stats:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch URL statistics',
      timestamp: new Date().toISOString(),
    })
  }
})

// POST /api/urls/reset - Reset URL processing status
router.post('/reset', async (req: Request, res: Response) => {
  try {
    const { type } = req.body // Optional: 'news', 'private', or 'general'

    const resetCount = await dataManagerService.resetUrlProcessingStatus(type)

    return res.json({
      success: true,
      message: `Reset processing status for ${resetCount} URLs`,
      data: {
        resetCount,
        type: type || 'all',
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error resetting URL processing status:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to reset URL processing status',
      timestamp: new Date().toISOString(),
    })
  }
})

// GET /api/urls/type/:type - Get URLs by type
router.get('/type/:type', async (req: Request, res: Response) => {
  try {
    const { type } = req.params

    if (!type || !['news', 'private', 'general'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Must be news, private, or general',
        timestamp: new Date().toISOString(),
      })
    }

    const urls = await dataManagerService.getUrlsByType(
      type as 'news' | 'private' | 'general'
    )

    return res.json({
      success: true,
      data: urls,
      count: urls.length,
      type,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error fetching URLs by type:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch URLs by type',
      timestamp: new Date().toISOString(),
    })
  }
})

// POST /api/urls/debug - Debug link extraction for a specific URL
router.post('/debug', async (req: Request, res: Response) => {
  try {
    const { url } = req.body

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required',
        timestamp: new Date().toISOString(),
      })
    }

    const debugResult = await dataManagerService.debugLinkExtraction(url)

    return res.json({
      success: true,
      data: debugResult,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error debugging link extraction:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to debug link extraction',
      timestamp: new Date().toISOString(),
    })
  }
})

// GET /api/urls/db-stats - Get database statistics
router.get('/db-stats', async (_req: Request, res: Response) => {
  try {
    const urlStats = await dataManagerService.getUrlStats()
    const dbStats = await dataManagerService.getDatabaseStats()

    return res.json({
      success: true,
      data: {
        urlStats,
        dbStats,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error fetching database stats:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch database statistics',
      timestamp: new Date().toISOString(),
    })
  }
})

export default router

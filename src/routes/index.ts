import { Router, Request, Response } from 'express'
import urlRoutes from './urls'
import visitorRoutes from './visitor'
import { dataManagerService } from '../services/dataManager'
// import { dataFetcherService } from '../services/dataFetcher'
import { Url } from '../models/Url'
import { FetchedData } from '../models/FetchedData'
import bamborakRoutes from './bamborak'
import hooksRoutes from './hooks'
import { chatService } from '../services/chatService'

const router = Router()

// Hello World route
router.get('/hello', (_req: Request, res: Response) => {
  res.json({
    message: 'Hello World!',
    timestamp: new Date().toISOString(),
    environment: process.env['NODE_ENV'] || 'development',
  })
})

// API info route
router.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'Welcome to Agata API',
    version: '1.0.0',
    endpoints: {
      hello: '/api/hello',
      health: '/health',
      urls: '/api/urls',
      chat: '/api/chat',
      fetchData: '/api/fetch-data',
      data: '/api/data',
      bamborak: '/api/bamborak',
    },
    features: {
      substitution: 'Substitution plan queries (zastup, vertretung, etc.)',
      dataSearch: 'Search through stored data sources',
      audioGeneration: 'Text-to-speech with viseme generation for lip-sync',
    },
    timestamp: new Date().toISOString(),
  })
})

router.post('/chat', async (req: Request, res: Response) => {
  const { message, ipAddress } = req.body as {
    message?: string
    ipAddress?: string
  }

  console.log('Received message:', message, 'from IP:', ipAddress)

  try {
    const chatInput: { message: string; persist: boolean; ipAddress?: string } =
      {
        message: message ?? '',
        persist: true,
      }

    if (ipAddress) chatInput.ipAddress = ipAddress

    const result = await chatService.handleChat(chatInput)

    // Keep response shape stable
    res.send(result)
  } catch (error) {
    console.error('Error in /chat:', error)
    res.status(500).send({ error: 'Failed to process chat message' })
  }
})

// New route to manually trigger data fetching
router.post('/fetch-data', async (_req: Request, res: Response) => {
  try {
    const urls = await Url.find({})

    if (urls.length === 0) {
      return res.status(404).json({ error: 'No URLs configured' })
    }

    const sources = urls.map(url => ({
      url: url.url,
      username: url.username || undefined,
      password: url.password || undefined,
      type: 'general' as const,
      description: url.description || undefined,
    }))

    const fetchedData = await dataManagerService.fetchAndStoreData(sources)

    return res.json({
      message: `Successfully fetched data from ${fetchedData.length} sources`,
      fetchedCount: fetchedData.length,
      sources: fetchedData.map(d => ({ url: d.url, title: d.title })),
    })
  } catch (error) {
    console.error('Error in fetch-data route:', error)
    return res.status(500).json({ error: 'Failed to fetch data' })
  }
})

// New route to get stored data
router.get('/data', async (req: Request, res: Response) => {
  try {
    const { type, limit = 10, page = 1 } = req.query

    const filter: any = { isActive: true }
    if (type) {
      filter.type = type
    }

    const data = await FetchedData.find(filter)
      .sort({ timestamp: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .select('url title content type timestamp metadata')

    res.json({
      data,
      count: data.length,
      total: await FetchedData.countDocuments(filter),
    })
  } catch (error) {
    console.error('Error getting data:', error)
    res.status(500).json({ error: 'Failed to get data' })
  }
})

// URL routes
router.use('/urls', urlRoutes)
router.use('/bamborak', bamborakRoutes)
router.use('/visitors', visitorRoutes)
router.use('/hooks', hooksRoutes)

export default router

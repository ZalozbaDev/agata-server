import axios from 'axios'
import { Router, Request, Response } from 'express'
import { openAI } from '..'
import urlRoutes from './urls'
import { weatherService } from '../services/weather'
import { dataManagerService } from '../services/dataManager'
// import { dataFetcherService } from '../services/dataFetcher'
import { Url } from '../models/Url'
import { FetchedData, IFetchedData } from '../models/FetchedData'

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
    },
    timestamp: new Date().toISOString(),
  })
})

router.post('/chat', async (req: Request, res: Response) => {
  const { message } = req.body

  // Translate the chat message from user to german
  const translatedInput = await axios.post(
    'https://sotra.app/?uri=/ws/translate/&_version=2.1.10',
    {
      direction: 'hsb_de',
      warnings: false,
      text: message,
    }
  )

  const translatedInputText = translatedInput.data.output_html
  console.log('translatedInput: ' + translatedInputText)

  // Check if the message is about weather
  const isWeatherQuery = weatherService.isWeatherQuery(message)
  let weatherInfo = ''

  const OPEN_AI_MODEL = 'gpt-4o'

  // Handle weather queries
  if (isWeatherQuery) {
    const city = await openAI.chat.completions.create({
      model: OPEN_AI_MODEL,
      messages: [
        {
          role: 'user',
          content: 'Get the city from this text: ' + translatedInputText,
        },
      ],
    })
    const weather = await weatherService.getCurrentWeather(
      city.choices[0]?.message?.content || ''
    )
    if (weather) {
      console.log('weather', weather)
      weatherInfo = weatherService.formatWeatherResponse(weather)
    }
  }

  // First, try to find relevant data in the database
  let relevantData: IFetchedData[] = []
  let dataContext = ''
  let dataSources: { url: string; title: string }[] = []

  try {
    relevantData = await dataManagerService.getRelevantData(message || '')
    if (relevantData.length > 0) {
      dataContext = await dataManagerService.generateContextFromData(
        relevantData
      )
      dataSources = relevantData.map(d => ({ url: d.url, title: d.title }))
      console.log(
        `Found ${relevantData.length} relevant data sources in database`
      )
    }
  } catch (error) {
    console.error('Error searching database:', error)
  }

  // Prepare context for OpenAI
  let openaiInput = translatedInputText || ''
  let systemPrompt =
    'Du bist ein hilfreicher Assistent. Die eingebene Frage ist auf Obersorbisch. Antworte bitte auch auf Obersorbisch'

  if (isWeatherQuery && weatherInfo) {
    openaiInput = `Aktuelle Wetterdaten: ${weatherInfo}\n\nBenutzerfrage: ${translatedInputText}\n\nBitte beantworte die Frage unter Berücksichtigung der aktuellen Wetterdaten.`
  }

  if (dataContext) {
    systemPrompt = `Du bist ein hilfreicher Assistent mit Zugang zu aktuellen Informationen. Antworte auf Deutsch und nutze die bereitgestellten Informationen, wenn sie relevant sind. Wenn sie nicht passen, antworte mit deinem globalen Wissen.`
    openaiInput = `${dataContext}\n\nBenutzerfrage: ${translatedInputText}\n\nBitte beantworte die Frage unter Berücksichtigung der bereitgestellten Informationen. Wenn sie nicht passen, antworte mit deinem globalen Wissen.`
  }

  // Ask openai what to answer to that question is
  const openai_response = await openAI.chat.completions.create({
    model: OPEN_AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: openaiInput },
    ],
  })

  console.log(openai_response.choices[0]?.message?.content)

  // Translate answer back to sorbian
  const translatedAnswer = await axios.post(
    'https://sotra.app/?uri=/ws/translate/&_version=2.1.10',
    {
      direction: 'de_hsb',
      warnings: false,
      text: openai_response.choices[0]?.message?.content || '',
    }
  )

  res.send({
    message: translatedAnswer.data.output_text,
    timestamp: new Date().toISOString(),
    weatherData: isWeatherQuery && weatherInfo ? weatherInfo : undefined,
    dataSources: dataSources.length > 0 ? dataSources : undefined,
  })
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

export default router

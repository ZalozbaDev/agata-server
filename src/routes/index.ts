import axios from 'axios'
import { Router, Request, Response } from 'express'
import mongoose from 'mongoose'
import { openAI } from '..'
import urlRoutes from './urls'
import visitorRoutes from './visitor'
import { weatherService } from '../services/weather'
import { substitutionPlanService } from '../services/substitutionPlan'
import { dataManagerService } from '../services/dataManager'
// import { dataFetcherService } from '../services/dataFetcher'
import { Url } from '../models/Url'
import { FetchedData, IFetchedData } from '../models/FetchedData'
import bamborakRoutes from './bamborak'
import { Prompt } from '../models/Prompt'
import { Visitor } from '../models/Visitor'

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
      weather: 'Weather queries (wjedro, temperatura, etc.)',
      substitution: 'Substitution plan queries (zastup, vertretung, etc.)',
      dataSearch: 'Search through stored data sources',
      audioGeneration: 'Text-to-speech with viseme generation for lip-sync',
    },
    timestamp: new Date().toISOString(),
  })
})

router.post('/chat', async (req: Request, res: Response) => {
  const { message, ipAddress } = req.body

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

  // Check if the message is about weather or substitution plan
  const isWeatherQuery = weatherService.isWeatherQuery(message)
  const isSubstitutionQuery =
    substitutionPlanService.isSubstitutionQuery(message)
  let weatherInfo = ''
  let substitutionInfo = ''

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

  // Handle substitution plan queries
  if (isSubstitutionQuery) {
    console.log('Detected substitution plan query')
    const substitutionPlan =
      await substitutionPlanService.fetchSubstitutionPlan()
    if (substitutionPlan) {
      console.log('substitution plan', substitutionPlan)
      substitutionInfo =
        substitutionPlanService.formatSubstitutionResponse(substitutionPlan)
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

  if (isSubstitutionQuery && substitutionInfo) {
    openaiInput = `Aktueller Vertretungsplan: ${substitutionInfo}\n\nBenutzerfrage: ${translatedInputText}\n\nBitte beantworte die Frage unter Berücksichtigung des aktuellen Vertretungsplans.`
  }

  if (dataContext) {
    systemPrompt = `Du bist ein hilfreicher Assistent mit Zugang zu aktuellen Informationen. Antworte auf Deutsch und nutze die bereitgestellten Informationen, wenn sie relevant sind. Wenn sie nicht passen, antworte mit deinem globalen Wissen. Informationen: ${dataContext}. Fasse dich kurz und präzise.`
    openaiInput = `Benutzerfrage: ${translatedInputText}\n\n.`
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

  const visitor = await Visitor.findOne({ ipAddress })

  console.log({
    input_text: translatedInputText,
    output_text: translatedAnswer.data.output_html,
    visitor: visitor?._id,
  })

  if (visitor) {
    const prompt = await Prompt.create({
      input_text: translatedInputText,
      output_text: translatedAnswer.data.output_html,
      visitor: visitor._id,
    })

    // Add the prompt to the visitor's prompts array
    visitor.prompts.push(prompt._id as mongoose.Types.ObjectId)
    await visitor.save()
  }

  res.send({
    message: translatedAnswer.data.output_text,
    timestamp: new Date().toISOString(),
    weatherData: isWeatherQuery && weatherInfo ? weatherInfo : undefined,
    substitutionData:
      isSubstitutionQuery && substitutionInfo ? substitutionInfo : undefined,
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
router.use('/bamborak', bamborakRoutes)
router.use('/visitors', visitorRoutes)

export default router

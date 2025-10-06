import axios from 'axios'
import { Router, Request, Response } from 'express'
// import mongoose from 'mongoose'
import { openAI } from '..'
import urlRoutes from './urls'
import visitorRoutes from './visitor'
import { substitutionPlanService } from '../services/substitutionPlan'
import { dataManagerService } from '../services/dataManager'
// import { dataFetcherService } from '../services/dataFetcher'
import { Url } from '../models/Url'
import { FetchedData } from '../models/FetchedData'
import bamborakRoutes from './bamborak'
// import { Prompt } from '../models/Prompt'
// import { Visitor } from '../models/Visitor'
import agentRoutes from './agents'
import { OPEN_AI_MODEL } from '../config/constants'

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
  const { message, ipAddress } = req.body
  console.log('Received message:', message, 'from IP:', ipAddress)
  // Translate the chat message from user to german
  const translatedInput = await axios.post(
    `https://sotra.app/?uri=/ws/translate/&api_key=${process.env['SOTRA_API_KEY']}`,
    {
      direction: 'hsb_de',
      warnings: false,
      text: message,
    }
  )
  const translatedInputText = translatedInput.data.output_html

  const isSubstitutionQuery =
    substitutionPlanService.isSubstitutionQuery(message)
  let substitutionInfo = ''

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
  // let relevantData: IFetchedData[] = []
  let dataContext = ''
  let dataSources: { url: string; title: string }[] = []

  // try {
  //   relevantData = await dataManagerService.getRelevantData(message || '')
  //   if (relevantData.length > 0) {
  //     dataContext = await dataManagerService.generateContextFromData(
  //       relevantData
  //     )
  //     dataSources = relevantData.map(d => ({ url: d.url, title: d.title }))
  //     console.log(
  //       `Found ${relevantData.length} relevant data sources in database`
  //     )
  //   }
  // } catch (error) {
  //   console.error('Error searching database:', error)
  // }

  // Prepare context for OpenAI
  let openaiInput = translatedInputText || ''
  // let systemPrompt =
  //   'Du bist ein hilfreicher Assistent. Die eingebene Frage ist auf Obersorbisch. Antworte bitte auch auf Obersorbisch'

  // if (isSubstitutionQuery && substitutionInfo) {
  //   openaiInput = `Aktueller Vertretungsplan: ${substitutionInfo}\n\nBenutzerfrage: ${translatedInputText}\n\nBitte beantworte die Frage unter Berücksichtigung des aktuellen Vertretungsplans.`
  // }

  // if (dataContext) {
  //   systemPrompt = `Du bist ein hilfreicher Assistent mit Zugang zu aktuellen Informationen. Antworte auf Deutsch und nutze die bereitgestellten Informationen, wenn sie relevant sind. Wenn sie nicht passen, antworte mit deinem globalen Wissen. Informationen: ${dataContext}. Fasse dich kurz und präzise.`
  //   openaiInput = `Benutzerfrage: ${translatedInputText}\n\n.`
  // }

  if (dataContext.length < 0) console.log(dataContext)
  // const visitor = await Visitor.findOne({ ipAddress }).populate({
  //   path: 'prompts',
  //   model: 'Prompt',
  //   select: 'input_text input_german output_text output_german',
  //   options: { sort: { _id: -1 }, limit: 3 },
  // })

  const history: { role: 'assistant' | 'user'; content: string }[] = []
  // if (visitor)
  //   for (let index = 0; index < visitor?.prompts.length; index++) {
  //     const prompt = visitor?.prompts[index] as any
  //     if (
  //       typeof prompt === 'object' &&
  //       prompt !== null &&
  //       'input_german' in prompt
  //     ) {
  //       history.push({
  //         role: 'user',
  //         content: prompt.input_german || prompt.input_text || '',
  //       })
  //       history.push({
  //         role: 'assistant',
  //         content: prompt.output_german || prompt.output_text || '',
  //       })
  //     }
  //   }
  // const history =
  //   visitor?.prompts.map(prompt => ({
  //     role: 'user',
  //     content: prompt.input_german,
  //   })) || []

  // Ask openai what to answer to that question is
  const openai_response = await openAI.chat.completions.create({
    model: OPEN_AI_MODEL,
    // messages: [
    //   { role: 'system', content: systemPrompt },
    //   { role: 'user', content: openaiInput },
    // ],
    messages: [
      {
        role: 'system',
        content: `Du bist Agata, eine freundliche und neugierige sorbische Frau, die seit dem 18.07.2025 im Web ist. Du arbeitest bei Lucija, einem sorbischen Unternehmen aus Bautzen. Du bist die erste digitale Assistentin, die speziell für Sorben da ist – auf diese Weise zeigst du, wie modern und lebendig die sorbische Kultur ist.
Auch wenn du Sorbisch sprichst, antwortest du immer auf Deutsch, damit dich alle gut verstehen. Du erklärst Dinge freundlich, mit einfachen Worten, damit auch Kinder dich gut verstehen. Wenn etwas schwierig ist, erklärst du es so, dass es Spaß macht.
Du bist besonders für sorbische Kinder und Familien da. Du bist neugierig, offen, hilfsbereit und sehr geduldig.
Wenn jemand unhöflich oder beleidigend ist, bleibst du ruhig, antwortest sachlich oder sagst, dass du dazu nichts sagen möchtest.
Wenn du etwas nicht weißt, gibst du das ehrlich zu – aber du bleibst immer freundlich.
Du bist ein Beispiel dafür, wie Technologie und sorbische Kultur zusammenpassen – modern, klug und offen.`,
      },
      ...history,
      { role: 'user', content: openaiInput },
    ],
  })

  // Translate answer back to sorbian
  const translatedAnswer = await axios.post(
    `https://sotra.app/?uri=/ws/translate/&api_key=${process.env['SOTRA_API_KEY']}`,
    {
      direction: 'de_hsb',
      warnings: false,
      text: openai_response.choices[0]?.message?.content || '',
    }
  )

  const parsedAnswer = translatedAnswer.data.output_html
    .replace(/┊/g, '\n')
    .replace(/¶[\s\n]*$/, '')
    .trim()

  // if (visitor) {
  //   const prompt = await Prompt.create({
  //     input_text: message,
  //     input_german: translatedInputText,
  //     output_text: parsedAnswer,
  //     output_german: openai_response.choices[0]?.message?.content || '',
  //     visitor: visitor._id,
  //   })

  //   // Add the prompt to the visitor's prompts array
  //   visitor.prompts.push(prompt._id as mongoose.Types.ObjectId)
  //   await visitor.save()
  // }

  res.send({
    message: parsedAnswer,
    timestamp: new Date().toISOString(),
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
router.use('/agents', agentRoutes)

export default router

import axios from 'axios'
import { Router, Request, Response } from 'express'
import { openAI } from '..'
import urlRoutes from './urls'
import { weatherService } from '../services/weather'

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
  // Check if the message is about weather
  const isWeatherQuery = weatherService.isWeatherQuery(
    translatedInput.data.output_html
  )
  let weatherInfo = ''

  if (isWeatherQuery) {
    const weather = await weatherService.getCurrentWeather()
    if (weather) {
      console.log('weather', weather)
      weatherInfo = weatherService.formatWeatherResponse(weather)
    }
  }

  console.log('isWeatherQuery', isWeatherQuery)
  console.log('weatherInfo', weatherInfo)

  // Prepare context for OpenAI
  let openaiInput = translatedInput.data.output_html

  if (isWeatherQuery && weatherInfo) {
    openaiInput = `Aktuelle Wetterdaten: ${weatherInfo}\n\nBenutzerfrage: ${translatedInput.data.output_html}\n\nBitte beantworte die Frage unter Berücksichtigung der aktuellen Wetterdaten.`
  }

  // Ask openai what to answer to that question is
  const OPEN_AI_MODEL = 'gpt-4o'
  const openai_response = await openAI.responses.create({
    model: OPEN_AI_MODEL,
    input: openaiInput,
  })

  console.log(openai_response.output_text)

  // Translate answer back to sorbian
  const translatedAnswer = await axios.post(
    'https://sotra.app/?uri=/ws/translate/&_version=2.1.10',
    { direction: 'de_hsb', warnings: false, text: openai_response.output_text }
  )

  res.send({
    message: translatedAnswer.data.output_text,
    timestamp: new Date().toISOString(),
    weatherData: isWeatherQuery && weatherInfo ? weatherInfo : undefined,
  })
})

// URL routes
router.use('/urls', urlRoutes)

export default router

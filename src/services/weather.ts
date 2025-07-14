import axios from 'axios'

interface WeatherData {
  temperature: number
  description: string
  humidity: number
  windSpeed: number
  city: string
  country: string
}

export class WeatherService {
  private apiKey: string
  private baseUrl = 'https://api.openweathermap.org/data/2.5'

  constructor() {
    this.apiKey =
      process.env['OPENWEATHER_API_KEY'] || '8d2d1cab2dba3e179ea572dabcdf53db'
    if (!this.apiKey) {
      console.warn('OPENWEATHER_API_KEY not found in environment variables')
    }
  }

  async getCurrentWeather(
    city: string = 'Bautzen'
  ): Promise<WeatherData | null> {
    if (!this.apiKey) {
      console.error('OpenWeather API key not configured')
      return null
    }

    try {
      const response = await axios.get(`${this.baseUrl}/weather`, {
        params: {
          q: city,
          appid: this.apiKey,
          units: 'metric', // Use Celsius
          lang: 'de', // German language
        },
      })

      console.log('response', response.data)
      const data = response.data
      return {
        temperature: Math.round(data.main.temp),
        description: data.weather[0].description,
        humidity: data.main.humidity,
        windSpeed: Math.round(data.wind.speed * 3.6), // Convert m/s to km/h
        city: data.name,
        country: data.sys.country,
      }
    } catch (error) {
      console.error('Error fetching weather data:', error)
      return null
    }
  }

  formatWeatherResponse(weather: WeatherData): string {
    return `Aktuelles Wetter in ${weather.city}, ${weather.country}:
• Temperatur: ${weather.temperature}°C
• Beschreibung: ${weather.description}
• Luftfeuchtigkeit: ${weather.humidity}%
• Windgeschwindigkeit: ${weather.windSpeed} km/h`
  }

  isWeatherQuery(message: string): boolean {
    const weatherKeywords = [
      'wetter',
      'weather',
      'temperatur',
      'temperature',
      'regen',
      'rain',
      'sonnig',
      'sunny',
      'bewölkt',
      'cloudy',
      'schnee',
      'snow',
      'luftfeuchtigkeit',
      'humidity',
      'wind',
      'windig',
      'windy',
    ]

    const lowerMessage = message.toLowerCase()
    return weatherKeywords.some(keyword => lowerMessage.includes(keyword))
  }
}

export const weatherService = new WeatherService()

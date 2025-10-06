import { Agent, tool } from '@openai/agents'
import { fetchWeatherApi } from 'openmeteo'
import { z } from 'zod'

const getWeather = tool({
  name: 'get_weather',
  description: 'Return the weather for a given city.',
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    console.log('Getting weather for city:', city)

    const params = {
      latitude: 51.1803,
      longitude: 14.4349,
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'wind_speed_10m_max',
      ],
      timezone: 'Europe/Berlin',
      forecast_days: 1,
    }

    const url = 'https://api.open-meteo.com/v1/forecast'

    const response = await (await fetchWeatherApi(url, params)).at(0)

    const daily = response?.daily()!

    // Note: The order of weather variables in the URL query and the indices below need to match!
    const weatherData = {
      daily: {
        time: [
          ...Array(
            (Number(daily.timeEnd()) - Number(daily.time())) / daily.interval()
          ),
        ].map(
          (_, i) =>
            new Date(
              (Number(daily.time()) + i * daily.interval() + 7200) * 1000
            )
        ),
        weather_code: daily.variables(0)!.valuesArray(),
        temperature_2m_max: daily.variables(1)!.valuesArray(),
        temperature_2m_min: daily.variables(2)!.valuesArray(),
        wind_speed_10m_max: daily.variables(3)!.valuesArray(),
      },
    }

    return weatherData
  },
})

export const wjedroAgent = new Agent({
  name: 'Wjedro Agent',
  instructions: 'Sage mir wie das Wetter wird, In wenigen Wörtern',
  tools: [getWeather],
})

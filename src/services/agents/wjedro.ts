import { Agent, tool } from '@openai/agents'
import { z } from 'zod'

const getWeather = tool({
  name: 'get_weather',
  description: 'Return the weather for a given city.',
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    console.log('Getting weather for city:', city)
    return `Wjedro w ${city} je super.`
  },
})

export const wjedroAgent = new Agent({
  name: 'Wjedro Agent',
  instructions: 'Sage mir wie das Wetter wird, In 3 Wörtern',
  tools: [getWeather],
})

import { Agent } from '@openai/agents'

import { wjedroAgent } from './wjedro'

export const triageAgent = Agent.create({
  name: 'Triage Agent',
  instructions: `Heutiges Datum: ${new Date().toISOString()}. Wenn der Nutzer nach dem Wetter fragt, nutze wjedroAgent.`,
  handoffs: [wjedroAgent],
})

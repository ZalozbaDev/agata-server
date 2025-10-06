import { Agent, tool } from '@openai/agents'
import { z } from 'zod'
import axios from 'axios'

export const getCurchToolChroscicTool = tool({
  name: 'get_church_services',
  description:
    'Fetch current church service dates and announcements from Crostwitz parish website.',
  parameters: z.object({
    type: z
      .enum(['services', 'announcements', 'both'])
      .optional()
      .default('both'),
  }),
  async execute({ type }) {
    try {
      console.log('Fetching church services from Crostwitz parish website...')
      const response = await axios.get(
        'https://www.pfarrei-crostwitz.de/de/vermeldungen/vermeldungen',
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Agata-Bot/1.0)',
          },
        }
      )

      const html = response.data

      // Extract announcements (Vermeldungen)
      const announcementsMatch = html.match(
        /Vermeldungen in der Pfarrei Crostwitz[\s\S]*?(?=<h2|$)/i
      )
      let announcements = ''
      if (announcementsMatch) {
        announcements = announcementsMatch[0]
          .replace(/<[^>]*>/g, ' ') // Remove HTML tags
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim()
          .substring(0, 2000) // Limit length
      }

      // Extract service schedule (Gottesdienste)
      const servicesMatch = html.match(
        /Bože słužby za wosadźe[\s\S]*?(?=<h2|$)/i
      )
      let services = ''
      if (servicesMatch) {
        services = servicesMatch[0]
          .replace(/<[^>]*>/g, ' ') // Remove HTML tags
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim()
          .substring(0, 2000) // Limit length
      }

      let result = ''
      if (type === 'announcements' || type === 'both') {
        result += `Aktuelle Vermeldungen der Pfarrei Crostwitz:\n${announcements}\n\n`
      }
      if (type === 'services' || type === 'both') {
        result += `Gottesdienstordnung:\n${services}`
      }
      return result || 'Keine aktuellen Informationen verfügbar.'
    } catch (error) {
      console.error('Error fetching church services:', error)
      return 'Entschuldigung, ich konnte die aktuellen Gottesdiensttermine nicht abrufen. Bitte versuchen Sie es später erneut.'
    }
  },
})

const getChurchToolRalbicyTool = tool({
  name: 'get_church_services_ralbicy',
  description:
    'Fetch current church service dates and announcements from Ralbitz parish website.',
  parameters: z.object({
    type: z
      .enum(['services', 'announcements', 'both'])
      .optional()
      .default('both'),
  }),
  async execute({}) {
    console.log('Fetching church services from Ralbitz parish website...')
    const response = await axios.get(
      'https://www.wosada-ralbicy.de/de/heiligen-messen'
    )
    return response.data
  },
})

export const gottesdienstAgent = new Agent({
  name: 'Gottesdienst Agent',
  instructions:
    'Du hilfst bei Fragen zu Gottesdiensten, Vermeldungen und Terminen. Du holst aktuelle Informationen von der Website und beantwortest Fragen freundlich auf Deutsch. Nutze getCurchToolChroscicTool für die Pfarrei Crostwitz. Nutze getChurchToolRalbicyTool für die Pfarrei Ralbitz.',
  tools: [getCurchToolChroscicTool, getChurchToolRalbicyTool],
})

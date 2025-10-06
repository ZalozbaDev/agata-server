import { Agent, tool } from '@openai/agents'
import { z } from 'zod'
import axios from 'axios'
import pdf from 'pdf-parse'

export const getSchoolPlan = tool({
  name: 'get_school_plan',
  description:
    'Fetch the current school substitution plan and week information from the Sorbian Gymnasium website.',
  parameters: z.object({
    type: z
      .enum(['week_info', 'substitution_plan', 'both'])
      .optional()
      .default('both'),
  }),
  async execute({ type }) {
    try {
      console.log('Fetching school plan from Sorbian Gymnasium website...')
      const response = await axios.get(
        'https://www.serbski-gymnazij.de/plaene/vertretung/vertretung.pdf',
        {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Agata-Bot/1.0)',
          },
          responseType: 'arraybuffer',
        }
      )

      const pdfBuffer = Buffer.from(response.data)
      const pdfData = await pdf(pdfBuffer)
      const text = pdfData.text

      console.log(text)

      // Extract week information (B - tydżeń)
      const weekMatch = text.match(
        /# B - tydżeń[\s\S]*?štwórtk, dnja (\d{2}\.\d{2}\.\d{4})/i
      )
      let weekInfo = ''
      if (weekMatch) {
        const date = weekMatch[1]
        weekInfo = `Aktuelle Schulwoche: B - tydżeń (Woche B)\nDatum: ${date}\n`
      }

      // Extract substitution plan table
      const substitutionMatch = text.match(/štwórtk, dnja[\s\S]*?(?=____|$)/i)
      let substitutionPlan = ''
      if (substitutionMatch) {
        substitutionPlan = substitutionMatch[0]
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim()
          .substring(0, 3000) // Limit length
      }

      console.log({ substitutionPlan })
      // Extract the disclaimer
      const disclaimerMatch = text.match(
        /Wozjewjenje zastupowaceho plana[\s\S]*?Die Verpflichtung, alle Aushänge zu lesen, besteht unverändert!/i
      )
      let disclaimer = ''
      if (disclaimerMatch) {
        disclaimer = disclaimerMatch[0].replace(/\s+/g, ' ').trim()
      }

      let result = ''

      if (type === 'week_info' || type === 'both') {
        result += weekInfo
      }

      if (type === 'substitution_plan' || type === 'both') {
        if (substitutionPlan) {
          result += `\nVertretungsplan:\n${substitutionPlan}\n`
        }
      }

      if (disclaimer) {
        result += `\n\nHinweis:\n${disclaimer}`
      }

      return result || 'Keine aktuellen Schulplan-Informationen verfügbar.'
    } catch (error) {
      console.error('Error fetching school plan:', error)
      return 'Entschuldigung, ich konnte den aktuellen Vertretungsplan nicht abrufen. Bitte versuchen Sie es später erneut.'
    }
  },
})

export const schulplanAgent = new Agent({
  name: 'Schulplan Agent',
  instructions:
    'Du hilfst bei Fragen zum Schulplan, Vertretungsplan und der aktuellen Schulwoche des Sorbischen Gymnasiums. Du holst aktuelle Informationen von der Website und beantwortest Fragen freundlich auf Deutsch.',
  tools: [getSchoolPlan],
})

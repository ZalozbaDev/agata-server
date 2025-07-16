import axios from 'axios'
import pdf from 'pdf-parse'

interface SubstitutionEntry {
  time: string
  classroom: string
  subject: string
  teacher: string
  room: string
  remark: string
}

interface SubstitutionPlan {
  date: string
  entries: SubstitutionEntry[]
}

export class SubstitutionPlanService {
  private pdfUrl =
    'https://www.serbski-gymnazij.de/plaene/vertretung/vertretung.pdf'

  isSubstitutionQuery(message: string): boolean {
    const substitutionKeywords = [
      'zastup',
      'vertretung',
      'substitution',
      'plan',
      'stundenplan',
      'schedule',
      'vertretungsplan',
      'substitution plan',
    ]

    const lowerMessage = message.toLowerCase()
    return substitutionKeywords.some(keyword => lowerMessage.includes(keyword))
  }

  async fetchSubstitutionPlan(): Promise<SubstitutionPlan | null> {
    try {
      console.log('Fetching substitution plan from:', this.pdfUrl)

      const response = await axios.get(this.pdfUrl, {
        responseType: 'arraybuffer',
      })

      const pdfData = Buffer.from(response.data)
      const pdfResult = await pdf(pdfData)
      const allText = pdfResult.text

      console.log('Extracted PDF text:', allText)

      // Parse the table from the extracted text
      const parsedPlan = this.parseSubstitutionTable(allText)

      return parsedPlan
    } catch (error) {
      console.error('Error fetching substitution plan:', error)
      return null
    }
  }

  private parseSubstitutionTable(text: string): SubstitutionPlan | null {
    try {
      console.log('Parsing substitution table from text:', text)

      // Extract date from the text (looking for patterns like "wutora, dnja 11.02.2025")
      const dateMatch = text.match(/(\w+),\s*dnja\s+(\d{1,2}\.\d{1,2}\.\d{4})/)
      const date = dateMatch
        ? dateMatch[2] || new Date().toLocaleDateString('de-DE')
        : new Date().toLocaleDateString('de-DE')

      // Split text into lines and look for table data
      const lines = text.split('\n').filter(line => line.trim().length > 0)

      const entries: SubstitutionEntry[] = []
      let inTable = false

      for (const line of lines) {
        // Look for table header or data patterns
        if (
          line.includes('hodź.') ||
          line.includes('rjadownja') ||
          line.includes('předmjet')
        ) {
          inTable = true
          continue
        }

        if (inTable) {
          // Parse table rows - looking for patterns like "1./2. 8-1 JE knj. Bährowa 318 nadawki na lernsax"
          const rowMatch = line.match(
            /^(\d+\.\/\d+\.)\s+([^\s]+)\s+([^\s]+)\s+(.+?)\s+(\d+|[^\s]+)\s+(.+)$/
          )

          if (rowMatch) {
            const [, time, classroom, subject, teacher, room, remark] = rowMatch

            if (time && classroom && subject && teacher && room && remark) {
              entries.push({
                time: time.trim(),
                classroom: classroom.trim(),
                subject: subject.trim(),
                teacher: teacher.trim(),
                room: room.trim(),
                remark: remark.trim(),
              })
            }
          } else {
            // Try alternative parsing for rows with different formats
            const parts = line
              .split(/\s+/)
              .filter(part => part.trim().length > 0)
            if (parts.length >= 6) {
              entries.push({
                time: parts[0] || '',
                classroom: parts[1] || '',
                subject: parts[2] || '',
                teacher: parts[3] || '',
                room: parts[4] || '',
                remark: (parts.slice(5) || []).join(' ') || '',
              })
            }
          }
        }
      }

      console.log(`Parsed ${entries.length} substitution entries`)
      console.log('entries', entries)

      return {
        date,
        entries,
      }
    } catch (error) {
      console.error('Error parsing substitution table:', error)
      return null
    }
  }

  formatSubstitutionResponse(plan: SubstitutionPlan): string {
    if (!plan || plan.entries.length === 0) {
      return 'Aktuell sind keine Vertretungspläne verfügbar.'
    }

    let response = `Vertretungsplan für ${plan.date}:\n\n`

    plan.entries.forEach((entry, index) => {
      response += `${index + 1}. ${entry.time} | ${entry.classroom} | ${
        entry.subject
      } | ${entry.teacher} | ${entry.room} | ${entry.remark}\n`
    })

    return response
  }
}

export const substitutionPlanService = new SubstitutionPlanService()

/*
TODO: Next steps for substitution plan functionality:

1. **Improve PDF parsing accuracy**: The current regex-based parsing might not work perfectly with all PDF formats. 
   Using pdf-parse library for Node.js compatibility. Consider implementing a more robust table detection algorithm that can handle:
   - Different table layouts
   - Multi-line entries (like teacher names with line breaks)
   - Various date formats
   - Different column separators

2. **Add caching mechanism**: Implement caching for the PDF data to avoid repeated downloads.
   Store the parsed data in the database with a timestamp and refresh periodically.

3. **Enhance data structure**: Consider adding more fields to SubstitutionEntry interface:
   - originalText: string (raw text from PDF for debugging)
   - confidence: number (parsing confidence score)
   - isCancelled: boolean (for cancelled classes)
   - replacementTeacher: string (when there's a substitute)

4. **Add validation**: Implement validation for parsed data to ensure quality:
   - Check for reasonable time formats (1./2., 3./4., etc.)
   - Validate room numbers
   - Verify teacher name patterns

5. **Error handling improvements**: Add better error handling for:
   - PDF download failures
   - Malformed PDFs
   - Network timeouts
   - Parsing errors

6. **Testing**: Create unit tests for:
   - PDF text extraction
   - Table parsing logic
   - Date extraction
   - Various table formats

7. **API enhancements**: Consider adding endpoints for:
   - GET /api/substitution-plan (get current plan)
   - GET /api/substitution-plan/history (get historical plans)
   - POST /api/substitution-plan/refresh (force refresh)

8. **User experience**: Improve the response format to be more user-friendly:
   - Group entries by time slots
   - Highlight important changes (cancellations, room changes)
   - Add summary statistics (total changes, affected classes)
*/

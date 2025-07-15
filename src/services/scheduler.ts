import { dataManagerService } from './dataManager'
import { Url } from '../models/Url'

export class SchedulerService {
  private intervalId?: NodeJS.Timeout | undefined

  async startScheduledFetching(): Promise<void> {
    // this.intervalId = setInterval(async () => {
    try {
      console.log('🔄 Starting scheduled data fetch...')
      const urls = await Url.find({})
      console.log('👹urls: ' + urls.length)
      if (urls.length > 0) {
        const sources = urls.map(url => ({
          url: url.url,
          username: url.username || undefined,
          password: url.password || undefined,
          type: 'general' as const,
          description: url.description || undefined,
        }))

        await dataManagerService.fetchAndStoreData(sources.slice(0, 100))
        console.log('✅ Scheduled data fetch completed')
      }
    } catch (error) {
      console.error('❌ Scheduled data fetch failed:', error)
    }
  }
  // }, intervalMs)

  // console.log(
  //   `🕐 Scheduled data fetching started (interval: ${intervalMs}ms)`
  // )

  stopScheduledFetching(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
      console.log('🛑 Scheduled data fetching stopped')
    }
  }
}

export const schedulerService = new SchedulerService()

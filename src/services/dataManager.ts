import { FetchedData, IFetchedData } from '../models/FetchedData'
import { dataFetcherService, DataSource } from './dataFetcher'
import { openAI } from '../index'
import { Url, IUrl } from '../models/Url'
import * as cheerio from 'cheerio'
import { URL } from 'url'

export class DataManagerService {
  constructor() {
    // Ensure indexes are created when the service starts
    this.ensureIndexes()
  }

  private async ensureIndexes(): Promise<void> {
    try {
      console.log('🔧 Ensuring database indexes...')

      // Create indexes with error handling
      try {
        await FetchedData.createIndexes()
        console.log('✅ FetchedData indexes ensured')
      } catch (error: any) {
        if (error.code === 86) {
          // IndexKeySpecsConflict
          console.log('⚠️  Some indexes already exist, skipping...')
        } else {
          console.error('Error creating FetchedData indexes:', error.message)
        }
      }

      try {
        await Url.createIndexes()
        console.log('✅ Url indexes ensured')
      } catch (error: any) {
        if (error.code === 86) {
          // IndexKeySpecsConflict
          console.log('⚠️  Some URL indexes already exist, skipping...')
        } else {
          console.error('Error creating Url indexes:', error.message)
        }
      }

      console.log('✅ Database indexes setup completed')
    } catch (error: any) {
      console.error('Error in index setup:', error.message)
    }
  }

  async fetchAndStoreData(sources: DataSource[]): Promise<IFetchedData[]> {
    const fetchedData = await dataFetcherService.fetchMultipleSources(sources)
    const storedData: IFetchedData[] = []
    let newlyDiscoveredUrls: string[] = []

    for (const data of fetchedData) {
      try {
        // Check if data already exists for this URL
        const existing = await FetchedData.findOne({ url: data.url })

        if (existing) {
          // Update existing record
          existing.title = data.title
          existing.content = data.content
          if (data.rawHtml) {
            existing.rawHtml = data.rawHtml
          }
          existing.timestamp = data.timestamp
          existing.metadata = data.metadata || undefined
          existing.lastUpdated = new Date()
          await existing.save()
          storedData.push(existing)
        } else {
          // Create new record
          const newData = new FetchedData(data)
          await newData.save()
          storedData.push(newData)
        }

        // Extract and store internal links
        const discoveredLinks = await this.extractAndStoreInternalLinks(
          data.url,
          data.rawHtml || data.content,
          data.type
        )
        newlyDiscoveredUrls.push(...discoveredLinks)
      } catch (error) {
        console.error(`Error storing data for ${data.url}:`, error)
      }
    }

    // Process newly discovered URLs
    if (newlyDiscoveredUrls.length > 0) {
      console.log(
        `🔄 Processing ${newlyDiscoveredUrls.length} newly discovered URLs from initial sources...`
      )
      const recursiveData = await this.processStoredUrls()
      storedData.push(...recursiveData)
    }

    return storedData
  }

  private async extractAndStoreInternalLinks(
    sourceUrl: string,
    htmlContent: string,
    type: 'news' | 'private' | 'general'
  ): Promise<string[]> {
    try {
      const $ = cheerio.load(htmlContent)
      const baseUrl = new URL(sourceUrl)
      const internalLinks = new Set<string>()

      console.log(`🔍 Extracting links from ${sourceUrl}`)
      console.log(`📄 Content length: ${htmlContent.length} characters`)

      // Extract all links from the page
      const allLinks = $('a[href]')
      console.log(`🔗 Found ${allLinks.length} total links`)

      allLinks.each((_index, element) => {
        const href = $(element).attr('href')
        const linkText = $(element).text().trim()

        if (!href) return

        try {
          // Handle relative URLs
          const absoluteUrl = new URL(href, baseUrl.origin).href

          // Check if it's an internal link (same domain)
          if (absoluteUrl.startsWith(baseUrl.origin)) {
            // Filter out common non-content URLs
            const excludedPatterns = [
              /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|jpg|jpeg|png|gif|svg|ico|css|js)$/i,
              /^#/, // Anchor links
              /^javascript:/, // JavaScript links
              /^mailto:/, // Email links
              /^tel:/, // Phone links
              /\/login$/, // Login pages (exact match)
              /\/logout$/, // Logout pages (exact match)
              /\/admin$/, // Admin pages (exact match)
              /\/api\//, // API endpoints
              /\/search$/, // Search pages (exact match)
              /\/feed$/, // RSS feeds (exact match)
              /\/rss$/, // RSS feeds (exact match)
              /\/sitemap$/, // Sitemaps (exact match)
              /\/robots\.txt$/, // Robots file (exact match)
            ]

            const isExcluded = excludedPatterns.some(pattern =>
              pattern.test(absoluteUrl)
            )

            if (!isExcluded) {
              internalLinks.add(absoluteUrl)
              console.log(
                `✅ Found internal link: ${absoluteUrl} (text: "${linkText}")`
              )
            } else {
              console.log(
                `❌ Excluded link: ${absoluteUrl} (text: "${linkText}")`
              )
            }
          } else {
            console.log(
              `🌐 External link: ${absoluteUrl} (text: "${linkText}")`
            )
          }
        } catch (error) {
          // Skip invalid URLs
          console.debug(`⚠️ Invalid URL found: ${href}`)
        }
      })

      // Store internal links in the URL database
      const newlyDiscoveredUrls: string[] = []
      for (const link of internalLinks) {
        await this.storeUrlIfNotExists(link, type)
        newlyDiscoveredUrls.push(link)
      }

      console.log(
        `🎯 Extracted ${internalLinks.size} internal links from ${sourceUrl}`
      )
      return newlyDiscoveredUrls
    } catch (error) {
      console.error(`Error extracting internal links from ${sourceUrl}:`, error)
      return []
    }
  }

  private async storeUrlIfNotExists(
    url: string,
    type: 'news' | 'private' | 'general'
  ): Promise<void> {
    try {
      // Check if URL already exists
      const existing = await Url.findOne({ url })

      if (!existing) {
        // Create new URL entry
        const newUrl = new Url({
          url,
          type,
          description: `Internal link extracted from ${type} content`,
          isProcessed: false,
        })
        await newUrl.save()
        console.log(`Stored new internal URL: ${url} (type: ${type})`)
      } else if (!existing.isProcessed) {
        // Update type if not already processed
        existing.type = type
        await existing.save()
        console.log(`Updated type for existing URL: ${url} (type: ${type})`)
      }
    } catch (error) {
      console.error(`Error storing URL ${url}:`, error)
    }
  }

  async getRelevantData(
    query: string,
    type?: 'news' | 'private' | 'general'
  ): Promise<IFetchedData[]> {
    console.log(`🔍 Searching for relevant data for query: "${query}"`)

    const filter: any = { isActive: true }
    if (type) {
      filter.type = type
    }

    // Multi-stage search strategy
    const searchResults = await this.multiStageSearch(query, filter)

    if (searchResults.length > 0) {
      console.log(`✅ Found ${searchResults.length} relevant results`)
      return searchResults
    }

    // If no results found, try broader search without date filter
    console.log(`🔍 No results found, trying broader search...`)
    const broaderFilter: any = { isActive: true }
    if (type) {
      broaderFilter.type = type
    }

    const broaderResults = await this.multiStageSearch(query, broaderFilter)

    if (broaderResults.length > 0) {
      console.log(
        `✅ Found ${broaderResults.length} relevant results in broader search`
      )
      return broaderResults
    }

    // Last resort: OpenAI search
    console.log(
      `🤖 No relevant content found, using OpenAI for final search...`
    )
    return await this.openAISearch(query, filter)
  }

  private async multiStageSearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    // Stage 1: Exact phrase search (for quoted terms)
    const phraseResults = await this.exactPhraseSearch(query, filter)
    if (phraseResults.length > 0) {
      console.log(`🎯 Found ${phraseResults.length} results with exact phrases`)
      return phraseResults
    }

    // Stage 2: Enhanced semantic search with better scoring
    const semanticResults = await this.enhancedSemanticSearch(query, filter)
    if (semanticResults.length > 0) {
      console.log(
        `🧠 Found ${semanticResults.length} results with semantic search`
      )
      return semanticResults
    }

    // Stage 3: Improved fuzzy search with relevance scoring
    const fuzzyResults = await this.enhancedFuzzySearch(query, filter)
    if (fuzzyResults.length > 0) {
      console.log(`🔍 Found ${fuzzyResults.length} results with fuzzy search`)
      return fuzzyResults
    }

    // Stage 4: Title-focused search
    const titleResults = await this.titleSearch(query, filter)
    if (titleResults.length > 0) {
      console.log(`📋 Found ${titleResults.length} results with title search`)
      return titleResults
    }

    return []
  }

  private async exactPhraseSearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    try {
      // Extract phrases from query (words that should appear together)
      const phrases = this.extractPhrases(query)

      if (phrases.length === 0) return []

      const phraseConditions = phrases.map(phrase => ({
        $or: [
          { title: { $regex: phrase, $options: 'i' } },
          { content: { $regex: phrase, $options: 'i' } },
        ],
      }))

      const searchQuery = {
        ...filter,
        $and: phraseConditions,
      }

      const results = await FetchedData.find(searchQuery)
        .sort({ timestamp: -1 })
        .limit(10)
        .lean()

      return this.rankResults(results, query, 'exact')
    } catch (error) {
      console.error('Error in exact phrase search:', error)
      return []
    }
  }

  private async enhancedSemanticSearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    try {
      const queryTerms = this.extractKeyTerms(query)

      if (queryTerms.length === 0) return []

      // Try MongoDB text search first
      const textSearchQuery = {
        ...filter,
        $text: { $search: queryTerms.join(' ') },
      }

      let results = await FetchedData.find(textSearchQuery)
        .sort({ score: { $meta: 'textScore' } })
        .limit(15)
        .lean()

      // If text search fails or returns few results, use enhanced regex
      if (results.length < 3) {
        console.log(
          '📝 Text search returned few results, using enhanced regex...'
        )

        // Create weighted search conditions
        const searchConditions = queryTerms.map((term, index) => {
          const weight = queryTerms.length - index // Higher weight for earlier terms
          return {
            $or: [
              { title: { $regex: term, $options: 'i' } },
              { content: { $regex: term, $options: 'i' } },
            ],
            weight,
          }
        })

        const regexQuery = {
          ...filter,
          $or: searchConditions.map(condition => condition.$or),
        }

        results = await FetchedData.find(regexQuery)
          .sort({ timestamp: -1 })
          .limit(15)
          .lean()
      }

      return this.rankResults(results, query, 'semantic')
    } catch (error) {
      console.error('Error in enhanced semantic search:', error)
      return []
    }
  }

  private async enhancedFuzzySearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    try {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2)
        .slice(0, 5) // Increased from 3 to 5

      if (words.length === 0) return []

      // Create multiple search strategies
      const searchStrategies = [
        // Strategy 1: All words in title or content
        {
          $and: words.map(word => ({
            $or: [
              { title: { $regex: word, $options: 'i' } },
              { content: { $regex: word, $options: 'i' } },
            ],
          })),
        },
        // Strategy 2: Most words in title or content
        {
          $or: words.map(word => ({
            $or: [
              { title: { $regex: word, $options: 'i' } },
              { content: { $regex: word, $options: 'i' } },
            ],
          })),
        },
        // Strategy 3: Partial word matches
        {
          $or: words.map(word => ({
            $or: [
              {
                title: {
                  $regex: word.substring(0, Math.max(3, word.length - 1)),
                  $options: 'i',
                },
              },
              {
                content: {
                  $regex: word.substring(0, Math.max(3, word.length - 1)),
                  $options: 'i',
                },
              },
            ],
          })),
        },
      ]

      let allResults: any[] = []

      for (const strategy of searchStrategies) {
        const searchQuery = {
          ...filter,
          ...strategy,
        }

        const results = await FetchedData.find(searchQuery)
          .sort({ timestamp: -1 })
          .limit(10)
          .lean()

        allResults.push(...results)
      }

      // Remove duplicates and rank
      const uniqueResults = this.removeDuplicates(allResults)
      return this.rankResults(uniqueResults, query, 'fuzzy')
    } catch (error) {
      console.error('Error in enhanced fuzzy search:', error)
      return []
    }
  }

  private async titleSearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    try {
      const queryTerms = this.extractKeyTerms(query)

      if (queryTerms.length === 0) return []

      const titleConditions = queryTerms.map(term => ({
        title: { $regex: term, $options: 'i' },
      }))

      const searchQuery = {
        ...filter,
        $or: titleConditions,
      }

      const results = await FetchedData.find(searchQuery)
        .sort({ timestamp: -1 })
        .limit(10)
        .lean()

      return this.rankResults(results, query, 'title')
    } catch (error) {
      console.error('Error in title search:', error)
      return []
    }
  }

  private extractPhrases(query: string): string[] {
    // Extract phrases (consecutive words that might be important)
    const words = query.split(/\s+/)
    const phrases: string[] = []

    // Look for 2-4 word phrases
    for (let i = 0; i < words.length - 1; i++) {
      for (let j = 2; j <= 4 && i + j <= words.length; j++) {
        const phrase = words.slice(i, i + j).join(' ')
        if (phrase.length > 3) {
          phrases.push(phrase)
        }
      }
    }

    return phrases.slice(0, 3) // Limit to top 3 phrases
  }

  private removeDuplicates(results: any[]): any[] {
    const seen = new Set()
    return results.filter(result => {
      const id = result._id.toString()
      if (seen.has(id)) {
        return false
      }
      seen.add(id)
      return true
    })
  }

  private rankResults(
    results: any[],
    query: string,
    searchType: 'exact' | 'semantic' | 'fuzzy' | 'title'
  ): any[] {
    if (results.length === 0) return []

    const queryTerms = this.extractKeyTerms(query)
    const queryLower = query.toLowerCase()

    return results
      .map(result => {
        const title = result.title?.toLowerCase() || ''
        const content = result.content?.toLowerCase() || ''
        const url = result.url?.toLowerCase() || ''

        let score = 0

        // Base score based on search type
        switch (searchType) {
          case 'exact':
            score += 100
            break
          case 'semantic':
            score += 80
            break
          case 'title':
            score += 70
            break
          case 'fuzzy':
            score += 50
            break
        }

        // Title relevance (highest weight)
        queryTerms.forEach(term => {
          if (title.includes(term)) {
            score += 30
            // Bonus for exact title match
            if (title.includes(queryLower)) {
              score += 20
            }
          }
        })

        // Content relevance
        queryTerms.forEach(term => {
          const contentMatches = (content.match(new RegExp(term, 'gi')) || [])
            .length
          score += Math.min(contentMatches * 5, 25) // Cap at 25 points
        })

        // Recency bonus (newer content gets higher score)
        const daysOld =
          (Date.now() - new Date(result.timestamp).getTime()) /
          (1000 * 60 * 60 * 24)
        const recencyBonus = Math.max(0, 20 - daysOld)
        score += recencyBonus

        // Type relevance
        if (result.type === 'news') score += 5
        if (result.type === 'private') score += 3

        // URL relevance
        queryTerms.forEach(term => {
          if (url.includes(term)) {
            score += 10
          }
        })

        return { ...result, relevanceScore: score }
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 10) // Return top 10 results
      .map(({ relevanceScore, ...result }) => result) // Remove score from final results
  }

  private extractKeyTerms(query: string): string[] {
    // Enhanced stop words list
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'this',
      'that',
      'these',
      'those',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'me',
      'him',
      'her',
      'us',
      'them',
      'what',
      'when',
      'where',
      'why',
      'how',
      'who',
      'which',
      'whose',
      'whom',
      'get',
      'got',
      'getting',
      'want',
      'wanted',
      'need',
      'needed',
      'like',
      'liked',
      'see',
      'saw',
      'seen',
      'look',
      'looked',
      'find',
      'found',
      'search',
      'searched',
      'show',
      'showed',
      'tell',
      'told',
      'say',
      'said',
      'know',
      'knew',
      'think',
      'thought',
      'make',
      'made',
      'take',
      'took',
      'come',
      'came',
      'go',
      'went',
      'gone',
      'here',
      'there',
      'now',
      'then',
      'today',
      'yesterday',
      'tomorrow',
      'good',
      'bad',
      'big',
      'small',
      'new',
      'old',
      'first',
      'last',
      'next',
      'previous',
      'some',
      'any',
      'all',
      'every',
      'each',
      'many',
      'much',
      'few',
      'several',
      'very',
      'really',
      'quite',
      'just',
      'only',
      'even',
      'still',
      'also',
      'too',
      'as',
      'well',
      'so',
      'because',
      'since',
      'while',
      'during',
      'before',
      'after',
      'until',
      'from',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'up',
      'down',
      'out',
      'off',
      'over',
      'under',
      'again',
      'further',
      'then',
      'once',
    ])

    const words = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))

    // Return unique words, prioritizing longer and more specific words
    return [...new Set(words)]
      .sort((a, b) => {
        // Prioritize longer words
        if (b.length !== a.length) {
          return b.length - a.length
        }
        // Then prioritize words that appear earlier in the query
        return query.toLowerCase().indexOf(a) - query.toLowerCase().indexOf(b)
      })
      .slice(0, 8) // Increased from 5 to 8
  }

  private async openAISearch(
    query: string,
    filter: any
  ): Promise<IFetchedData[]> {
    try {
      // Get a small subset of recent data for OpenAI analysis
      // Use lean() and limit to prevent memory issues
      const data = await FetchedData.find(filter)
        .sort({ timestamp: -1 })
        .limit(20) // Reduced from unlimited to save costs
        .lean() // Use lean() for better performance

      if (data.length === 0) {
        console.log('📭 No data available for OpenAI search')
        return []
      }

      console.log(`🤖 Using OpenAI to analyze ${data.length} documents...`)
      const relevantData = await this.findMostRelevantData(query, data)

      if (relevantData.length > 0) {
        console.log(`✅ OpenAI found ${relevantData.length} relevant results`)
      } else {
        console.log(`❌ OpenAI found no relevant results`)
      }

      return relevantData
    } catch (error) {
      console.error('Error in OpenAI search:', error)
      return []
    }
  }

  private async findMostRelevantData(
    query: string,
    data: IFetchedData[]
  ): Promise<IFetchedData[]> {
    try {
      const dataSummaries = data.map(item => ({
        id: (item._id as any).toString(),
        title: item.title,
        content: item.content.substring(0, 500), // Limit content length
        type: item.type,
      }))

      const prompt = `
Given this query: "${query}"

And these data sources:
${dataSummaries
  .map(
    item => `
ID: ${item.id}
Title: ${item.title}
Type: ${item.type}
Content: ${item.content}
---`
  )
  .join('\n')}

Please return ONLY the IDs of the 3 most relevant data sources for the query, separated by commas. 
If none are relevant, return "none".

Response format: id1,id2,id3 or "none"
`

      const response = await openAI.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
      })

      const relevantIds = response.choices[0]?.message?.content?.trim()

      if (relevantIds && relevantIds !== 'none') {
        const ids = relevantIds.split(',').map(id => id.trim())
        return data.filter(item => ids.includes((item._id as any).toString()))
      }

      return []
    } catch (error) {
      console.error('Error finding relevant data:', error)
      // Fallback: return first 3 items
      return data.slice(0, 3)
    }
  }

  async generateContextFromData(data: IFetchedData[]): Promise<string> {
    if (data.length === 0) return ''

    const context = data
      .map(
        item => `
Source: ${item.url}
Title: ${item.title}
Type: ${item.type}
Content: ${item.content.substring(0, 1000)}${
          item.content.length > 1000 ? '...' : ''
        }
Last Updated: ${item.timestamp.toISOString()}
---`
      )
      .join('\n')

    return `Recent information from your data sources:\n${context}\n\nPlease use this information to answer the user's question. If the information is not relevant, you can ignore it and use your general knowledge.`
  }

  async cleanupOldData(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)

    await FetchedData.deleteMany({
      timestamp: { $lt: cutoffDate },
    })
  }

  async processStoredUrls(
    type?: 'news' | 'private' | 'general',
    depth: number = 0
  ): Promise<IFetchedData[]> {
    try {
      // Limit recursion depth to prevent infinite loops
      if (depth > 3) {
        console.log(
          `🛑 Stopping recursion at depth ${depth} to prevent infinite loops`
        )
        return []
      }

      // Get all stored URLs that haven't been processed yet
      const filter: any = { isProcessed: false }
      if (type) {
        filter.type = type
      }

      const storedUrls = await Url.find(filter)
      console.log(
        `Found ${storedUrls.length} unprocessed URLs to process (depth: ${depth})`
      )

      const processedData: IFetchedData[] = []
      let newlyDiscoveredUrls: string[] = []

      for (const urlDoc of storedUrls) {
        try {
          // Check if we already have data for this URL
          const existingData = await FetchedData.findOne({ url: urlDoc.url })

          if (existingData) {
            console.log(`Skipping ${urlDoc.url} - already has fetched data`)
            // Mark as processed even if we skip it
            urlDoc.isProcessed = true
            urlDoc.lastProcessed = new Date()
            await urlDoc.save()
            continue
          }

          // Create a DataSource object for fetching
          const dataSource: DataSource = {
            url: urlDoc.url,
            username: urlDoc.username,
            password: urlDoc.password,
            type: urlDoc.type || 'general',
            description: urlDoc.description,
          }

          // Fetch data from the URL
          const fetchedData = await dataFetcherService.fetchDataFromSource(
            dataSource
          )

          // Store the fetched data
          const newData = new FetchedData(fetchedData)
          await newData.save()
          processedData.push(newData)

          // Mark URL as processed
          urlDoc.isProcessed = true
          urlDoc.lastProcessed = new Date()
          await urlDoc.save()

          // Extract and store internal links from this page
          const discoveredLinks = await this.extractAndStoreInternalLinks(
            fetchedData.url,
            fetchedData.rawHtml || fetchedData.content,
            fetchedData.type
          )
          newlyDiscoveredUrls.push(...discoveredLinks)

          console.log(`Successfully processed: ${urlDoc.url}`)

          // Add a small delay to be respectful to servers
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (error) {
          console.error(`Error processing URL ${urlDoc.url}:`, error)
          // Mark as processed even if it failed to avoid infinite retries
          urlDoc.isProcessed = true
          urlDoc.lastProcessed = new Date()
          await urlDoc.save()
        }
      }

      // Process newly discovered URLs recursively
      if (newlyDiscoveredUrls.length > 0) {
        console.log(
          `🔄 Processing ${
            newlyDiscoveredUrls.length
          } newly discovered URLs (depth: ${depth + 1})...`
        )
        const recursiveData = await this.processStoredUrls(type, depth + 1)
        processedData.push(...recursiveData)
      }

      return processedData
    } catch (error) {
      console.error('Error processing stored URLs:', error)
      return []
    }
  }

  async getUrlStats(): Promise<{
    totalUrls: number
    processedUrls: number
    unprocessedUrls: number
    byType: {
      news: number
      private: number
      general: number
    }
  }> {
    const totalUrls = await Url.countDocuments()
    const processedUrls = await Url.countDocuments({ isProcessed: true })
    const unprocessedUrls = totalUrls - processedUrls

    const byType = {
      news: await Url.countDocuments({ type: 'news' }),
      private: await Url.countDocuments({ type: 'private' }),
      general: await Url.countDocuments({ type: 'general' }),
    }

    return {
      totalUrls,
      processedUrls,
      unprocessedUrls,
      byType,
    }
  }

  async getDatabaseStats(): Promise<{
    totalDocuments: number
    oldestDocument: Date | null
    newestDocument: Date | null
  }> {
    try {
      const totalDocuments = await FetchedData.countDocuments()

      // Get oldest and newest documents
      const oldest = await FetchedData.findOne()
        .sort({ timestamp: 1 })
        .select('timestamp')
        .lean()
      const newest = await FetchedData.findOne()
        .sort({ timestamp: -1 })
        .select('timestamp')
        .lean()

      return {
        totalDocuments,
        oldestDocument: oldest?.timestamp || null,
        newestDocument: newest?.timestamp || null,
      }
    } catch (error) {
      console.error('Error getting database stats:', error)
      return {
        totalDocuments: 0,
        oldestDocument: null,
        newestDocument: null,
      }
    }
  }

  async resetUrlProcessingStatus(
    type?: 'news' | 'private' | 'general'
  ): Promise<number> {
    try {
      const filter: any = {}
      if (type) {
        filter.type = type
      }

      const result = await Url.updateMany(filter, {
        $set: {
          isProcessed: false,
          lastProcessed: null,
        },
      })

      console.log(`Reset processing status for ${result.modifiedCount} URLs`)
      return result.modifiedCount
    } catch (error) {
      console.error('Error resetting URL processing status:', error)
      return 0
    }
  }

  async getUrlsByType(type: 'news' | 'private' | 'general'): Promise<IUrl[]> {
    try {
      return await Url.find({ type }).sort({ createdAt: -1 })
    } catch (error) {
      console.error(`Error fetching URLs by type ${type}:`, error)
      return []
    }
  }

  async debugLinkExtraction(url: string): Promise<{
    totalLinks: number
    internalLinks: string[]
    externalLinks: string[]
    excludedLinks: string[]
    errors: string[]
  }> {
    try {
      console.log(`🔍 Debugging link extraction for: ${url}`)

      // Fetch the page
      const dataSource: DataSource = {
        url,
        type: 'general',
      }

      const fetchedData = await dataFetcherService.fetchDataFromSource(
        dataSource
      )
      const htmlContent = fetchedData.rawHtml || fetchedData.content

      const $ = cheerio.load(htmlContent)
      const baseUrl = new URL(url)

      const result = {
        totalLinks: 0,
        internalLinks: [] as string[],
        externalLinks: [] as string[],
        excludedLinks: [] as string[],
        errors: [] as string[],
      }

      // Extract all links
      const allLinks = $('a[href]')
      result.totalLinks = allLinks.length

      console.log(`📄 Content length: ${htmlContent.length} characters`)
      console.log(`🔗 Found ${allLinks.length} total links`)

      allLinks.each((_index, element) => {
        const href = $(element).attr('href')
        const linkText = $(element).text().trim()

        if (!href) return

        try {
          // Handle relative URLs
          const absoluteUrl = new URL(href, baseUrl.origin).href

          // Check if it's an internal link (same domain)
          if (absoluteUrl.startsWith(baseUrl.origin)) {
            // Filter out common non-content URLs
            const excludedPatterns = [
              /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|jpg|jpeg|png|gif|svg|ico|css|js)$/i,
              /^#/, // Anchor links
              /^javascript:/, // JavaScript links
              /^mailto:/, // Email links
              /^tel:/, // Phone links
              /\/login$/, // Login pages (exact match)
              /\/logout$/, // Logout pages (exact match)
              /\/admin$/, // Admin pages (exact match)
              /\/api\//, // API endpoints
              /\/search$/, // Search pages (exact match)
              /\/feed$/, // RSS feeds (exact match)
              /\/rss$/, // RSS feeds (exact match)
              /\/sitemap$/, // Sitemaps (exact match)
              /\/robots\.txt$/, // Robots file (exact match)
            ]

            const isExcluded = excludedPatterns.some(pattern =>
              pattern.test(absoluteUrl)
            )

            if (!isExcluded) {
              result.internalLinks.push(`${absoluteUrl} (${linkText})`)
            } else {
              result.excludedLinks.push(`${absoluteUrl} (${linkText})`)
            }
          } else {
            result.externalLinks.push(`${absoluteUrl} (${linkText})`)
          }
        } catch (error) {
          result.errors.push(`Invalid URL: ${href}`)
        }
      })

      console.log(`✅ Internal links: ${result.internalLinks.length}`)
      console.log(`🌐 External links: ${result.externalLinks.length}`)
      console.log(`❌ Excluded links: ${result.excludedLinks.length}`)
      console.log(`⚠️ Errors: ${result.errors.length}`)

      return result
    } catch (error) {
      console.error(`Error debugging link extraction for ${url}:`, error)
      return {
        totalLinks: 0,
        internalLinks: [],
        externalLinks: [],
        excludedLinks: [],
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      }
    }
  }
}

export const dataManagerService = new DataManagerService()

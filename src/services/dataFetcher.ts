import axios, { AxiosRequestConfig } from 'axios'
import * as cheerio from 'cheerio'

export interface FetchedData {
  url: string
  title: string
  content: string
  rawHtml?: string // Add raw HTML for link extraction
  timestamp: Date
  type: 'news' | 'private' | 'general'
  metadata?:
    | {
        author?: string | undefined
        publishedDate?: string | undefined
        tags?: string[] | undefined
        summary?: string | undefined
      }
    | undefined
}

export interface DataSource {
  url: string
  username?: string | undefined
  password?: string | undefined
  type: 'news' | 'private' | 'general'
  description?: string | undefined
  selectors?:
    | {
        title?: string
        content?: string
        author?: string
        date?: string
        tags?: string
      }
    | undefined
}

export class DataFetcherService {
  private async makeRequest(
    url: string,
    username?: string,
    password?: string
  ): Promise<string> {
    const config: AxiosRequestConfig = {
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      // Disable SSL certificate verification for problematic URLs
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false,
      }),
    }

    // Add authentication if provided
    if (username && password) {
      config.auth = {
        username,
        password,
      }
    }

    try {
      const response = await axios.get(url, config)
      return response.data
    } catch (error) {
      console.error(`Error fetching ${url}:`, error)
      throw new Error(`Failed to fetch data from ${url}`)
    }
  }

  private extractContent(
    html: string,
    selectors?: DataSource['selectors']
  ): Partial<FetchedData> {
    const $ = cheerio.load(html)

    // Extract title
    let title = ''
    if (selectors?.title) {
      title = $(selectors.title).text().trim()
    } else {
      // Try multiple title selectors
      title =
        $('title').text().trim() ||
        $('h1').first().text().trim() ||
        $('.title, .headline, .post-title, .article-title')
          .first()
          .text()
          .trim() ||
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        ''
    }

    // Extract content with better structure
    let content = ''
    if (selectors?.content) {
      content = this.extractStructuredContent($, $(selectors.content))
    } else {
      // Try multiple content selectors in order of preference
      const contentSelectors = [
        'main',
        'article',
        '.content, .post-content, .entry-content, .article-content',
        '.main-content, .page-content',
        '.text-content, .body-content',
        '#content, #main',
        '.container .row .col',
        'body',
      ]

      for (const selector of contentSelectors) {
        const element = $(selector)
        if (element.length > 0) {
          content = this.extractStructuredContent($, element)
          if (content.length > 100) break // Found substantial content
        }
      }
    }

    // Extract metadata
    const author = this.extractAuthor($, selectors?.author)
    const publishedDate = this.extractDate($, selectors?.date)
    const tags = this.extractTags($, selectors?.tags)

    // Generate summary if content is long
    const summary =
      content.length > 500 ? this.generateSummary(content) : undefined

    return {
      title,
      content,
      metadata: {
        author: author || undefined,
        publishedDate: publishedDate || undefined,
        tags: tags || undefined,
        summary: summary || undefined,
      },
    }
  }

  private extractStructuredContent($: any, element: any): string {
    // Remove unwanted elements
    element
      .find(
        'script, style, nav, header, footer, .nav, .header, .footer, .sidebar, .ad, .advertisement, .ads, .comments, .comment, .social-share, .share, .related, .recommended'
      )
      .remove()

    // Extract text with better structure
    const paragraphs: string[] = []
    const headings: string[] = []

    // Extract headings for structure
    element.find('h1, h2, h3, h4, h5, h6').each((_: any, el: any) => {
      const heading = $(el).text().trim()
      if (heading && heading.length > 3) {
        headings.push(heading)
      }
    })

    // Extract paragraphs and list items
    element.find('p, li, div').each((_: any, el: any) => {
      const text = $(el).text().trim()
      if (text && text.length > 20 && !this.isNavigationOrFooter(text)) {
        paragraphs.push(text)
      }
    })

    // Combine content with structure
    let structuredContent = ''

    if (headings.length > 0) {
      structuredContent += 'SECTIONS:\n'
      headings.forEach(heading => {
        structuredContent += `• ${heading}\n`
      })
      structuredContent += '\n'
    }

    if (paragraphs.length > 0) {
      structuredContent += 'CONTENT:\n'
      paragraphs.forEach((paragraph, index) => {
        structuredContent += `${index + 1}. ${paragraph}\n\n`
      })
    }

    // If no structured content found, fall back to plain text
    if (!structuredContent.trim()) {
      structuredContent = element.text().trim()
    }

    return this.cleanAndFormatText(structuredContent)
  }

  private extractAuthor($: any, selector?: string): string | undefined {
    if (selector) {
      return $(selector).text().trim()
    }

    // Try multiple author selectors
    const authorSelectors = [
      '.author, .byline, .writer',
      '[rel="author"]',
      '.post-author, .article-author',
      'meta[name="author"]',
      'meta[property="article:author"]',
    ]

    for (const authorSelector of authorSelectors) {
      const author =
        $(authorSelector).text().trim() || $(authorSelector).attr('content')
      if (author && author.length > 0) {
        return author
      }
    }

    return undefined
  }

  private extractDate($: any, selector?: string): string | undefined {
    if (selector) {
      return $(selector).text().trim()
    }

    // Try multiple date selectors
    const dateSelectors = [
      '.date, .published, .time',
      'time[datetime]',
      '.post-date, .article-date',
      'meta[property="article:published_time"]',
      'meta[name="publish_date"]',
    ]

    for (const dateSelector of dateSelectors) {
      const date =
        $(dateSelector).text().trim() ||
        $(dateSelector).attr('datetime') ||
        $(dateSelector).attr('content')
      if (date && date.length > 0) {
        return date
      }
    }

    return undefined
  }

  private extractTags($: any, selector?: string): string[] | undefined {
    if (selector) {
      return $(selector)
        .map((_: any, el: any) => $(el).text().trim())
        .get()
    }

    // Try multiple tag selectors
    const tagSelectors = [
      '.tags .tag, .categories .category',
      '.post-tags .tag, .article-tags .tag',
      'meta[name="keywords"]',
      'meta[property="article:tag"]',
    ]

    for (const tagSelector of tagSelectors) {
      const tags = $(tagSelector)
        .map((_: any, el: any) => $(el).text().trim())
        .get()
      if (tags.length > 0) {
        return tags
      }
    }

    // Try meta keywords
    const keywords = $('meta[name="keywords"]').attr('content')
    if (keywords) {
      return keywords
        .split(',')
        .map((tag: any) => tag.trim())
        .filter((tag: any) => tag.length > 0)
    }

    return undefined
  }

  private generateSummary(content: string): string {
    // Simple summary generation - take first few sentences
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10)
    const summarySentences = sentences.slice(0, 3)
    return summarySentences.join('. ').trim() + '.'
  }

  private cleanAndFormatText(text: string): string {
    return text
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n\s*\n/g, '\n\n') // Replace multiple newlines with double newlines
      .replace(/\t/g, ' ') // Replace tabs with spaces
      .trim()
  }

  private isNavigationOrFooter(text: string): boolean {
    const navigationKeywords = [
      'home',
      'about',
      'contact',
      'privacy',
      'terms',
      'login',
      'sign up',
      'subscribe',
      'newsletter',
      'follow us',
      'share',
      'like',
      'comment',
      'copyright',
      'all rights reserved',
      'powered by',
      'designed by',
    ]

    const lowerText = text.toLowerCase()
    return navigationKeywords.some(keyword => lowerText.includes(keyword))
  }

  async fetchDataFromSource(source: DataSource): Promise<FetchedData> {
    const html = await this.makeRequest(
      source.url,
      source.username,
      source.password
    )
    const extracted = this.extractContent(html, source.selectors)

    return {
      url: source.url,
      title: extracted.title || 'No title found',
      content: extracted.content || 'No content found',
      rawHtml: html, // Add raw HTML to the fetched data
      timestamp: new Date(),
      type: source.type,
      metadata: extracted.metadata || undefined,
    }
  }

  async fetchMultipleSources(sources: DataSource[]): Promise<FetchedData[]> {
    const results: FetchedData[] = []
    let i = 0
    for (const source of sources) {
      i += 1
      try {
        console.log('👹i: ' + i + '/' + sources.length)
        const data = await this.fetchDataFromSource(source)
        results.push(data)
      } catch (error) {
        // console.error(`Failed to fetch from ${source.url}:`, error)
        // Continue with other sources even if one fails
      }
    }

    return results
  }

  isNewsQuery(message: string): boolean {
    const newsKeywords = [
      'nowiny',
      'news',
      'nachrichten',
      'aktualności',
      'aktualnosci',
      'novinky',
      'novosti',
      'latest',
      'recent',
      'update',
      'breaking',
      'headlines',
      'schlagzeilen',
    ]

    const lowerMessage = message.toLowerCase()
    return newsKeywords.some(keyword => lowerMessage.includes(keyword))
  }

  isPrivatePageQuery(message: string): boolean {
    const privateKeywords = [
      'private',
      'privat',
      'internal',
      'intern',
      'confidential',
      'vertraulich',
      'restricted',
      'zugangsbeschränkt',
      'login',
      'authenticated',
      'protected',
    ]

    const lowerMessage = message.toLowerCase()
    return privateKeywords.some(keyword => lowerMessage.includes(keyword))
  }
}

export const dataFetcherService = new DataFetcherService()

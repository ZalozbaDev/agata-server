import mongoose, { Document, Schema } from 'mongoose'

export interface IFetchedData extends Document {
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
  lastUpdated: Date
  isActive: boolean
}

const fetchedDataSchema = new Schema<IFetchedData>({
  url: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  content: {
    type: String,
    required: true,
    trim: true,
  },
  rawHtml: {
    type: String,
    trim: true,
    required: false,
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
  },
  type: {
    type: String,
    enum: ['news', 'private', 'general'],
    required: true,
    index: true,
  },
  metadata: {
    author: String,
    publishedDate: String,
    tags: [String],
    summary: String,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
})

// Index for efficient querying
fetchedDataSchema.index({ type: 1, timestamp: -1 })
fetchedDataSchema.index({ 'metadata.tags': 1 })

// Add compound indexes for search optimization
fetchedDataSchema.index({ isActive: 1, timestamp: -1 })
fetchedDataSchema.index({ isActive: 1, type: 1, timestamp: -1 })
fetchedDataSchema.index({ title: 'text', content: 'text' }) // Text search index
fetchedDataSchema.index({ timestamp: -1 }) // Simple timestamp index for sorting

export const FetchedData = mongoose.model<IFetchedData>(
  'FetchedData',
  fetchedDataSchema
)

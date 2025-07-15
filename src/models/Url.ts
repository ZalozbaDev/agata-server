import mongoose, { Document, Schema } from 'mongoose'

export interface IUrl extends Document {
  url: string
  username?: string
  password?: string
  description?: string
  type?: 'news' | 'private' | 'general'
  isProcessed?: boolean
  lastProcessed?: Date
  createdAt: Date
}

const urlSchema = new Schema<IUrl>({
  url: {
    type: String,
    required: true,
    trim: true,
  },
  username: {
    type: String,
    trim: true,
  },
  password: {
    type: String,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  type: {
    type: String,
    enum: ['news', 'private', 'general'],
    default: 'general',
  },
  isProcessed: {
    type: Boolean,
    default: false,
  },
  lastProcessed: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

export const Url = mongoose.model<IUrl>('Url', urlSchema)

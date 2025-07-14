import mongoose, { Document, Schema } from 'mongoose'

export interface IUrl extends Document {
  url: string
  username?: string
  password?: string
  description?: string
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

export const Url = mongoose.model<IUrl>('Url', urlSchema)

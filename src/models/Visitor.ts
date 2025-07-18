import mongoose, { Document, Schema } from 'mongoose'
import { IPrompt } from './Prompt'

export interface IVisitor extends Document {
  createdAt: Date
  lastVisitedAt: Date[]
  ipAddress: string
  prompts: IPrompt[]
}

const visitorSchema = new Schema<IVisitor>({
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  lastVisitedAt: {
    type: [Date],
    required: true,
    default: [],
  },
  ipAddress: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true,
  },
  prompts: [
    {
      type: mongoose.Types.ObjectId,
      ref: 'Prompt',
      required: true,
    },
  ],
})

visitorSchema.index({ ipAddress: 1, lastVisitedAt: -1 })

export const Visitor = mongoose.model<IVisitor>('Visitor', visitorSchema)

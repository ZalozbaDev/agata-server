import mongoose, { Document, Schema } from 'mongoose'
import { IVisitor } from './Visitor'

export interface IPrompt extends Document {
  createdAt: Date
  input: string
  output: string
  visitorId: IVisitor
}

const promptSchema = new Schema<IPrompt>({
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  input: {
    type: String,
    required: true,
    trim: true,
  },
  output: {
    type: String,
    required: true,
    trim: true,
  },
  visitorId: {
    type: mongoose.Types.ObjectId,
    required: true,
    ref: 'Visitor',
  },
})

export const Prompt = mongoose.model<IPrompt>('Prompt', promptSchema)

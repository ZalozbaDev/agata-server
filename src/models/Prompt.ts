import mongoose, { Document, Schema } from 'mongoose'

export interface IPrompt extends Document {
  createdAt: Date
  input_text: string
  output_text: string
  visitor: Schema.Types.ObjectId
}

const promptSchema = new Schema<IPrompt>({
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  input_text: {
    type: String,
    required: true,
    trim: true,
  },
  output_text: {
    type: String,
    required: true,
    trim: true,
  },
  visitor: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'Visitor',
  },
})

export const Prompt = mongoose.model<IPrompt>('Prompt', promptSchema)

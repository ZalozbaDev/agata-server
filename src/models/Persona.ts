import mongoose, { Document, Schema } from 'mongoose'

export type PersonaVisibility = 'public' | 'private'

export interface IPersona extends Document {
  name: string
  /** Short webview key, for example `schule` in `?persona=schule`. */
  slug?: string
  prompt: string
  token: string
  topK: number
  /** DuckDuckGo results per answer. 0 disables web search. */
  webResultCount: number
  tag: string
  visibility: PersonaVisibility
  allowExternalDelete: boolean
  createdAt: Date
  updatedAt: Date
}

const personaSchema = new Schema<IPersona>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    prompt: {
      type: String,
      default: '',
      maxlength: 20000,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    topK: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },
    webResultCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 20,
    },
    tag: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },
    visibility: {
      type: String,
      enum: ['public', 'private'],
      default: 'private',
      required: true,
    },
    allowExternalDelete: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true, collection: 'personas' },
)

export const Persona = mongoose.model<IPersona>('Persona', personaSchema)

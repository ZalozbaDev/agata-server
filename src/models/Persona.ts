import mongoose, { Document, Schema } from 'mongoose'

export type PersonaVisibility = 'public' | 'private'

export interface IPersona extends Document {
  name: string
  /** Short webview key, for example `schule` in `?persona=schule`. */
  slug?: string
  prompt: string
  /** Document language. Set at creation and never changed. */
  language?: 'de' | 'hsb' | 'dsb'
  token: string
  topK: number
  /** DuckDuckGo results per answer. 0 disables web search. */
  webResultCount: number
  /** Used when RAG returned nothing. Falls back to webResultCount when unset. */
  webFallbackResultCount?: number
  /** Qdrant collection. Empty means the managed persona_<id> collection. */
  ragCollection?: string
  allowGeneralKnowledge: boolean
  /** Main and Sip cannot be deleted. */
  protected: boolean
  imageFileId?: mongoose.Types.ObjectId
  imageMimeType?: string
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
    language: {
      type: String,
      enum: ['de', 'hsb', 'dsb'],
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
    webFallbackResultCount: {
      type: Number,
      min: 0,
      max: 20,
    },
    ragCollection: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    allowGeneralKnowledge: {
      type: Boolean,
      default: false,
    },
    protected: {
      type: Boolean,
      default: false,
    },
    imageFileId: {
      type: Schema.Types.ObjectId,
    },
    imageMimeType: {
      type: String,
      trim: true,
      maxlength: 80,
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

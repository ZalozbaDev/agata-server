import mongoose, { Document, Schema, Types } from 'mongoose'

export interface IPersonaDocument extends Document {
  personaId: Types.ObjectId
  filename: string
  mimeType: string
  size: number
  ragSourceId: string
  fileId?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const personaDocumentSchema = new Schema<IPersonaDocument>(
  {
    personaId: {
      type: Schema.Types.ObjectId,
      ref: 'Persona',
      required: true,
      index: true,
    },
    filename: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
    },
    size: {
      type: Number,
      required: true,
      min: 1,
    },
    ragSourceId: {
      type: String,
      required: true,
    },
    fileId: {
      type: Schema.Types.ObjectId,
    },
  },
  { timestamps: true, collection: 'personaDocuments' },
)

personaDocumentSchema.index({ personaId: 1, ragSourceId: 1 }, { unique: true })
personaDocumentSchema.index({ ragSourceId: 1 })

export const PersonaDocument = mongoose.model<IPersonaDocument>(
  'PersonaDocument',
  personaDocumentSchema,
)

import {
  DEFAULT_PERSONA_ID,
  DEFAULT_SPEAKER_ID,
  SIP_PERSONA_ID,
} from '../config/personas'
import { Persona } from '../models/Persona'
import {
  generatePersonaToken,
  isPersonaCollectionName,
} from '../services/personaPolicy'
import {
  MAIN_PERSONA_PROMPT,
  SIP_PERSONA_PROMPT,
} from './defaultPersonaPrompts'

type SeedPersona = {
  slug: string
  name: string
  prompt: string
}

const DEFAULTS: readonly SeedPersona[] = [
  { slug: DEFAULT_PERSONA_ID, name: 'Main', prompt: MAIN_PERSONA_PROMPT },
  { slug: SIP_PERSONA_ID, name: 'Sip', prompt: SIP_PERSONA_PROMPT },
]

/**
 * Creates Main and Sip when they are missing.
 * An existing prompt is left untouched so an admin edit survives a restart.
 */
export async function seedDefaultPersonas(): Promise<void> {
  for (const seed of DEFAULTS) {
    const existing = await Persona.findOne({ slug: seed.slug })
    if (!existing) {
      await Persona.create({
        name: seed.name,
        slug: seed.slug,
        prompt: seed.prompt,
        token: generatePersonaToken(),
        topK: 5,
        language: 'hsb',
        webResultCount: 5,
        webFallbackResultCount: 5,
        allowGeneralKnowledge: true,
        protected: true,
        tag: '',
        speakerId: DEFAULT_SPEAKER_ID,
        visibility: 'private',
        allowExternalUpload: false,
        allowExternalDelete: false,
      })
      continue
    }

    const patch: {
      protected?: boolean
      prompt?: string
      language?: 'hsb'
      speakerId?: string
    } = {}
    if (existing.protected !== true) patch.protected = true
    if (!existing.prompt?.trim()) patch.prompt = seed.prompt
    if (existing.language !== 'hsb') patch.language = 'hsb'
    if (!existing.speakerId?.trim()) patch.speakerId = DEFAULT_SPEAKER_ID
    const update: {
      $set?: typeof patch
      $unset?: { ragCollection: 1 }
    } = {}
    if (Object.keys(patch).length > 0) update.$set = patch
    if (
      existing.ragCollection &&
      !isPersonaCollectionName(existing.ragCollection)
    ) {
      update.$unset = { ragCollection: 1 }
    }
    if (update.$set || update.$unset) {
      await Persona.updateOne({ _id: existing._id }, update)
    }
  }

  await Persona.updateMany(
    {
      $or: [{ speakerId: { $exists: false } }, { speakerId: null }, { speakerId: '' }],
    },
    { $set: { speakerId: DEFAULT_SPEAKER_ID } },
  )

  // Public personas could already be filled by anyone with the access link.
  await Persona.updateMany(
    { allowExternalUpload: { $exists: false }, visibility: 'public' },
    { $set: { allowExternalUpload: true } },
  )
  await Persona.updateMany(
    { allowExternalUpload: { $exists: false } },
    { $set: { allowExternalUpload: false } },
  )
}

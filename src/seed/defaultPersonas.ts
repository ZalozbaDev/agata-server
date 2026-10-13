import { DEFAULT_PERSONA_ID, SIP_PERSONA_ID } from '../config/personas'
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
        webResultCount: 5,
        webFallbackResultCount: 5,
        allowGeneralKnowledge: true,
        protected: true,
        tag: '',
        visibility: 'private',
        allowExternalDelete: false,
      })
      continue
    }

    const patch: {
      protected?: boolean
      prompt?: string
    } = {}
    if (existing.protected !== true) patch.protected = true
    if (!existing.prompt?.trim()) patch.prompt = seed.prompt
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
}

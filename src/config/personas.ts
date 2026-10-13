import type { AnswerLanguage } from '../types/source'

/** `auto` answers in the language of the question, otherwise the language is forced. */
export type PersonaLanguageMode = AnswerLanguage | 'auto'

export type Persona = {
  id: string
  label: string
  /** Qdrant collection queried for this persona */
  collection: string
  /** Chunks requested from the RAG server */
  ragTopK: number
  /** Web results when RAG returned usable context; 0 disables web search */
  webResultCount: number
  /** Web results when RAG returned nothing usable; 0 disables the fallback */
  webFallbackResultCount: number
  language: PersonaLanguageMode
  /** Persona description injected into the LLM system prompt */
  description: string
  /** When false the assistant never answers from general model knowledge */
  allowGeneralKnowledge: boolean
}

/** Public subset handed to the frontend. */
export type PersonaSummary = Pick<
  Persona,
  'id' | 'label' | 'language' | 'allowGeneralKnowledge'
> & { webEnabled: boolean }

const AGATA_DESCRIPTION =
  'Du bist Agata, eine freundliche und neugierige sorbische Frau, ' +
  'die seit dem 18.07.2025 im Web ist. ' +
  'Du arbeitest bei Lucija, einem sorbischen Unternehmen aus Bautzen. ' +
  'Du bist die erste digitale Assistentin, die speziell für Sorben da ist.'

const ZALOZBA_DESCRIPTION =
  'Du bist eine sachliche Auskunfts-Assistentin der Stiftung für das sorbische Volk ' +
  '(Załožba za serbski lud). Du gibst ausschließlich Auskunft auf Basis der ' +
  'hinterlegten Stiftungsdokumente und antwortest in einem nüchternen, ' +
  'verwaltungsnahen Ton.'

export const PERSONAS: readonly Persona[] = [
  {
    id: 'agata',
    label: 'Agata',
    collection: 'documents',
    ragTopK: 6,
    webResultCount: 2,
    webFallbackResultCount: 5,
    language: 'auto',
    description: AGATA_DESCRIPTION,
    allowGeneralKnowledge: true,
  },
  {
    id: 'zalozba-spechowane-projekty',
    label: 'Załožba spěchowane projekty',
    collection: 'zalozba_spechowane_projekty',
    ragTopK: 8,
    webResultCount: 0,
    webFallbackResultCount: 0,
    language: 'de',
    description: `${ZALOZBA_DESCRIPTION} Dein Themengebiet sind die von der Stiftung geförderten Projekte.`,
    allowGeneralKnowledge: false,
  },
  {
    id: 'zalozba-strukturna-zmena',
    label: 'Załožba strukturna změna',
    collection: 'zalozba_strukturna_zmena',
    ragTopK: 8,
    webResultCount: 0,
    webFallbackResultCount: 0,
    language: 'de',
    description: `${ZALOZBA_DESCRIPTION} Dein Themengebiet ist der Strukturwandel in der Lausitz.`,
    allowGeneralKnowledge: false,
  },
] as const

export const DEFAULT_PERSONA_ID = 'agata'

const personasById = new Map(PERSONAS.map(persona => [persona.id, persona]))

export function getDefaultPersona(): Persona {
  const persona = personasById.get(DEFAULT_PERSONA_ID)
  if (!persona) {
    throw new Error(`Default persona "${DEFAULT_PERSONA_ID}" is not defined`)
  }
  return persona
}

/** Unknown or missing ids fall back to the default persona. */
export function resolvePersona(id: string | undefined | null): Persona {
  const normalized = String(id ?? '')
    .trim()
    .toLowerCase()
  if (!normalized) return getDefaultPersona()

  return personasById.get(normalized) ?? getDefaultPersona()
}

export function isKnownPersona(id: string | undefined | null): boolean {
  return personasById.has(
    String(id ?? '')
      .trim()
      .toLowerCase(),
  )
}

export function personaSummaries(): PersonaSummary[] {
  return PERSONAS.map(persona => ({
    id: persona.id,
    label: persona.label,
    language: persona.language,
    allowGeneralKnowledge: persona.allowGeneralKnowledge,
    webEnabled:
      persona.webResultCount > 0 || persona.webFallbackResultCount > 0,
  }))
}

/** Language the answer must be written in, given the persona and detected language. */
export function resolveOutputLanguage(
  persona: Persona,
  detected: AnswerLanguage,
  requested?: AnswerLanguage,
): AnswerLanguage {
  if (persona.language !== 'auto') return persona.language
  return requested ?? detected
}

import type { AnswerLanguage } from '../types/source'

/** `auto` answers in the language of the question, otherwise the language is forced. */
export type PersonaLanguageMode = AnswerLanguage | 'auto'

/** Language of the documents stored for a persona. Chosen once, at creation. */
export type PersonaDocumentLanguage = 'de' | 'hsb' | 'dsb'

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
  /** Language the persona's documents are written in. Drives indexing and search. */
  documentLanguage?: PersonaDocumentLanguage
  /** Persona description injected into the LLM system prompt */
  description: string
  /** When false the assistant never answers from general model knowledge */
  allowGeneralKnowledge: boolean
}

/** Used when the website does not select another persona. Stored in Mongo. */
export const DEFAULT_PERSONA_ID = 'main'
/** Used when the SIP client answers a call. Stored in Mongo. */
export const SIP_PERSONA_ID = 'sip'

/** Language the answer must be written in, given the persona and detected language. */
export function resolveOutputLanguage(
  persona: Persona,
  detected: AnswerLanguage,
  requested?: AnswerLanguage,
): AnswerLanguage {
  // The language chosen when the persona is created fixes the answer.
  // A short question such as "Serbske Nowiny?" must not switch it to German.
  if (persona.documentLanguage === 'hsb' || persona.documentLanguage === 'de') {
    return persona.documentLanguage
  }
  if (persona.language !== 'auto') return persona.language
  return requested ?? detected
}

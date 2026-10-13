/**
 * Persona access, validation and isolation rules.
 * Run: npm test
 */
import assert from 'assert'
import {
  PERSONA_TOKEN_PATTERN,
  assertManagedPersonaChatAccess,
  assertTokenDocumentAccess,
  canDeleteDocuments,
  canUploadDocuments,
  canViewDocuments,
  chatHistoryKey,
  classifyUpload,
  collectionNameForPersona,
  generatePersonaToken,
  isDuplicateSlugError,
  isDuplicateTokenError,
  normalizePersonaSlug,
  isPersonaCollectionName,
  parseCreatePersona,
  parseUpdatePersona,
  scopedDocumentQuery,
  toPublicPersonaView,
  toRuntimePersona,
  tokenGrantsAccess,
} from './personaPolicy'

const PERSONA_A = 'a'.repeat(24)
const PERSONA_B = 'b'.repeat(24)

function testAdminCanCreateAndValidationRejectsEmptyName() {
  const created = parseCreatePersona({
    name: '  Stiftung  ',
    slug: 'Schule',
    prompt: 'Antworte nur aus den Dokumenten.',
    topK: 3,
    tag: 'projekte',
    visibility: 'public',
    allowExternalDelete: false,
  })
  assert.strictEqual(created.name, 'Stiftung')
  assert.strictEqual(created.slug, 'schule')
  assert.strictEqual(created.topK, 3)
  assert.strictEqual(created.webResultCount, 0)
  assert.strictEqual(created.token, null)
  assert.strictEqual(created.allowExternalDelete, false)

  assert.throws(
    () => parseCreatePersona({ name: '   ', slug: 'schule', topK: 3 }),
    /Name/,
  )
  assert.throws(
    () => parseCreatePersona({ name: 'A', topK: 0 }),
    /ganze Zahl/,
  )
  assert.throws(
    () => parseCreatePersona({ name: 'A', topK: 3.5 }),
    /ganze Zahl/,
  )
}

function testManualTokensMustBeUniqueShape() {
  const first = parseCreatePersona({
    name: 'A',
    slug: 'persona-a',
    topK: 4,
    token: 'token-persona-aaaaaa',
  })
  const second = parseCreatePersona({
    name: 'B',
    slug: 'persona-b',
    topK: 10,
    token: 'token-persona-bbbbbb',
  })
  assert.notStrictEqual(first.token, second.token)
  assert.ok(first.token && PERSONA_TOKEN_PATTERN.test(first.token))
  assert.throws(
    () => parseCreatePersona({ name: 'A', slug: 'persona-a', topK: 4, token: 'kurz' }),
    /Token/,
  )
  assert.throws(
    () => parseUpdatePersona({ token: '' }),
    /nicht leer/,
  )
}

function testGeneratedTokenIsUrlSafe() {
  const token = generatePersonaToken()
  assert.ok(PERSONA_TOKEN_PATTERN.test(token))
  assert.notStrictEqual(token, generatePersonaToken())
}

function testDuplicateTokenErrorIsRecognized() {
  assert.strictEqual(
    isDuplicateTokenError({ code: 11000, keyPattern: { token: 1 } }),
    true,
  )
  assert.strictEqual(
    isDuplicateTokenError({ code: 11000, keyPattern: { ragSourceId: 1 } }),
    false,
  )
  assert.strictEqual(
    isDuplicateSlugError({ code: 11000, keyPattern: { slug: 1 } }),
    true,
  )
  assert.strictEqual(isDuplicateSlugError({ code: 11000, keyPattern: { token: 1 } }), false)
  assert.strictEqual(isDuplicateTokenError({ code: 121 }), false)
}

function testUpdateKeepsOmittedTokenAndCanReplaceIt() {
  const renamed = parseUpdatePersona({ name: 'Neu' })
  assert.strictEqual(renamed.name, 'Neu')
  assert.strictEqual('token' in renamed, false)

  const rotated = parseUpdatePersona({ token: 'rotated-token-value1' })
  assert.strictEqual(rotated.token, 'rotated-token-value1')
  assert.strictEqual(
    tokenGrantsAccess('rotated-token-value1', 'old-token-value-123456'),
    false,
  )
  assert.strictEqual(
    tokenGrantsAccess('rotated-token-value1', 'rotated-token-value1'),
    true,
  )
}

function testPublicTokenCanUploadPrivateTokenCannot() {
  assert.strictEqual(canUploadDocuments('public', 'token'), true)
  assert.strictEqual(canViewDocuments('public', 'token'), true)
  assert.strictEqual(canUploadDocuments('private', 'token'), false)
  assert.strictEqual(canViewDocuments('private', 'token'), false)
  assert.strictEqual(canUploadDocuments('private', 'admin'), true)

  assert.throws(
    () =>
      assertTokenDocumentAccess({
        visibility: 'private',
        allowExternalDelete: true,
        action: 'upload',
      }),
    /privat/,
  )
}

function testExternalDeleteFollowsTheFlag() {
  assert.strictEqual(canDeleteDocuments('public', false, 'token'), false)
  assert.strictEqual(canDeleteDocuments('public', true, 'token'), true)
  assert.strictEqual(canDeleteDocuments('private', true, 'token'), false)
  assert.strictEqual(canDeleteDocuments('private', false, 'admin'), true)
  assert.throws(
    () =>
      assertTokenDocumentAccess({
        visibility: 'public',
        allowExternalDelete: false,
        action: 'delete',
      }),
    /nicht freigegeben/,
  )
}

function testDocumentsStayInSeparateCollections() {
  const collectionA = collectionNameForPersona(PERSONA_A)
  const collectionB = collectionNameForPersona(PERSONA_B)
  assert.notStrictEqual(collectionA, collectionB)
  assert.ok(isPersonaCollectionName(collectionA))
  assert.strictEqual(isPersonaCollectionName('documents'), false)
  assert.strictEqual(isPersonaCollectionName('zalozba_spechowane_projekty'), false)

  const queryA = scopedDocumentQuery(PERSONA_A, PERSONA_B)
  const queryB = scopedDocumentQuery(PERSONA_B, PERSONA_B)
  assert.strictEqual(queryA.personaId, PERSONA_A)
  assert.notStrictEqual(queryA.personaId, queryB.personaId)
  assert.ok(queryA.personaId)
}

function testRuntimePersonaUsesItsOwnTopKAndPrompt() {
  const personaA = toRuntimePersona({
    id: PERSONA_A,
    name: 'A',
    prompt: 'Du bist Persona A.',
    topK: 3,
  })
  const personaB = toRuntimePersona({
    id: PERSONA_B,
    name: 'B',
    prompt: 'Du bist Persona B.',
    topK: 10,
  })
  assert.strictEqual(personaA.ragTopK, 3)
  assert.strictEqual(personaB.ragTopK, 10)
  assert.strictEqual(personaA.description, 'Du bist Persona A.')
  assert.strictEqual(personaB.description, 'Du bist Persona B.')
  assert.notStrictEqual(personaA.collection, personaB.collection)
  assert.strictEqual(personaA.webResultCount, 0)
  assert.strictEqual(personaA.webFallbackResultCount, 0)
  assert.strictEqual(personaA.allowGeneralKnowledge, false)
  assert.notStrictEqual(chatHistoryKey(personaA.id, '1.2.3.4'), chatHistoryKey(personaB.id, '1.2.3.4'))

  const webview = toRuntimePersona({
    id: 'schule',
    collectionId: PERSONA_A,
    name: 'Schule',
    prompt: 'Du bist die Schule.',
    topK: 4,
    webResultCount: 3,
  })
  assert.strictEqual(webview.id, 'schule')
  assert.strictEqual(webview.collection, `persona_${PERSONA_A}`)
  assert.strictEqual(webview.webResultCount, 3)
  assert.strictEqual(webview.webFallbackResultCount, 3)
  assert.notStrictEqual(webview.id, PERSONA_A)
}

function testWebResultCountDefaultsToZeroAndRejectsOutOfRange() {
  const created = parseCreatePersona({ name: 'A', slug: 'schule', topK: 3, webResultCount: 5 })
  assert.strictEqual(created.webResultCount, 5)
  assert.strictEqual(parseUpdatePersona({ webResultCount: 0 }).webResultCount, 0)
  assert.throws(
    () => parseCreatePersona({ name: 'A', slug: 'schule', topK: 3, webResultCount: -1 }),
    /Web-Ergebnisse/,
  )
  assert.throws(
    () => parseCreatePersona({ name: 'A', slug: 'schule', topK: 3, webResultCount: 21 }),
    /Web-Ergebnisse/,
  )
  assert.throws(
    () => parseUpdatePersona({ webResultCount: 2.5 }),
    /ganze Zahl/,
  )
}

function testShortSlugIsEditableAndReservedNamesAreRejected() {
  assert.strictEqual(normalizePersonaSlug('  Kindergarten '), 'kindergarten')
  assert.strictEqual(parseUpdatePersona({ slug: 'Spielplatz' }).slug, 'spielplatz')
  assert.throws(() => parseCreatePersona({ name: 'A', slug: 'agata', topK: 3 }), /reserviert/)
  assert.throws(() => parseUpdatePersona({ slug: '' }), /Kurzname/)
  assert.throws(() => parseCreatePersona({ name: 'A', slug: 'a', topK: 3 }), /Kurzname/)
}

function testChangingTokenInvalidatesTheOldLink() {
  const stored = 'first-public-token-111'
  assert.strictEqual(tokenGrantsAccess(stored, stored), true)
  assert.strictEqual(tokenGrantsAccess('second-public-token-22', stored), false)
}

function testPublicViewHidesAdminSettings() {
  const view = toPublicPersonaView({
    name: 'Offen',
    tag: 'faq',
    allowExternalDelete: true,
    documentCount: 2,
  })
  const keys = Object.keys(view).sort()
  assert.deepStrictEqual(keys, [
    'canDelete',
    'canUpload',
    'documentCount',
    'name',
    'tag',
    'visibility',
  ])
  assert.strictEqual(view.canDelete, true)
  assert.ok(!('prompt' in view))
  assert.ok(!('token' in view))
  assert.ok(!('topK' in view))
}

function testPrivateChatIsRejectedWithoutAdmin() {
  assert.throws(() => assertManagedPersonaChatAccess('private', false), /privat/)
  assert.doesNotThrow(() => assertManagedPersonaChatAccess('private', true))
  assert.doesNotThrow(() => assertManagedPersonaChatAccess('public', false))
}

function testUploadTypesFollowTheRagServer() {
  assert.strictEqual(classifyUpload('a.pdf', 'application/pdf').kind, 'pdf')
  assert.strictEqual(classifyUpload('a.html', 'text/html').kind, 'html')
  assert.throws(() => classifyUpload('a.docx', 'application/octet-stream'), /PDF/)
}

const tests: Array<[string, () => void]> = [
  ['admin input can be created and empty names fail', testAdminCanCreateAndValidationRejectsEmptyName],
  ['two personas cannot share a token shape', testManualTokensMustBeUniqueShape],
  ['generated tokens are unique and url-safe', testGeneratedTokenIsUrlSafe],
  ['duplicate token errors are recognized', testDuplicateTokenErrorIsRecognized],
  ['token changes invalidate the previous token', testUpdateKeepsOmittedTokenAndCanReplaceIt],
  ['public tokens can upload and private tokens cannot', testPublicTokenCanUploadPrivateTokenCannot],
  ['external delete follows the permission flag', testExternalDeleteFollowsTheFlag],
  ['documents of two personas stay in separate collections', testDocumentsStayInSeparateCollections],
  ['each persona keeps its own topK and prompt', testRuntimePersonaUsesItsOwnTopKAndPrompt],
  ['web result count is optional and defaults to zero', testWebResultCountDefaultsToZeroAndRejectsOutOfRange],
  ['short slug maps the webview key and can be changed', testShortSlugIsEditableAndReservedNamesAreRejected],
  ['old token links stop matching after a change', testChangingTokenInvalidatesTheOldLink],
  ['public responses hide prompt and token', testPublicViewHidesAdminSettings],
  ['private personas cannot be queried without admin', testPrivateChatIsRejectedWithoutAdmin],
  ['uploads accept the rag server formats', testUploadTypesFollowTheRagServer],
]

let failed = 0
for (const [name, run] of tests) {
  try {
    run()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}

console.log(`\nAll ${tests.length} tests passed`)

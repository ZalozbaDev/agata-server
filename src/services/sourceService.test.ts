/**
 * Manual unit tests for source validation / merging.
 * Run: npm test
 */
import assert from 'assert'
import {
  assignSourceIds,
  extractSourceRefsFromAnswer,
  normalizeRagSources,
  normalizeWebSources,
  parseOllamaAnswerJson,
  pickSourcesByIds,
  stripInvalidSourceRefs,
  validateOllamaAnswer,
} from './sourceService'
import type { Source } from '../types/source'

function makeSources(): Source[] {
  return assignSourceIds([
    {
      type: 'rag',
      title: 'Geschichte der Stadt Bautzen',
      documentId: null,
      documentUrl: '/documents/bautzen',
      page: null,
      section: null,
      snippet: 'Erste Erwähnung 1002.',
    },
    {
      type: 'web',
      title: 'Bautzen – Stadtgeschichte',
      url: 'https://example.org/bautzen',
      domain: 'example.org',
      publishedAt: null,
      imageUrl: null,
      snippet: 'Erwähnung als Budusin.',
    },
    {
      type: 'rag',
      title: 'Unused doc',
      documentId: null,
      documentUrl: null,
      page: null,
      section: null,
      snippet: 'Irrelevant.',
    },
  ])
}

function testUsedSourcesOnly() {
  const available = makeSources()
  const validated = validateOllamaAnswer(
    {
      language: 'hsb',
      title: 'Test',
      answer: 'Informacija [[S1]][[S2]].',
      sourcesUsed: ['S1', 'S2'],
    },
    available,
  )
  const sources = pickSourcesByIds(available, validated.sourcesUsed)
  assert.deepStrictEqual(
    sources.map(s => s.id),
    ['S1', 'S2'],
  )
  assert.ok(!sources.some(s => s.id === 'S3'))
}

function testUnknownSourceIdDropped() {
  const available = makeSources()
  const validated = validateOllamaAnswer(
    {
      language: 'de',
      title: 'Test',
      answer: 'Nur S1 [[S1]].',
      sourcesUsed: ['S1', 'S99'],
    },
    available,
  )
  assert.deepStrictEqual(validated.sourcesUsed, ['S1'])
  assert.ok(!validated.sourcesUsed.includes('S99'))
}

function testInvalidTextReferenceRemoved() {
  const available = makeSources()
  const validated = validateOllamaAnswer(
    {
      language: 'de',
      title: 'Test',
      answer: 'Text [[S1]][[S99]].',
      sourcesUsed: ['S1', 'S99'],
    },
    available,
  )
  assert.strictEqual(validated.answer.includes('[[S99]]'), false)
  assert.strictEqual(validated.answer.includes('[[S1]]'), true)
  assert.deepStrictEqual(validated.sourcesUsed, ['S1'])
}

function testOnlyReferencedSourcesReturned() {
  const available = makeSources()
  const validated = validateOllamaAnswer(
    {
      language: 'de',
      title: 'Test',
      answer: 'Nur zweite Quelle [[S2]].',
      sourcesUsed: ['S1', 'S2', 'S3'],
    },
    available,
  )
  const sources = pickSourcesByIds(available, validated.sourcesUsed)
  assert.deepStrictEqual(
    sources.map(s => s.id),
    ['S2'],
  )
}

function testNoSources() {
  const validated = validateOllamaAnswer(
    {
      language: 'hsb',
      title: 'Test',
      answer: 'Njemóžu to wotmołwić.',
      sourcesUsed: [],
    },
    [],
  )
  assert.deepStrictEqual(validated.sourcesUsed, [])
  assert.deepStrictEqual(pickSourcesByIds([], validated.sourcesUsed), [])
}

function testRagAndWebMetadataPreserved() {
  const rag = normalizeRagSources(
    ['Erste Erwähnung 1002.'],
    [
      {
        source_type: 'pdf',
        source_url: '/documents/bautzen',
        title: 'Geschichte der Stadt Bautzen',
      },
    ],
  )
  const web = normalizeWebSources([
    {
      title: 'Bautzen – Stadtgeschichte',
      url: 'https://example.org/bautzen',
      snippet: 'Erwähnung als Budusin.',
    },
  ])
  const sources = assignSourceIds([...rag, ...web])

  assert.strictEqual(sources[0]?.type, 'rag')
  assert.strictEqual(sources[0]?.documentUrl, '/documents/bautzen')
  assert.strictEqual(sources[0]?.documentId, null)
  assert.strictEqual(sources[0]?.page, null)

  assert.strictEqual(sources[1]?.type, 'web')
  assert.strictEqual(sources[1]?.url, 'https://example.org/bautzen')
  assert.strictEqual(sources[1]?.domain, 'example.org')
  assert.strictEqual(sources[1]?.imageUrl, null)

  const validated = validateOllamaAnswer(
    {
      language: 'de',
      title: 'Gründung',
      answer: 'Beide [[S1]][[S2]].',
      sources_used: ['S1', 'S2'],
    },
    sources,
  )
  const picked = pickSourcesByIds(sources, validated.sourcesUsed)
  assert.strictEqual(picked.length, 2)
  assert.strictEqual(picked[0]?.type, 'rag')
  assert.strictEqual(picked[1]?.type, 'web')
  assert.strictEqual(picked[1]?.url, 'https://example.org/bautzen')
}

function testStripAndExtractHelpers() {
  const ids = extractSourceRefsFromAnswer('A [[S1]] B [[S2]][[S1]]')
  assert.deepStrictEqual(ids, ['S1', 'S2'])

  const cleaned = stripInvalidSourceRefs('A [[S1]] B [[S99]]', new Set(['S1']))
  assert.strictEqual(cleaned, 'A [[S1]] B ')
}

function testParseJsonWithFence() {
  const parsed = parseOllamaAnswerJson(
    '```json\n{"language":"de","title":"T","answer":"A","sourcesUsed":[]}\n```',
  )
  assert.deepStrictEqual(parsed, {
    language: 'de',
    title: 'T',
    answer: 'A',
    sourcesUsed: [],
  })
}

const tests: Array<[string, () => void]> = [
  ['used sources only (S1+S2, not S3)', testUsedSourcesOnly],
  ['unknown source id S99 dropped', testUnknownSourceIdDropped],
  ['invalid [[S99]] removed from answer text', testInvalidTextReferenceRemoved],
  ['only S2 when only S2 referenced', testOnlyReferencedSourcesReturned],
  ['no sources yields empty sources', testNoSources],
  ['rag + web metadata preserved', testRagAndWebMetadataPreserved],
  ['strip/extract helpers', testStripAndExtractHelpers],
  ['parse fenced JSON', testParseJsonWithFence],
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

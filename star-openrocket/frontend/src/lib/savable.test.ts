/**
 * Every field of a saved design must be read back out of the stored copy.
 *
 * A design here is a plain typed object -- `OrkConfig = {cad, recovery}` -- and
 * loading one is a hand-written revive function that rebuilds it field by
 * field. That shape is deliberate (see lib/persist.ts: a spread would resurrect
 * fields the app has since retired, and would leave a field added later
 * `undefined` rather than defaulted). The cost is that every field has to be
 * named twice: once in the interface, once in the reviver.
 *
 * TypeScript covers half of that. A reviver returns a `ViewerConfig`, so a
 * field missing from the returned literal is a compile error and nobody can
 * ship it. What compiles perfectly well is:
 *
 *     hiddenKeys: base.hiddenKeys,
 *
 * The field is present, the types line up, the value saves to the server on
 * every autosave tick -- and comes back as the default every single time. The
 * user hides three parts, reloads, and they are visible again. Nothing errors,
 * nothing is logged, and the save file on disk is correct, which is what makes
 * this the expensive kind of bug to chase. It is the same failure the engine
 * design tools hit from the other direction, where the fields were never in the
 * payload at all.
 *
 * So this audit checks the one thing the compiler cannot: that each field is
 * read from *the stored blob* rather than from the defaults. Anything genuinely
 * not restorable is listed in UNREAD below with a reason, which keeps the
 * exceptions few and visible.
 *
 * Scope: top-level fields of the design roots. Nested objects (`vehicle`,
 * `site`, a device) are spread-merged onto their defaults, so a field added
 * inside one is carried automatically and there is nothing to forget. It is
 * exactly the enumerated level that needs watching.
 */

import { describe, expect, it } from 'vitest'

/**
 * The design roots and the function that restores each.
 *
 * `type` is looked up in `typeFile`, `reviver` in `reviverFile`, both by name
 * in the raw source. The last test below fails if either stops resolving, so a
 * rename cannot quietly turn this whole audit into a no-op that passes.
 */
interface Reviver {
  type: string
  typeFile: string
  reviver: string
  reviverFile: string
}

const REVIVERS: Reviver[] = [
  { type: 'ViewerConfig', typeFile: 'types/config.ts', reviver: 'reviveViewerConfig', reviverFile: 'lib/persist.ts' },
  { type: 'FlightParams', typeFile: 'types/config.ts', reviver: 'revivedFlight', reviverFile: 'lib/persist.ts' },
  { type: 'OrkConfig', typeFile: 'types/config.ts', reviver: 'reviveOrkConfig', reviverFile: 'lib/persist.ts' },
  // The recovery half keeps its own root and its own reviver; the unified
  // design nests it whole, so it has to be audited on its own terms.
  { type: 'UiConfig', typeFile: 'recovery/types/schema.ts', reviver: 'reviveUiConfig', reviverFile: 'recovery/lib/persist.ts' },
]

/**
 * Interfaces in types/config.ts that are not a saved design, with a reason.
 *
 * A deny-list, not an allow-list, and the first test enforces it: every
 * exported interface in that file must either have a reviver above or be named
 * here. An allow-list would only ever cover the types somebody remembered to
 * add, so a brand new design root -- the exact thing whose fields go missing --
 * would sail straight past the audit that exists to catch it.
 */
const NOT_A_DESIGN: Record<string, string> = {}

/**
 * Fields that are deliberately NOT read back from the stored copy, with a
 * reason each. Keyed `Type.field`.
 */
const UNREAD: Record<string, string> = {
  'ViewerConfig.version': 'the schema version, re-stamped on revive; reading the blob\'s own back would defeat the point of having one',
  'OrkConfig.version': 'as above -- the version describes the shape this build writes, not the shape it read',
}

/** Receivers that are the defaults, not the stored blob. A field read only from
 *  one of these is precisely the bug this file exists to catch. */
const DEFAULTS = new Set(['base', 'defaults'])

const raw = {
  ...import.meta.glob('../types/*.ts', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('./*.ts', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('../recovery/types/*.ts', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('../recovery/lib/*.ts', { eager: true, query: '?raw', import: 'default' }),
} as Record<string, string>

/**
 * Source with comments blanked out, same length so offsets still line up.
 *
 * Both halves need this. These files explain themselves at length, and a doc
 * comment above `hiddenKeys` that says "saved.hiddenKeys" would otherwise count
 * as the read -- an audit that passes on its own prose is worse than none. It
 * also keeps comment text from being parsed as interface fields. `//` is only a
 * comment when it does not follow a colon, so a `https://` in a string lives.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
}

/**
 * Glob keys are relative to this file (src/lib/); resolve them to src-relative
 * paths so a lookup can be exact. It has to be exact: `recovery/lib/persist.ts`
 * and `lib/persist.ts` both end in the same three segments, and a suffix match
 * would let the recovery reviver stand in for the CAD one.
 */
function resolveKey(key: string): string {
  const parts = ['src', 'lib']
  for (const seg of key.split('/')) {
    if (seg === '.' || seg === '') continue
    else if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

const files: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([p, src]) => [resolveKey(p), stripComments(src)]),
)

/** The file at exactly `src/<name>`. */
function sourceOf(name: string): string | null {
  return files[`src/${name}`] ?? null
}

/** The `{...}` starting at the first `{` at or after `from`, brace-matched. */
function blockAt(src: string, from: number): string | null {
  const open = src.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return null
}

/** Every `export interface X` in a file. */
function exportedInterfaces(src: string): string[] {
  return [...src.matchAll(/export\s+interface\s+(\w+)\s*\{/g)].map((m) => m[1])
}

/**
 * Top-level field names of an interface.
 *
 * Depth-tracked so a nested object literal's own keys are not mistaken for
 * fields of the parent, and so a union spanning lines does not swallow the
 * field after it.
 */
function interfaceFields(src: string, name: string): string[] {
  const m = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(src)
  if (!m) return []
  const body = blockAt(src, m.index)
  if (body === null) return []

  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const f = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/.exec(line)
      if (f) fields.push(f[1])
    }
    for (const c of line) {
      if (c === '{' || c === '(' || c === '[') depth++
      else if (c === '}' || c === ')' || c === ']') depth--
    }
  }
  return fields
}

/** A named function's body. */
function functionBody(src: string, name: string): string | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  // Past the parameter list first: a default value in the signature could
  // otherwise be mistaken for the body.
  const parens = src.indexOf('(', m.index)
  let depth = 0
  let i = parens
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) break
  }
  return blockAt(src, i)
}

/** True when `body` reads `field` off something that is not the defaults. */
function readsFromStored(body: string, field: string): boolean {
  const re = new RegExp(`(\\w+)\\s*\\.\\s*${field}\\b`, 'g')
  for (const m of body.matchAll(re)) if (!DEFAULTS.has(m[1])) return true
  return false
}

describe('every saved design field is restored from the stored design', () => {
  it('classifies every exported interface in types/config.ts', () => {
    const src = sourceOf('types/config.ts')
    expect(src, 'types/config.ts not found').not.toBeNull()

    const audited = new Set(REVIVERS.map((r) => r.type))
    const unclassified = exportedInterfaces(src!).filter(
      (name) => !audited.has(name) && !(name in NOT_A_DESIGN),
    )
    expect(
      unclassified,
      `these design types have no reviver and no NOT_A_DESIGN reason: ${unclassified.join(', ')}.\n` +
        'Add it to REVIVERS so its fields are audited, or to NOT_A_DESIGN saying why it is not saved.',
    ).toEqual([])
  })

  it.each(REVIVERS)('$reviver restores every field of $type', ({ type, typeFile, reviver, reviverFile }) => {
    const types = sourceOf(typeFile)
    const revivers = sourceOf(reviverFile)
    expect(types, `${typeFile} not found`).not.toBeNull()
    expect(revivers, `${reviverFile} not found`).not.toBeNull()

    const fields = interfaceFields(types!, type)
    expect(fields.length, `no fields parsed out of ${type} -- the audit would pass vacuously`).toBeGreaterThan(0)

    const body = functionBody(revivers!, reviver)
    expect(body, `${reviver} not found in ${reviverFile}`).not.toBeNull()

    const dropped = fields.filter(
      (f) => !(`${type}.${f}` in UNREAD) && !readsFromStored(body!, f),
    )
    expect(
      dropped,
      `${reviver} never reads these back from the stored design: ${dropped.join(', ')}.\n` +
        'They save, but load as the default every time -- the user\'s value is silently lost on reload.\n' +
        `Read each from the parsed blob, or add "${type}.<field>" to UNREAD with a reason.`,
    ).toEqual([])
  })

  it('keeps every UNREAD exemption pointing at a real field', () => {
    const stale = Object.keys(UNREAD).filter((key) => {
      const [type, field] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
      const entry = REVIVERS.find((r) => r.type === type)
      if (!entry) return true
      const src = sourceOf(entry.typeFile)
      return !src || !interfaceFields(src, type).includes(field)
    })
    expect(stale, `UNREAD names fields that no longer exist: ${stale.join(', ')}`).toEqual([])
  })

  it('keeps every registered type and reviver pointing at real source', () => {
    const missing: string[] = []
    for (const { type, typeFile, reviver, reviverFile } of REVIVERS) {
      const types = sourceOf(typeFile)
      const revivers = sourceOf(reviverFile)
      if (!types) missing.push(`${typeFile} (for ${type})`)
      else if (!interfaceFields(types, type).length) missing.push(`interface ${type} in ${typeFile}`)
      if (!revivers) missing.push(`${reviverFile} (for ${reviver})`)
      else if (functionBody(revivers, reviver) === null) missing.push(`function ${reviver} in ${reviverFile}`)
    }
    expect(missing, `REVIVERS points at source that no longer exists: ${missing.join(', ')}`).toEqual([])
  })
})

/**
 * Design identity: keyOf / refOf.
 *
 * Every list, select and modal row in the sharing UI is keyed on these, and a
 * design is now (owner, id) rather than id alone. Two people can own designs
 * with the same id -- "design-1" is the default name for everyone -- so an
 * identity that collapses to the bare id would let one person's row select,
 * rename or overwrite another's.
 */

import { describe, expect, it } from 'vitest'
import { keyOf, refOf, type DocMeta } from '../api/documents'

const meta = (over: Partial<DocMeta>): DocMeta => ({
  id: 'design-1',
  name: 'Design 1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('keyOf', () => {
  it('separates the same id owned by different people', () => {
    expect(keyOf({ id: 'design-1', owner: 'alice@berkeley.edu' }))
      .not.toBe(keyOf({ id: 'design-1', owner: 'bob@berkeley.edu' }))
  })

  it('treats a null owner and an absent owner as the same design (both mean "mine")', () => {
    expect(keyOf({ id: 'design-1', owner: null })).toBe(keyOf({ id: 'design-1' }))
  })

  it('does not confuse my design with someone else of the same id', () => {
    expect(keyOf({ id: 'design-1' })).not.toBe(keyOf({ id: 'design-1', owner: 'alice@berkeley.edu' }))
  })
})

describe('refOf', () => {
  it('omits the owner for my own designs, so no ?owner= is sent', () => {
    expect(refOf(meta({ mine: true, owner: 'me@berkeley.edu' })).owner).toBeNull()
  })

  it('keeps the owner for a design shared with me, so ?owner= is sent', () => {
    expect(refOf(meta({ mine: false, owner: 'alice@berkeley.edu' })).owner).toBe('alice@berkeley.edu')
  })

  it('round-trips through keyOf so a listed row matches the active selection', () => {
    const shared = meta({ mine: false, owner: 'alice@berkeley.edu' })
    expect(keyOf(refOf(shared))).toBe(keyOf({ id: 'design-1', owner: 'alice@berkeley.edu' }))
  })

  it('falls back to "mine" against a server too old to send owner/mine', () => {
    // The field is optional in DocMeta for exactly this case; treating an
    // unknown design as someone else's would send ?owner=undefined.
    expect(refOf(meta({})).owner).toBeNull()
  })
})

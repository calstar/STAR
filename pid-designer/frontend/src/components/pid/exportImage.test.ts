import { describe, expect, it } from 'vitest';
import { fileStem, titleRows } from './exportImage';

describe('what an exported sheet says about itself', () => {
  it('names the drawing, the sheet, the revision and the date', () => {
    const rows = titleRows({ name: 'Ethalox Stand', page: 'GSE', release: '0.3', date: new Date('2026-09-12T00:00:00Z') });
    expect(rows).toEqual([
      ['DRAWING', 'Ethalox Stand'], ['SHEET', 'GSE'], ['REV', '0.3'], ['DATE', '2026-09-12'],
    ]);
  });

  it('says so when it is a working copy rather than a release', () => {
    // An unreleased drawing printed with no revision reads as a release.
    expect(titleRows({ name: 'x', page: 'Main', release: null })[2]).toEqual(['REV', 'working copy']);
  });

  it('makes a file name out of a drawing name', () => {
    expect(fileStem({ name: 'Ethalox Stand 7200N (Helium)', page: 'Main' }))
      .toBe('Ethalox Stand 7200N (Helium) - Main');
    expect(fileStem({ name: 'a/b:c', page: 'p?' })).toBe('a-b-c - p-');
  });
});

const TOOLBAR = Object.values(import.meta.glob('./PIDToolbar.tsx', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>)[0];

describe('what the export menu says each file is for', () => {
  it('does not offer the SVG for a document, which it is not', () => {
    // exportSvg is html-to-image's toSvg: the page's HTML in a foreignObject,
    // 8.35 MB for LE4 (3)'s GSE sheet. Browsers draw it; Inkscape, Word,
    // LibreOffice and PDF converters do not.
    const row = /exportImage\('svg'\)[^>]*?title="([^"]*)"\s+hint="([^"]*)"/s.exec(TOOLBAR)!;
    expect(row[1]).toMatch(/browser/i);
    expect(row[2]).not.toMatch(/scalable, for a document/);
    expect(row[2]).toMatch(/for a document, use a PNG/);
  });
});

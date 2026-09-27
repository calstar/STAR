// Input validation and the JSON shapes the hub and panel see.
import { config } from './config.ts';
import { EDITABLE_FIELDS, type CustomField, type Link, type Part, type PartEdit } from './db.ts';
import { isRendering } from './library.ts';

export class BadRequest extends Error {}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

function cleanLinks(value: unknown): Link[] {
  if (!Array.isArray(value)) throw new BadRequest('links must be a list');
  return value
    .map((l) => ({ label: str(l?.label, 200), url: str(l?.url, 2000) }))
    .filter((l) => l.url)
    .map((l) => {
      let url: URL;
      try {
        url = new URL(/^[a-z][\w+.-]*:/i.test(l.url) ? l.url : `https://${l.url}`);
      } catch {
        throw new BadRequest(`Not a valid link: ${l.url}`);
      }
      // Only web links: these end up as clickable hrefs in the hub and the Onshape panel.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest(`Links must be http(s): ${l.url}`);
      return { label: l.label || url.hostname.replace(/^www\./, ''), url: url.toString() };
    });
}

function cleanCustomFields(value: unknown): CustomField[] {
  if (!Array.isArray(value)) throw new BadRequest('customFields must be a list');
  return value
    .map((f) => ({ key: str(f?.key, 200), value: str(f?.value, 2000) }))
    .filter((f) => f.key || f.value);
}

function cleanTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((t) => str(t, 60)).filter(Boolean))].slice(0, 40);
}

function cleanCost(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new BadRequest('Cost must be a positive number');
  return Math.round(n * 100) / 100;
}

/** Validate an edit coming from the hub. Unknown keys are ignored. */
export function cleanEdit(body: Record<string, unknown>): PartEdit {
  const out: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    switch (field) {
      case 'name':
        out.name = str(v, 200);
        if (!out.name) throw new BadRequest('Display name is required');
        break;
      case 'description':
      case 'notes':
        out[field] = str(v, 20000);
        break;
      case 'tags':
        out.tags = cleanTags(v);
        break;
      case 'unitCost':
        out.unitCost = cleanCost(v);
        break;
      case 'links':
        out.links = cleanLinks(v);
        break;
      case 'customFields':
        out.customFields = cleanCustomFields(v);
        break;
      default:
        out[field] = str(v, 200);
    }
  }
  return out as PartEdit;
}

export const thumbUrl = (p: Part) => (p.thumbnailFile ? `/panel/media/thumbs/${p.thumbnailFile}` : null);

/** What the Onshape panel gets: display fields only, nothing about files or Onshape internals. */
export function catalogJson(p: Part) {
  return {
    id: p.id,
    name: p.name,
    partNumber: p.partNumber,
    vendor: p.vendor,
    category: p.category,
    tags: p.tags,
    unitCost: p.unitCost,
    costNote: p.costNote,
    description: p.description,
    notes: p.notes,
    links: p.links,
    customFields: p.customFields,
    thumbUrl: thumbUrl(p),
    hubUrl: `${config.publicBaseUrl}/#/parts/${p.id}`,
  };
}

export function hubJson(p: Part) {
  const { originalPath, translationId, thumbnailFile, ...rest } = p;
  return {
    ...rest,
    thumbUrl: thumbUrl(p),
    rendering: isRendering(p.id),
    hasOriginal: Boolean(originalPath),
    onshapeUrl: !p.documentId
      ? null
      : p.versionId && p.elementId
        ? `${config.onshape.baseUrl}/documents/${p.documentId}/v/${p.versionId}/e/${p.elementId}`
        : `${config.onshape.baseUrl}/documents/${p.documentId}`,
  };
}

/** CAD formats Onshape's translator imports (STEP first). */
export const CAD_EXTENSIONS = [
  'step', 'stp', 'iges', 'igs', 'sldprt', 'sldasm', 'x_t', 'x_b', 'xmt_txt', 'xmt_bin', 'sat', 'sab',
  'jt', 'catpart', 'catproduct', 'prt', 'asm', 'ipt', 'iam', 'par', 'psm', '3dm', 'stl', 'obj', '3mf',
  'zip',
];

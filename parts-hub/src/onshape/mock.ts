// In-memory fake of the Onshape API so the hub and panel can be developed and
// demoed without credentials (MOCK_ONSHAPE=1). Thumbnails are drawn as SVG.
import crypto from 'node:crypto';
import { OnshapeError, type OnshapeClient, type TranslationState } from './client.ts';

const hexId = (seed: string) => crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Part Studios added straight to the fake library doc, for "Check Onshape for new parts". */
export const MOCK_EXISTING = [
  { id: hexId('existing-1'), name: '1/4 Male Connector SS' },
  { id: hexId('existing-2'), name: '3/8 Tee SS' },
  { id: hexId('existing-3'), name: 'Pressure Transducer 0-3000 psi' },
];

export function createMockClient(): OnshapeClient {
  const elements = new Map<string, string>(MOCK_EXISTING.map((e) => [e.id, e.name]));
  const translations = new Map<string, { polls: number; elementId: string; fail: boolean; filename: string }>();
  let versionCount = 1;
  /** What nameParts last named each Part Studio's parts (for tests). */
  const partNamesByElement = new Map<string, string>();
  (globalThis as { __mockPartNames?: Map<string, string> }).__mockPartNames = partNamesByElement;
  /** What setPartProperties last set as each Part Studio's mass, in kg (for tests). */
  const massByElement = new Map<string, number>();
  (globalThis as { __mockMasses?: Map<string, number> }).__mockMasses = massByElement;

  return {
    async libraryWorkspaceId() {
      return hexId('workspace');
    },
    async startImport(filePath, filename) {
      const id = hexId('translation-' + Math.random());
      const elementId = hexId('element-' + Math.random());
      translations.set(id, { polls: 0, elementId, fail: /fail/i.test(filePath + filename), filename });
      return id;
    },
    async getTranslations(ids) {
      await sleep(300);
      const out = new Map<string, TranslationState>();
      for (const id of ids) {
        const t = translations.get(id);
        if (!t) throw new OnshapeError(404, 'no such translation', 'mock getTranslations');
        if (++t.polls < 3) out.set(id, { state: 'ACTIVE', resultElementIds: [], failureReason: '' });
        else if (t.fail) out.set(id, { state: 'FAILED', resultElementIds: [], failureReason: 'Mock: file names containing "fail" fail' });
        else {
          elements.set(t.elementId, t.filename);
          out.set(id, { state: 'DONE', resultElementIds: [hexId('blob-' + id), t.elementId], failureReason: '' });
        }
      }
      return out;
    },
    async setPartProperties(studios) {
      for (const s of studios) {
        if (s.name) partNamesByElement.set(s.elementId, s.name);
        if (s.massKg === null) massByElement.delete(s.elementId);
        else if (s.massKg !== undefined) massByElement.set(s.elementId, s.massKg);
      }
    },
    async listPartStudios() {
      return [...elements].map(([id, name]) => ({ id, name }));
    },
    async createVersion() {
      return hexId('version-' + ++versionCount);
    },
    async renderThumbnail(_versionId, elementId) {
      const name = elements.get(elementId) ?? '';
      return { data: Buffer.from(mockThumbnailSvg(name)), ext: 'svg' };
    },
    async insertPartStudio(auth, target, source) {
      await sleep(400);
      if (auth.kind === 'bearer' && !auth.token) throw new OnshapeError(401, 'no token', 'mock insert');
      // An assembly the member can't use (or a library shared without Link permission).
      if (target.documentId === 'd'.repeat(24)) throw new OnshapeError(403, 'Resource does not exist, or you do not have permission to access it.', 'mock insert');
      console.log(`[mock] insert ${source.elementId}@${source.versionId} into ${target.documentId}/w/${target.workspaceId}/e/${target.elementId}`);
    },
  };
}

/** A small isometric-ish drawing whose shape follows the part name and hue follows its hash. */
export function mockThumbnailSvg(name: string): string {
  const hue = crypto.createHash('md5').update(name).digest()[0] * 1.4;
  const light = `hsl(${hue} 30% 82%)`;
  const mid = `hsl(${hue} 22% 64%)`;
  const dark = `hsl(${hue} 20% 42%)`;
  const n = name.toLowerCase();
  let body: string;
  if (/valve/.test(n)) {
    body = `<rect x="60" y="130" width="180" height="60" rx="10" fill="${mid}"/>
      <rect x="120" y="100" width="60" height="110" rx="8" fill="${light}"/>
      <rect x="140" y="60" width="20" height="45" fill="${dark}"/>
      <rect x="95" y="50" width="110" height="18" rx="9" fill="hsl(8 70% 55%)"/>`;
  } else if (/bolt|screw|nut|washer|shcs|fastener/.test(n)) {
    body = `<polygon points="110,70 190,70 215,110 190,150 110,150 85,110" fill="${light}" stroke="${dark}" stroke-width="3"/>
      <rect x="130" y="150" width="40" height="110" fill="${mid}"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="130" y1="${165 + i * 16}" x2="170" y2="${173 + i * 16}" stroke="${dark}" stroke-width="3"/>`).join('')}`;
  } else if (/sensor|transducer|gauge|switch/.test(n)) {
    body = `<rect x="105" y="60" width="90" height="140" rx="16" fill="${light}" stroke="${dark}" stroke-width="3"/>
      <polygon points="115,200 185,200 200,225 185,250 115,250 100,225" fill="${mid}"/>
      <rect x="135" y="250" width="30" height="25" fill="${dark}"/>
      <path d="M150 60 C150 30 210 30 230 50" stroke="${dark}" stroke-width="6" fill="none"/>`;
  } else if (/tee|cross/.test(n)) {
    body = `<rect x="40" y="130" width="220" height="44" rx="6" fill="${mid}"/>
      <rect x="128" y="60" width="44" height="90" rx="6" fill="${mid}"/>
      <polygon points="120,110 180,110 195,152 180,194 120,194 105,152" fill="${light}" stroke="${dark}" stroke-width="3"/>`;
  } else {
    body = `<rect x="30" y="135" width="240" height="34" rx="6" fill="${mid}"/>
      <polygon points="70,105 120,105 135,152 120,199 70,199 55,152" fill="${light}" stroke="${dark}" stroke-width="3"/>
      <polygon points="180,105 230,105 245,152 230,199 180,199 165,152" fill="${light}" stroke="${dark}" stroke-width="3"/>
      <rect x="125" y="118" width="50" height="68" fill="${light}" stroke="${dark}" stroke-width="3"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#f4f5f7"/>${body}</svg>`;
}

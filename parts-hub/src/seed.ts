// Sample parts for mock mode, so the hub and panel have something to show.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { addHistory, createPart, listParts, type Part } from './db.ts';
import { mockThumbnailSvg } from './onshape/mock.ts';

type Sample = Partial<Part> & { name: string };

const SAMPLES: Sample[] = [
  {
    name: '1/4 Tube Union SS', partNumber: 'SS-400-6', vendor: 'Swagelok', category: 'Fittings', tags: ['1/4', 'union', 'tube'],
    unitCost: 21.4, costNote: 'qty 10 price, quoted 2026-08', description: 'Straight union, 1/4 in. tube OD both ends.',
    links: [{ label: 'Vendor page', url: 'https://www.swagelok.com/' }],
    customFields: [{ key: 'Material', value: '316 SS' }, { key: 'Max pressure', value: '5100 psi' }],
  },
  {
    name: '1/4 Tube Elbow SS', partNumber: 'SS-400-9', vendor: 'Swagelok', category: 'Fittings', tags: ['1/4', 'elbow', '90'],
    unitCost: 38.9, customFields: [{ key: 'Material', value: '316 SS' }],
  },
  {
    name: '1/2 Tube Union SS', partNumber: 'SS-810-6', vendor: 'Swagelok', category: 'Fittings', tags: ['1/2', 'union'],
    unitCost: 44.1, customFields: [{ key: 'Material', value: '316 SS' }],
  },
  {
    name: '1/4 Ball Valve 2-Way', partNumber: 'SS-43GS4', vendor: 'Swagelok', category: 'Valves', tags: ['ball valve', '1/4'],
    unitCost: 212, costNote: 'list price', notes: 'Use the -SC11 variant for oxidizer lines.',
    customFields: [{ key: 'Max pressure', value: '3000 psi' }, { key: 'Seat', value: 'PTFE' }],
  },
  {
    name: '1/2 Solenoid Valve NC', partNumber: '8210G094', vendor: 'ASCO', category: 'Valves', tags: ['solenoid', 'normally closed'],
    unitCost: 289.5, links: [{ label: 'Datasheet', url: 'https://www.asco.com/' }],
    customFields: [{ key: 'Coil', value: '24 VDC' }],
  },
  {
    name: 'Relief Valve 1/4 NPT', partNumber: 'SS-RL3M4', vendor: 'Swagelok', category: 'Valves', tags: ['relief', 'npt'],
    unitCost: 156, customFields: [{ key: 'Set range', value: '750-1500 psi' }],
  },
  {
    name: 'Pressure Transducer 0-5000 psi', partNumber: 'PX309-5KGI', vendor: 'Omega', category: 'Sensors', tags: ['pressure', 'transducer'],
    unitCost: 265, costNote: 'edu discount', customFields: [{ key: 'Output', value: '4-20 mA' }, { key: 'Port', value: '1/4 NPT male' }],
  },
  {
    name: 'Type K Thermocouple Probe', partNumber: 'KQXL-18G-12', vendor: 'Omega', category: 'Sensors', tags: ['thermocouple', 'temperature'],
    unitCost: 32.75,
  },
  {
    name: '1/4-20 x 3/4 SHCS', partNumber: '91251A540', vendor: 'McMaster-Carr', category: 'Fasteners', tags: ['socket head', 'bolt', '1/4-20'],
    unitCost: 0.34, costNote: 'pack of 100 = $33.87', customFields: [{ key: 'Material', value: 'Alloy steel, black oxide' }],
  },
  {
    name: '1/4-20 Hex Nut', partNumber: '95462A029', vendor: 'McMaster-Carr', category: 'Fasteners', tags: ['nut', '1/4-20'],
    unitCost: 0.07,
  },
  {
    name: '#10-32 x 1/2 SHCS SS', partNumber: '92185A944', vendor: 'McMaster-Carr', category: 'Fasteners', tags: ['socket head', 'screw'],
    unitCost: 0.21,
  },
  {
    name: '1/4 Tube x 3/8 NPT Male Connector', partNumber: 'SS-400-1-6', vendor: 'Swagelok', category: 'Fittings',
    tags: ['adapter', 'npt'], unitCost: 18.6, customFields: [{ key: 'Material', value: '316 SS' }],
  },
  {
    name: '1/4 Tube x 1/4 NPT Male Connector', partNumber: 'SS-400-1-4', vendor: 'Swagelok', category: 'Fittings',
    tags: ['adapter', 'npt'], unitCost: 16.9, customFields: [{ key: 'Material', value: '316 SS' }],
  },
  {
    name: '3/8 Tube Tee SS', partNumber: 'SS-600-3', vendor: 'Swagelok', category: 'Fittings', tags: ['tee', '3/8'],
    unitCost: 61.2,
  },
];

export function seedMockParts(): void {
  if (listParts({ includeArchived: true }).length) return;
  const thumbs = path.join(config.dataDir, 'thumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  for (const [i, sample] of SAMPLES.entries()) {
    const fakeId = (s: string) => crypto.createHash('sha1').update(s + i).digest('hex').slice(0, 24);
    const file = `seed-${i}-${crypto.randomBytes(6).toString('hex')}.svg`;
    fs.writeFileSync(path.join(thumbs, file), mockThumbnailSvg(sample.name));
    const part = createPart(
      {
        ...sample,
        documentId: config.onshape.libraryDocumentId,
        elementId: fakeId('element'),
        versionId: fakeId('version'),
        thumbnailFile: file,
        status: 'ready',
      },
      'seed@berkeley.edu',
    );
    addHistory(part.id, 'seed@berkeley.edu', 'Created (sample data)');
  }
  console.log(`[mock] seeded ${SAMPLES.length} sample parts`);
}

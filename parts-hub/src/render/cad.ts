// Read a CAD file into triangle meshes for the thumbnail renderer.
// STEP/IGES/BREP go through OpenCascade (occt-import-js, WebAssembly); STL is parsed here.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Mesh } from './raster.ts';

type Rgb = [number, number, number];
type OcctMesh = {
  color?: number[];
  brep_faces?: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
};
type Occt = Record<'ReadStepFile' | 'ReadIgesFile' | 'ReadBrepFile', (data: Uint8Array, params: object | null) => { success: boolean; meshes: OcctMesh[] }>;

/** File extensions we can draw ourselves. Anything else gets its picture from Onshape. */
export const RENDERABLE = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl']);

const rgb = (c: number[] | null | undefined): Rgb | undefined =>
  c && c.length >= 3 ? ((c.some((x) => x > 1) ? c.slice(0, 3).map((x) => x / 255) : c.slice(0, 3)) as Rgb) : undefined;

export async function readMeshes(filePath: string, ext: string): Promise<Mesh[]> {
  const data = fs.readFileSync(filePath);
  if (ext === 'stl') return [readStl(data)];

  const occt: Occt = await createRequire(import.meta.url)('occt-import-js')();
  const read = ext === 'iges' || ext === 'igs' ? occt.ReadIgesFile : ext === 'brep' || ext === 'brp' ? occt.ReadBrepFile : occt.ReadStepFile;
  // A coarse tessellation is plenty for a 300 px picture and keeps big assemblies fast.
  const result = read(new Uint8Array(data), { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.35 });
  if (!result.success || !result.meshes.length) throw new Error('Could not read the CAD file');
  return result.meshes.map((m) => ({
    positions: m.attributes.position.array,
    normals: m.attributes.normal?.array,
    indices: m.index.array,
    color: rgb(m.color),
    faceColors: (m.brep_faces ?? []).flatMap((f) => (rgb(f.color) ? [{ first: f.first, last: f.last, color: rgb(f.color)! }] : [])),
  }));
}

function readStl(data: Buffer): Mesh {
  const positions: number[] = [];
  const count = data.length >= 84 ? data.readUInt32LE(80) : 0;
  if (count && data.length === 84 + count * 50) {
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12; // skip the facet normal
      for (let k = 0; k < 9; k++) positions.push(data.readFloatLE(o + k * 4));
    }
  } else {
    for (const m of data.toString('latin1').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) positions.push(+m[1], +m[2], +m[3]);
  }
  if (!positions.length) throw new Error('Empty STL');
  return { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}

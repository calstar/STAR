// A small software renderer for part thumbnails: isometric view, z-buffer,
// smooth shading and CAD-style edge lines, written out as PNG. No GPU needed.
import zlib from 'node:zlib';

export type Mesh = {
  positions: ArrayLike<number>; // xyz triplets
  normals?: ArrayLike<number>; // per-vertex, optional
  indices: ArrayLike<number>; // triangle vertex indices
  color?: [number, number, number]; // 0..1, whole mesh
  faceColors?: { first: number; last: number; color: [number, number, number] }[]; // triangle ranges
};

const STEEL: [number, number, number] = [0.74, 0.76, 0.79];
const BACKGROUND = [0xf4, 0xf5, 0xf7];
const LINE = [0.22, 0.25, 0.29];
// Same isometric view Onshape uses (Z up): rows map model x/y/z to view x (right), y (up), z (towards viewer).
const VIEW = [
  [0.7071, 0.7071, 0],
  [-0.4082, 0.4082, 0.8165],
  [0.5774, -0.5774, 0.5774],
];
const KEY = normalize([-0.45, 0.55, 0.7]);
const FILL = normalize([0.6, -0.25, 0.45]);
const HALF = normalize([KEY[0], KEY[1], KEY[2] + 1]);

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function renderPng(meshes: Mesh[], size = 300, supersample = 3): Buffer {
  const W = size * supersample;
  const N = W * W;

  // View-space vertices, and the fit-to-frame transform.
  const views = meshes.map((m) => {
    const n = m.positions.length / 3;
    const v = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
      for (let r = 0; r < 3; r++) v[i * 3 + r] = VIEW[r][0] * x + VIEW[r][1] * y + VIEW[r][2] * z;
    }
    return v;
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of views) {
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
      minZ = Math.min(minZ, v[i + 2]); maxZ = Math.max(maxZ, v[i + 2]);
    }
  }
  if (!Number.isFinite(minX)) throw new Error('Model has no geometry');
  const scale = (W * 0.86) / Math.max(maxX - minX, maxY - minY, 1e-9);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  const depth = new Float32Array(N).fill(-Infinity);
  const nrm = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);

  meshes.forEach((m, mi) => {
    const v = views[mi];
    const sx = new Float32Array(v.length / 3), sy = new Float32Array(v.length / 3);
    for (let i = 0; i < sx.length; i++) {
      sx[i] = (v[i * 3] - cx) * scale + W / 2;
      sy[i] = W / 2 - (v[i * 3 + 1] - cy) * scale;
    }
    const vn = m.normals && m.normals.length === m.positions.length ? m.normals : null;
    const colorOf = faceColorLookup(m);

    for (let t = 0; t < m.indices.length / 3; t++) {
      const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2];
      const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
      if (Math.abs(area) < 1e-9) continue;
      // Flat normal (view space) for meshes without normals.
      let fn: number[] | null = null;
      if (!vn) {
        const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
        const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
        fn = normalize([uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]);
      }
      const color = colorOf(t);
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c])));
      const y1 = Math.min(W - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const w0 = ((sx[c] - sx[b]) * (py - sy[b]) - (sy[c] - sy[b]) * (px - sx[b])) / area;
          const w1 = ((sx[a] - sx[c]) * (py - sy[c]) - (sy[a] - sy[c]) * (px - sx[c])) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * v[a * 3 + 2] + w1 * v[b * 3 + 2] + w2 * v[c * 3 + 2];
          const i = y * W + x;
          if (z <= depth[i]) continue;
          depth[i] = z;
          let nx: number, ny: number, nz: number;
          if (vn) {
            // Rotate the interpolated model-space normal into view space.
            const mx = w0 * vn[a * 3] + w1 * vn[b * 3] + w2 * vn[c * 3];
            const my = w0 * vn[a * 3 + 1] + w1 * vn[b * 3 + 1] + w2 * vn[c * 3 + 1];
            const mz = w0 * vn[a * 3 + 2] + w1 * vn[b * 3 + 2] + w2 * vn[c * 3 + 2];
            nx = VIEW[0][0] * mx + VIEW[0][1] * my + VIEW[0][2] * mz;
            ny = VIEW[1][0] * mx + VIEW[1][1] * my + VIEW[1][2] * mz;
            nz = VIEW[2][0] * mx + VIEW[2][1] * my + VIEW[2][2] * mz;
          } else {
            [nx, ny, nz] = fn!;
          }
          const l = Math.hypot(nx, ny, nz) || 1;
          const flip = nz < 0 ? -1 : 1; // light both sides: STEP face orientation isn't reliable
          nrm[i * 3] = (flip * nx) / l;
          nrm[i * 3 + 1] = (flip * ny) / l;
          nrm[i * 3 + 2] = (flip * nz) / l;
          col[i * 3] = color[0];
          col[i * 3 + 1] = color[1];
          col[i * 3 + 2] = color[2];
        }
      }
    }
  });

  // Shade, then darken pixels on silhouettes, depth steps and sharp creases.
  const rgb = new Float32Array(N * 3);
  const depthStep = (maxZ - minZ) * 0.04;
  const line = Math.max(1, Math.round(supersample * 0.6));
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (depth[i] === -Infinity) {
        rgb[i * 3] = BACKGROUND[0] / 255;
        rgb[i * 3 + 1] = BACKGROUND[1] / 255;
        rgb[i * 3 + 2] = BACKGROUND[2] / 255;
        continue;
      }
      const n = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
      const diffuse = 0.62 * Math.max(0, dot(n, KEY)) + 0.22 * Math.max(0, dot(n, FILL));
      const spec = 0.28 * Math.pow(Math.max(0, dot(n, HALF)), 48);
      const light = 0.42 + diffuse;
      let edge = false;
      for (let dy = -line; dy <= line && !edge; dy++) {
        for (let dx = -line; dx <= line && !edge; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= W) continue;
          const j = yy * W + xx;
          if (depth[j] === -Infinity) edge = true;
          else if (depth[i] - depth[j] > depthStep) edge = true;
          else if (n[0] * nrm[j * 3] + n[1] * nrm[j * 3 + 1] + n[2] * nrm[j * 3 + 2] < 0.8) edge = true;
        }
      }
      for (let k = 0; k < 3; k++) {
        // Lift very dark file colours a little so the shape still reads.
        const base = 0.12 + 0.88 * col[i * 3 + k];
        const shaded = Math.min(1, base * light + spec);
        rgb[i * 3 + k] = edge ? shaded * 0.25 + LINE[k] * 0.75 : shaded;
      }
    }
  }

  // Downsample (anti-aliasing) and encode.
  const out = Buffer.alloc(size * size * 3);
  const s2 = supersample * supersample;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < supersample; dy++) {
        for (let dx = 0; dx < supersample; dx++) {
          const i = (y * supersample + dy) * W + x * supersample + dx;
          r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2];
        }
      }
      const o = (y * size + x) * 3;
      out[o] = Math.round((r / s2) * 255);
      out[o + 1] = Math.round((g / s2) * 255);
      out[o + 2] = Math.round((b / s2) * 255);
    }
  }
  return encodePng(size, size, out);
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function faceColorLookup(m: Mesh): (triangle: number) => [number, number, number] {
  const base = m.color ?? STEEL;
  const ranges = m.faceColors ?? [];
  if (!ranges.length) return () => base;
  return (t) => {
    for (const r of ranges) if (t >= r.first && t <= r.last) return r.color;
    return base;
  };
}

/** Minimal PNG writer: 8-bit RGB, no interlace. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

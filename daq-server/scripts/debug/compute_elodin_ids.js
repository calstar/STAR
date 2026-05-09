// Diagnostic script to verify FNV-1a hash calculations for Elodin VTable names.
// Usage: node scripts/debug/compute_elodin_ids.js "VTableStream"

const name = process.argv[2] || "VTableStream";

function computeMsgId(name) {
  let id = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < name.length; i++) {
    id ^= name.charCodeAt(i);
    id = Math.imul(id, 0x01000193); // FNV prime
  }
  id = (id >>> 0) & 0xFFFF; // 16-bit fold
  return [(id >> 8) & 0xFF, id & 0xFF];
}

const res = computeMsgId(name);
console.log(`Name: "${name}"`);
console.log(`ID (hex): [0x${res[0].toString(16).padStart(2, '0')}, 0x${res[1].toString(16).padStart(2, '0')}]`);
console.log(`ID (dec): [${res[0]}, ${res[1]}]`);

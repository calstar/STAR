// The details a manufacturing task carries (TaskManufacturing). Prisma-free so
// the client form and the server action share one set of rules.

export const MANUFACTURING_FIELDS = [
  "partName",
  "onshapeUrl",
  "drawingUrl",
  "quantity",
  "material",
  "designReId",
  "mfgReId",
] as const;

export type ManufacturingField = (typeof MANUFACTURING_FIELDS)[number];

/** Field → its label on the task card. (History uses FIELD_LABEL.) */
export const MANUFACTURING_LABEL: Record<ManufacturingField, string> = {
  partName: "Part name",
  onshapeUrl: "Onshape",
  drawingUrl: "Drawing",
  quantity: "Quantity",
  material: "Material",
  designReId: "Design RE",
  mfgReId: "Manufacturing RE",
};

export function isManufacturingField(f: string): f is ManufacturingField {
  return (MANUFACTURING_FIELDS as readonly string[]).includes(f);
}

const MAX_TEXT = 200;
const MAX_URL = 2000;
const MAX_QUANTITY = 100_000;

/**
 * Parse a submitted value for one field. Blank clears it (null). Throws with a
 * message fit to show the user when the value is not acceptable.
 */
export function parseManufacturingValue(
  field: ManufacturingField,
  raw: string,
): string | number | null {
  const v = raw.trim();
  if (v === "") return null;
  switch (field) {
    case "partName":
    case "material":
      if (v.length > MAX_TEXT) throw new Error(`Keep it under ${MAX_TEXT} characters.`);
      return v;
    case "onshapeUrl":
    case "drawingUrl": {
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        throw new Error("Paste a full link, starting with https://");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("Paste a full link, starting with https://");
      if (v.length > MAX_URL) throw new Error("That link is too long.");
      return v;
    }
    case "quantity": {
      if (!/^\d+$/.test(v)) throw new Error("Quantity is a whole number.");
      const n = Number(v);
      if (n < 1 || n > MAX_QUANTITY)
        throw new Error(`Quantity is between 1 and ${MAX_QUANTITY.toLocaleString()}.`);
      return n;
    }
    case "designReId":
    case "mfgReId":
      return v;
  }
}

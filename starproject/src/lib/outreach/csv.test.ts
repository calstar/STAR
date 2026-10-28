import { describe, expect, it } from "vitest";

import { detectDelimiter, parseDelimited, toCsvLine } from "./csv";

describe("parseDelimited", () => {
  it("reads a pasted sheet range as tab-separated", () => {
    expect(detectDelimiter("NAME\tEMAILS\nAda\ta@b.com")).toBe("\t");
    expect(parseDelimited("NAME\tEMAILS\nAda\ta@b.com\n")).toEqual([
      ["NAME", "EMAILS"],
      ["Ada", "a@b.com"],
    ]);
  });
  it("handles quotes, embedded commas, newlines and doubled quotes", () => {
    const text = 'a,b,c\r\n"x, y","line1\nline2","say ""hi"""\n';
    expect(parseDelimited(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", "line1\nline2", 'say "hi"'],
    ]);
  });
  it("drops blank rows and a BOM", () => {
    expect(parseDelimited("﻿a,b\n,\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("toCsvLine", () => {
  it("round-trips through the parser", () => {
    const line = toCsvLine(["plain", "has, comma", 'has "quote"', null, 5]);
    expect(parseDelimited(line, ",")).toEqual([["plain", "has, comma", 'has "quote"', "", "5"]]);
  });
});

import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "../../src/commands/output.js";

describe("csvEscape", () => {
  it("leaves a plain value untouched", () => {
    expect(csvEscape("KL1023")).toBe("KL1023");
  });

  it("quotes a value containing a comma", () => {
    expect(csvEscape("Amsterdam, Schiphol")).toBe('"Amsterdam, Schiphol"');
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("produces a header row plus one row per entry, CRLF-terminated", () => {
    const csv = toCsv([{ a: "1", b: "x,y" }], ["a", "b"]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

import { describe, expect, it, vi } from "vitest";
import { csvEscape, printRows, sanitizeForTerminal, toCsv, toTable, withPresentColumns } from "../../src/commands/output.js";

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

describe("toCsv with sanitize", () => {
  it("strips escape sequences and bidirectional characters from string values", () => {
    const rows = [{ file_name: "a\u001b[2Jb\u202e.pdf", n: 3 }];
    expect(toCsv(rows, ["file_name", "n"], true)).toBe("file_name,n\r\na[2Jb.pdf,3\r\n");
  });

  it("keeps the data as it is without sanitize (file exports)", () => {
    expect(toCsv([{ v: "a\u001bb" }], ["v"])).toBe("v\r\na\u001bb\r\n");
  });

  it("printRows --csv goes through the sanitiser", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (writes.push(String(chunk)), true));
    try {
      printRows([{ file_name: "x\u001b[2Jy.pdf" }], ["file_name"], "csv");
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toBe("file_name\r\nx[2Jy.pdf\r\n");
  });
});

describe("sanitizeForTerminal", () => {
  it("drops escape sequences, control and bidirectional characters", () => {
    expect(sanitizeForTerminal("a\u001b[31mred\u0007\u202etxt.exe\u2066")).toBe("a[31mredtxt.exe");
  });

  it("turns tabs and line breaks into one space", () => {
    expect(sanitizeForTerminal("one\r\ntwo\tthree")).toBe("one two three");
  });

  it("is applied to table cells", () => {
    const table = toTable([{ name: "x\u001b[2Jy" }], ["name"]);
    expect(table).not.toContain("\u001b");
  });
});

describe("withPresentColumns", () => {
  it("adds an optional column only when some row carries it", () => {
    expect(withPresentColumns([{ id: 1 }], ["id"], ["photo"])).toEqual(["id"]);
    expect(withPresentColumns([{ id: 1 }, { id: 2, photo: "set" }], ["id"], ["photo"])).toEqual(["id", "photo"]);
  });
});

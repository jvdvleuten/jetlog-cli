import { describe, expect, it } from "vitest";
import {
  MESSAGE_HIDDEN,
  MESSAGE_NUL,
  MESSAGE_UTF8,
  assertName,
  nameProblem,
  prepareWriteRows,
  proposalOperationProblems,
  stripHiddenCharacters,
  textProblem
} from "../src/text-rules.js";

describe("textProblem", () => {
  it("refuses NUL and a lone surrogate with the server's words", () => {
    expect(textProblem("a\u0000b")).toBe(MESSAGE_NUL);
    expect(textProblem("a\uD800b")).toBe(MESSAGE_UTF8);
    expect(textProblem("a\uDC00")).toBe(MESSAGE_UTF8);
  });

  it("accepts ordinary text, emoji pairs, tabs and newlines", () => {
    expect(textProblem("Zürich \u{1F6EB}\tline\nbreak")).toBeUndefined();
  });
});

describe("stripHiddenCharacters", () => {
  it("removes control, bidi and zero-width characters", () => {
    expect(stripHiddenCharacters("\uFEFFKL\u200B1001\u202E\u0007")).toBe("KL1001");
  });
});

describe("proposalOperationProblems", () => {
  it("flags hidden characters in code fields only", () => {
    const problems = proposalOperationProblems({
      op: "update",
      resource: "entry",
      id: "e1",
      data: { registration: "PH\u200BEZA", remarks: "a\u200Bb" }
    });
    expect(problems).toEqual([{ field: "registration", message: MESSAGE_HIDDEN }]);
  });

  it("checks the own id of an aircraft create", () => {
    expect(proposalOperationProblems({ op: "create", resource: "aircraft", id: "B7\uFEFF38", data: {} })).toEqual([
      { field: "id", message: MESSAGE_HIDDEN }
    ]);
  });

  it("refuses NUL anywhere, naming the top-level field", () => {
    const problems = proposalOperationProblems({ op: "create", resource: "entry", data: { people: [{ role: "PIC\u0000" }] } });
    expect(problems).toEqual([{ field: "people", message: MESSAGE_NUL }]);
  });

  it("limits strings to 2000 characters, person notes to 10000, and crew to 20", () => {
    expect(proposalOperationProblems({ op: "update", resource: "entry", id: "e", data: { remarks: "x".repeat(2001) } })).toEqual([
      { field: "remarks", message: "must be at most 2000 characters" }
    ]);
    expect(proposalOperationProblems({ op: "update", resource: "person", id: "p", data: { notes: "x".repeat(10000) } })).toEqual([]);
    expect(proposalOperationProblems({ op: "update", resource: "person", id: "p", data: { notes: "x".repeat(10001) } })).toEqual([
      { field: "notes", message: "must be at most 10000 characters" }
    ]);
    const crew = Array.from({ length: 21 }, (_, i) => ({ person_id: `p${i}`, role: "FO" }));
    expect(proposalOperationProblems({ op: "create", resource: "entry", data: { people: crew } })).toEqual([
      { field: "people", message: "must have at most 20 crew members" }
    ]);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(proposalOperationProblems({ op: "update", resource: "entry", id: "e", data: { remarks: "\u{1F6EB}".repeat(1500) } })).toEqual([]);
  });
});

describe("prepareWriteRows", () => {
  it("strips hidden characters from code fields and leaves free text alone", () => {
    const { rows, problems } = prepareWriteRows("entries", [{ id: "e1", flight_number: "\uFEFFKL1001", remarks: "a\u200Bb" }]);
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ id: "e1", flight_number: "KL1001", remarks: "a\u200Bb" }]);
  });

  it("names the row and field of a NUL or an over-long value", () => {
    const { problems } = prepareWriteRows(
      "entries",
      [{ id: "e1", remarks: "ok" }, { id: "e2", remarks: "bad\u0000" }, { id: "e3", session_type: "x".repeat(101), aircraft_icao_code: "B738B738B73" }],
      (i) => `file row ${i + 2}`
    );
    expect(problems).toEqual([
      `file row 3, remarks: ${MESSAGE_NUL}`,
      "file row 4, session_type: must be at most 100 characters",
      "file row 4, aircraft_icao_code: must be at most 10 characters"
    ]);
  });

  it("does not refuse a remark the server cuts to 1000 itself, but limits notes to 10000", () => {
    expect(prepareWriteRows("entries", [{ id: "e", remarks: "x".repeat(1500) }]).problems).toEqual([]);
    expect(prepareWriteRows("people", [{ id: "p", notes: "x".repeat(10001) }]).problems).toEqual(["people row 1, notes: must be at most 10000 characters"]);
  });
});

describe("names", () => {
  it("refuses NUL and more than 255 characters", () => {
    expect(nameProblem("ok")).toBeUndefined();
    expect(nameProblem("a\u0000")).toBe(MESSAGE_NUL);
    expect(nameProblem("x".repeat(256))).toBe("must be at most 255 characters");
    expect(() => assertName("x".repeat(256), "--name")).toThrow("--name must be at most 255 characters.");
  });
});

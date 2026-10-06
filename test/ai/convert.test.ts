import { describe, expect, it } from "vitest";
import { aiConvert } from "../../src/ai/convert.js";
import { getJsonSchema } from "../../src/json-schema.js";
import type { AiProvider, StructuredRequest, StructuredResponse } from "../../src/ai/provider.js";

class FakeProvider implements AiProvider {
  name = "fake";
  defaultModel = "fake-model";
  calls: StructuredRequest[] = [];
  private responses: StructuredResponse[];

  constructor(responses: StructuredResponse[]) {
    this.responses = responses;
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error("FakeProvider ran out of canned responses");
    return next;
  }
}

describe("aiConvert", () => {
  it("returns a valid payload from a provider on the first try", async () => {
    const provider = new FakeProvider([
      {
        data: {
          entries: [{ date: "2026-01-05", flight_number: "KL1023", from: "EHAM", to: "EGLL" }],
          people: []
        }
      }
    ]);

    const { payload, warnings } = await aiConvert("date,flight\n2026-01-05,KL1023\n", {
      provider,
      jsonSchema: getJsonSchema()
    });

    expect(warnings).toHaveLength(0);
    expect(payload.entries).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("does one repair round-trip when the first response is invalid", async () => {
    const provider = new FakeProvider([
      { data: { entries: [{ flight_number: "KL1023" }], people: [] } }, // missing required date
      {
        data: {
          entries: [{ date: "2026-01-05", flight_number: "KL1023" }],
          people: []
        }
      }
    ]);

    const { payload, warnings } = await aiConvert("garbled input", {
      provider,
      jsonSchema: getJsonSchema()
    });

    expect(provider.calls).toHaveLength(2);
    expect(warnings).toHaveLength(0);
    expect(payload.entries).toHaveLength(1);
    // second call should include the repair instructions
    expect(provider.calls[1]!.instructions).toMatch(/failed validation/);
  });

  it("warns and drops a chunk that is still invalid after the repair attempt", async () => {
    const provider = new FakeProvider([
      { data: { entries: [{ flight_number: "KL1023" }], people: [] } },
      { data: { entries: [{ flight_number: "still no date" }], people: [] } }
    ]);

    const { payload, warnings } = await aiConvert("garbled input", {
      provider,
      jsonSchema: getJsonSchema()
    });

    expect(provider.calls).toHaveLength(2);
    expect(warnings.length).toBeGreaterThan(0);
    expect(payload.entries).toHaveLength(0);
  });

  it("chunks large inputs by row count and merges results", async () => {
    const provider = new FakeProvider([
      { data: { entries: [{ date: "2026-01-01", flight_number: "A1" }], people: [] } },
      { data: { entries: [{ date: "2026-01-02", flight_number: "A2" }], people: [] } }
    ]);

    const header = "date,flight";
    const rows = ["2026-01-01,A1", "2026-01-02,A2"];
    const input = [header, ...rows].join("\n");

    const { payload } = await aiConvert(input, {
      provider,
      jsonSchema: getJsonSchema(),
      chunkSize: 1
    });

    expect(provider.calls).toHaveLength(2);
    expect(payload.entries).toHaveLength(2);
  });
});

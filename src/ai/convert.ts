import { payloadSchema, validatePayload, type ImportMode, type Payload, type Person } from "../schema.js";
import { buildRepairPrompt } from "./prompt.js";
import type { AiProvider } from "./provider.js";

export interface AiConvertOptions {
  provider: AiProvider;
  jsonSchema: unknown;
  instructions?: string;
  model?: string;
  mode?: ImportMode;
  /** Max rows per chunk before the input is split into multiple requests. */
  chunkSize?: number;
}

export interface AiConvertResult {
  payload: Payload;
  warnings: string[];
}

function splitRows(input: string, chunkSize: number): string[] {
  const lines = input.split(/\r?\n/);
  if (lines.length <= chunkSize) return [input];

  // Keep a header line (if any) attached to every chunk for row-oriented
  // formats (csv/tsv); for everything else this just splits by line count.
  const header = lines[0] ?? "";
  const rest = lines.slice(1);
  const chunks: string[] = [];
  for (let i = 0; i < rest.length; i += chunkSize) {
    const slice = rest.slice(i, i + chunkSize);
    chunks.push([header, ...slice].join("\n"));
  }
  return chunks.length > 0 ? chunks : [input];
}

function mergePayloads(payloads: Payload[]): Payload {
  const entries = payloads.flatMap((p) => p.entries ?? []);
  const peopleByRefId = new Map<string, Person>();
  for (const payload of payloads) {
    for (const person of payload.people ?? []) {
      peopleByRefId.set(person.ref_id, person);
    }
  }
  return { entries, people: [...peopleByRefId.values()] };
}

async function convertChunk(input: string, options: AiConvertOptions, warnings: string[]): Promise<Payload> {
  const model = options.model;
  const first = await options.provider.generateStructured({
    input,
    jsonSchema: options.jsonSchema,
    instructions: options.instructions,
    model
  });

  let result = validatePayload(first.data, options.mode);
  if (result.valid && result.payload) {
    return result.payload;
  }

  const errors = [
    ...result.structuralErrors.map((e) => `${e.path || "(root)"}: ${e.message}`),
    ...result.modeErrors.map((e) => `entries[${e.index}]: ${e.message}`)
  ];

  // One repair round-trip, as specified: hand the model its own errors.
  const repaired = await options.provider.generateStructured({
    input,
    jsonSchema: options.jsonSchema,
    instructions: [options.instructions, buildRepairPrompt(errors)].filter(Boolean).join("\n\n"),
    model
  });

  result = validatePayload(repaired.data, options.mode);
  if (result.valid && result.payload) {
    return result.payload;
  }

  const stillBroken = [
    ...result.structuralErrors.map((e) => `${e.path || "(root)"}: ${e.message}`),
    ...result.modeErrors.map((e) => `entries[${e.index}]: ${e.message}`)
  ];
  warnings.push(
    `chunk failed validation after one repair attempt, dropping its entries: ${stillBroken.join("; ")}`
  );
  // Fall back to whatever structurally-valid partial we can salvage.
  const lenient = payloadSchema.safeParse(repaired.data);
  if (lenient.success) return lenient.data;
  return { entries: [], people: [] };
}

export async function aiConvert(input: string, options: AiConvertOptions): Promise<AiConvertResult> {
  const chunkSize = options.chunkSize ?? 200;
  const chunks = splitRows(input, chunkSize);
  const warnings: string[] = [];
  const payloads: Payload[] = [];
  for (const chunk of chunks) {
    payloads.push(await convertChunk(chunk, options, warnings));
  }
  return { payload: mergePayloads(payloads), warnings };
}

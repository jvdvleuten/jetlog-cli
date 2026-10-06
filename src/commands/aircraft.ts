import type { AircraftResponse } from "../api/client.js";
import { requireClient } from "./entries.js";
import { printRows, type OutputFormat } from "./output.js";

const COLUMNS = ["id", "aircraft_icao_code", "aircraft_iata_code", "use_system"];

export async function aircraftList(opts: { profile: string; baseUrl?: string; format: OutputFormat }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const page = await client.get<AircraftResponse>("/api/cli/v1/aircraft");
  printRows(page.aircraft, COLUMNS, opts.format);
}

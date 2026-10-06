import type { PeopleResponse } from "../api/client.js";
import { requireClient } from "./entries.js";
import { printRows, type OutputFormat } from "./output.js";

const COLUMNS = ["id", "first_name", "last_name", "default_role", "employee_number"];

export async function peopleList(opts: { profile: string; baseUrl?: string; format: OutputFormat }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const page = await client.get<PeopleResponse>("/api/cli/v1/people");
  printRows(page.people, COLUMNS, opts.format);
}

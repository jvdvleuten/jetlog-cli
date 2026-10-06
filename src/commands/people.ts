import type { PeopleResponse } from "../api/client.js";
import { requireClient } from "./entries.js";
import { printRows, withPresentColumns, type OutputFormat } from "./output.js";

const COLUMNS = ["id", "first_name", "last_name", "default_role", "employee_number"];

export async function peopleList(opts: { profile: string; baseUrl?: string; format: OutputFormat }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const page = await client.get<PeopleResponse>("/api/cli/v1/people");
  if (opts.format === "json") {
    printRows(page.people, COLUMNS, opts.format);
    return;
  }
  const shaped = withPhotoColumn(page.people);
  printRows(shaped.rows, shaped.columns, opts.format);
}

/** The facade sends `has_photo` (and `photo_attachment_id` with the files scope); the `photo` column is `yes` or `no`. */
export function withPhotoColumn(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; columns: string[] } {
  const shaped = rows.map((r) => (r.has_photo !== undefined ? { ...r, photo: r.has_photo === true ? "yes" : "no" } : r));
  return { rows: shaped, columns: withPresentColumns(shaped, COLUMNS, ["photo"]) };
}

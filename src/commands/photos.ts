/**
 * `jetlog photos set|get`: a person's photo.
 *
 * `set` uploads the image, then writes `photo_attachment_id` on the person through `PUT /api/people`
 * (the server fills in the checksum). `get` downloads the current photo through the same URL minting as
 * `attachments get`. Status and prompts go to stderr, data to stdout.
 */
import {
  createImportBatch,
  FILES_SCOPE_MESSAGE,
  putResourceChunked,
  type PeopleResponse
} from "../api/client.js";
import { fetchAttachment, saveAttachment } from "../attachments/download.js";
import { inspectFile, uploadInspected } from "../attachments/upload.js";
import { confirm } from "./confirm.js";
import { requireClient } from "./entries.js";
import { formatBytes } from "./format.js";
import { sanitizeForTerminal } from "./output.js";

interface Common {
  profile: string;
  baseUrl?: string;
}

async function findPerson(client: Awaited<ReturnType<typeof requireClient>>, id: string): Promise<Record<string, unknown>> {
  const { people } = await client.get<PeopleResponse>("/api/cli/v1/people");
  const person = people.find((p) => String(p.id) === id);
  if (!person) throw new Error(`person ${id} not found.`);
  // A token without the `files` scope gets `has_photo` but no `photo_attachment_id` key, which must not read as "no photo".
  if (!("photo_attachment_id" in person)) throw new Error(FILES_SCOPE_MESSAGE);
  return person;
}

function personName(person: Record<string, unknown>): string {
  return sanitizeForTerminal([person.first_name, person.last_name].filter((p) => typeof p === "string" && p !== "").join(" ")) || "(no name)";
}

export async function photosSet(opts: Common & { personId: string; image: string; yes?: boolean }): Promise<void> {
  const file = await inspectFile(opts.image, "person_photo");
  const client = await requireClient(opts.profile, opts.baseUrl);
  const person = await findPerson(client, opts.personId);
  const hasPhoto = typeof person.photo_attachment_id === "string" && person.photo_attachment_id !== "";

  console.error(`Person ${personName(person)}`);
  console.error(
    `Will set ${sanitizeForTerminal(file.fileName)} (${file.contentType}, ${formatBytes(file.byteSize)}) as the photo.` +
      (hasPhoto ? " It replaces the current photo." : "")
  );
  if (!opts.yes && !(await confirm("Set this photo?"))) {
    console.error("aborted: nothing was changed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `photos set ${opts.personId}` });
  const uploaded = await uploadInspected(client, "person_photo", file);
  await putResourceChunked(client, "people", [{ id: opts.personId, photo_attachment_id: uploaded.attachment_id }], batch.id);
  console.error("Photo set.");
}

export async function photosGet(opts: Common & { personId: string; output?: string; force?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const person = await findPerson(client, opts.personId);
  const attachmentId = person.photo_attachment_id;
  if (typeof attachmentId !== "string" || attachmentId === "") {
    throw new Error(`${personName(person)} has no photo.`);
  }

  const { meta, bytes } = await fetchAttachment(client, attachmentId);
  const stem = `photo-${String(person.first_name ?? "person")}-${String(person.last_name ?? "")}`.replace(/-$/, "");
  const path = await saveAttachment(
    { attachment_id: meta.id, content_type: meta.content_type, file_name: stem },
    bytes,
    opts.output ? { path: opts.output, force: opts.force } : { dir: process.cwd(), force: opts.force }
  );
  console.error(`Saved ${formatBytes(bytes.length)} (${meta.content_type}).`);
  console.log(path);
}

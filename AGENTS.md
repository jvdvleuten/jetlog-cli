# AGENTS.md

Guidance for contributors and for AI coding tools working in this repo.
(Looking for how an assistant uses the `jetlog` tool itself? That is
[docs/AI.md](docs/AI.md).)

## What this is

`jetlog-cli` (binary `jetlog`) converts pilot logbook data into Jetlog's
import format, imports it into a Jetlog account, reads logbook data back,
computes flight times locally, and runs an MCP server for AI tools.

## Commands

```sh
npm install
npm run build   # tsc to dist/
npm test        # vitest run
npm run lint    # tsc --noEmit
```

Run one test file: `npx vitest run test/schema.test.ts`.

Run from source without building: `npm run dev -- validate -`. Smoke test the
build: `node dist/cli.js schema`.

## Payload format

The payload schema in `src/schema.ts` mirrors the public
[JetlogAPI](https://github.com/jvdvleuten/JetlogAPI) README ("Payload schema"
and "Reference"). If the two disagree, JetlogAPI is right and this repo's
schema gets fixed, except where a code comment calls out a simplification on
purpose.

`test/examples.test.ts` validates every JSON example in JetlogAPI's
`EXAMPLES.md` against the schema. It looks for a JetlogAPI checkout next to
this repo (`../JetlogAPI`), or the file named by `JETLOG_API_EXAMPLES`, and is
skipped when there is neither.

## Structure

- `src/cli.ts`: commander wiring, one `.command()` per CLI command.
- `src/schema.ts`: the zod schema, `validatePayload()`, and the extra
  required-field checks for deeplink and API mode.
- `src/json-schema.ts`: JSON Schema derived from the zod schema with
  `z.toJSONSchema`. Keep the zod schema free of `.transform()` and
  `.default()`, which cannot be represented and make `z.toJSONSchema` throw.
  Normalisation happens in `validatePayload`.
- `src/convert/`: the generic CSV converter and the ForeFlight preset, plus
  the dispatch to the format importers.
- `src/import/`: the format importers (`importers/`), their shared model,
  and the matching and merging used by `jetlog import`. See
  `docs/IMPORTERS.md`.
- `src/times/`: the flight-times calculator. See `docs/TIMES.md`.
- `src/airports/`: the airport-code resolver and its sources. The index is
  empty unless logged in (account catalog and places).
- `src/deeplink.ts`: builds `jetlog.app/import` links and splits long
  payloads while keeping an entry and its crew together.
- `src/ai/`: LLM conversion behind a provider interface (`provider.ts`,
  `anthropic.ts`, `openai.ts`), with chunking, validation and one repair
  round in `convert.ts`.
- `src/mcp.ts`: the MCP server. The file tools (`upload_file`,
  `list_entry_attachments`, `download_attachment`, `create_upload_link`,
  `get_upload_link_status`) sit behind a gate that needs the `files` scope in
  the stored login. A `JETLOG_TOKEN` override has no stored scope, so a 403
  `insufficient_scope` from the server is mapped to the same "log in again"
  text. `download_attachment` writes only into `downloadRoot()`
  (`JETLOG_DOWNLOAD_DIR`, default `~/Downloads/jetlog`) with a generated name
  and flag `wx`, the model never supplies a path. A signature image
  downloads with the `signatures` scope; without it the server answers
  `forbidden` and the tool says so. Writes of signatures,
  photos, files and signing links go through `propose_changes` and
  `apply_changes`. The only direct writes are `upload_file` (bytes nobody
  references yet) and `create_upload_link`. `test/mcp.test.ts` pins the tool
  name list.
- `src/attachments/`: `upload.ts` (`inspectFile` and `uploadFile`: regular
  files only, a size cap and a pixel cap per kind, refuses the CLI config
  folder and `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, type sniffing from
  magic bytes, sha256, presigned PUT without the auth header, confirm) and
  `download.ts` (`safeFileName`, `saveAttachment`, `fetchAttachment` with
  checksum check, `saveInsideRoot` for the MCP tool).
- `src/api/client.ts`: typed fetch client with retries on 429 and 5xx. A
  `retry-after` above `MAX_RETRY_AFTER_SECONDS` (60) fails at once, and the
  codes in `NEVER_RETRIED_CODES` (quota, signature budget, too many open
  links) are never retried. `CODE_MESSAGES` gives error codes plain wording.
  Link-minting POSTs (`createSignatureRequest`, `createUploadLink`) are not
  retried on 5xx because the link may already exist.
- `src/auth/`: device-code login (RFC 8628) and local credential storage.
  `JETLOG_TOKEN` and `JETLOG_BASE_URL` win over the stored profile.
- `src/commands/`: one module per logged-in command. `output.ts` has the
  shared table, JSON and CSV printing, and `sanitizeForTerminal`, which every
  server-supplied string (file names above all) goes through before it is
  printed or returned to a model. `attachments.ts`, `photos.ts` and
  `signatures.ts` are the file, photo and signature commands (state check,
  preview and confirm first, one edit batch per run). `login.ts`
  `loginScopes` decides which scopes a login asks for.

## Conventions

- The package ships no airport or aircraft reference data. Airport and
  aircraft-type data come only from the logged-in account at runtime.
- Tests never call a real Anthropic or OpenAI API. Use the fake `AiProvider`
  pattern in `test/ai/convert.test.ts`.
- Tests never call a real Jetlog server. Use `test/helpers/test-server.ts`,
  which keeps the raw request body as a Buffer so upload tests can compare
  bytes. `test/mcp-files.test.ts` covers the local file tools.
- Fixtures under `test/fixtures/` are synthetic or anonymised. Do not add a
  real logbook export.
- A command that writes to an account previews first and asks for
  confirmation. Keep it that way for new write paths, in the CLI and in MCP
  tools.
- Text is plain: no em dashes in CLI output, help, MCP texts, comments or
  docs.
- `scripts/e2e-*.sh` are for maintainers. They need a local checkout of the
  Jetlog backend, which is not public, and are not part of `npm test`.

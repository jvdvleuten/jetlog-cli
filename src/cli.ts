#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { getJsonSchema, formatJsonSchemaAsMarkdown } from "./json-schema.js";
import { validatePayload, payloadSchema, type ImportMode, type Payload } from "./schema.js";
import { convertFile, convertFiles, type ConvertFormat, type DateFormat } from "./convert/index.js";
import { buildImportLinks, openLink, type DeeplinkScheme } from "./deeplink.js";
import { createProvider, aiConvert, ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from "./ai/index.js";
import { computeFileEntryTimes, computeFileTotals, computeProfileTotals } from "./times/fromFile.js";
import { useLoggedInAirportsIfAvailable } from "./airports/index.js";
import type { Period } from "./times/period.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import { entriesList, requireClient } from "./commands/entries.js";
import { peopleList } from "./commands/people.js";
import { aircraftList } from "./commands/aircraft.js";
import { runExport } from "./commands/export.js";
import { runImport } from "./commands/import.js";
import { batchesList, batchesRemove, batchesRemoveAllCli } from "./commands/batches.js";
import { changesShow, changesApply } from "./commands/changes.js";
import { attachmentsAdd, attachmentsGet, attachmentsList, attachmentsRemove } from "./commands/attachments.js";
import { photosGet, photosSet } from "./commands/photos.js";
import {
  signaturesAttach,
  signaturesGet,
  signaturesRemove,
  signaturesRequest,
  signaturesRevoke,
  signaturesShow,
  signaturesUnwaive,
  signaturesWaive
} from "./commands/signatures.js";
import { parseOutputFormat } from "./commands/output.js";
import { ApiError } from "./api/client.js";
import { formatEntryTimesTable, formatTotalsSummary } from "./commands/times-format.js";
import { terminalNoticeLines, type ImportNotice } from "./import/warnings.js";

const program = new Command();
program
  .name("jetlog")
  .description("Convert, import and read pilot logbook data for Jetlog (https://jetlog.app)")
  .version("0.1.0")
  .addHelpText(
    "after",
    "\nAI assistants: `jetlog mcp` runs an MCP server. docs/AI.md in this package explains the tools,\n" +
      "which commands write to the account, and the confirm-first rule for those."
  );

/** What to pass so `times`/`totals` can tell which listed person is the user, per source format. */
function selfHint(format: string): string {
  if (format === "logten") return 'Pass --self "<your name as it appears in the file>".';
  if (format === "csv" || format === "foreflight") return "Pass --self-role <role> (for example PIC) to credit yourself on every row.";
  if (format === "auto") return 'Pass --self "<your name>" (LogTen) or --self-role <role> (csv, foreflight).';
  return "This format has to mark you in the file itself (an owner or pilot column).";
}

/** Closing lines for a file-based `times`/`totals` run. Entries with no person marked as the user cannot be
 * computed; when that leaves nothing at all the run is a failure (exit code 1) with the reason as the last line,
 * since a silent all-zero result looks like a valid answer. A run that skipped only some entries still succeeds. */
function reportSelfOutcome(format: string, skipped: number, computed: number, verb: string): void {
  const plural = (n: number) => `${n} entr${n === 1 ? "y" : "ies"}`;
  if (skipped > 0 && computed > 0) {
    console.error(`${plural(skipped)} skipped: no person in them is marked as you, so no times can be computed for them. ${selfHint(format)}`);
  }
  if (computed === 0 && skipped > 0) {
    console.error(`error: nothing was computed, all ${plural(skipped)} were skipped. ${selfHint(format)}`);
    process.exitCode = 1;
    return;
  }
  console.error(`${verb} ${plural(computed)}`);
}

function printNotices(notices: ImportNotice[]): void {
  for (const line of terminalNoticeLines(notices)) console.error(line);
}

async function readInput(file: string): Promise<string> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  }
  return readFile(file, "utf-8");
}

function printValidationErrors(result: ReturnType<typeof validatePayload>): void {
  for (const e of result.structuralErrors) {
    console.error(`error: ${e.path || "(root)"}: ${e.message}`);
  }
  for (const e of result.modeErrors) {
    console.error(`error: entries[${e.index}]: ${e.message}`);
  }
}

program
  .command("schema")
  .description("Print the JSON Schema for the Jetlog import payload")
  .option("--format <format>", "json-schema or markdown", "json-schema")
  .action((opts: { format: string }) => {
    if (opts.format === "markdown") {
      console.log(formatJsonSchemaAsMarkdown());
    } else {
      console.log(JSON.stringify(getJsonSchema(), null, 2));
    }
  });

program
  .command("validate")
  .description("Validate a Jetlog import payload")
  .argument("<file>", "file to validate, or - for stdin")
  .option("--mode <mode>", "deeplink or api")
  .option("--json", "machine-readable output")
  .action(async (file: string, opts: { mode?: ImportMode; json?: boolean }) => {
    const content = await readInput(file);
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err) {
      console.error(`error: invalid JSON: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const result = validatePayload(data, opts.mode);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      const entries = result.payload?.entries?.length ?? 0;
      console.log(`valid: ${entries} entr${entries === 1 ? "y" : "ies"}`);
    } else {
      printValidationErrors(result);
    }
    if (!result.valid) process.exitCode = 1;
  });

program
  .command("convert")
  .description("Convert a logbook file to Jetlog JSON")
  .argument("<files...>", "file(s) to convert, pass several for a multi-file export (e.g. RB Logbook's flights/aircraft/people CSVs)")
  .requiredOption(
    "--from <format>",
    "csv | foreflight | logten | pilotlog | flylog | safelog | skylife | chrono | rblogbook | flightlogger | excel | monthly-overview | jetlog-csv | deeplink-json | jetlog | auto"
  )
  .option("-o, --output <file>", "output file (default: stdout)")
  .option("--self-role <role>", "assign ref_id SELF this role on every entry")
  .option("--self <name>", "which crew name in the file is you (LogTen); default: the name that appears most often")
  .option("--map <mappings>", "field=Header,field2=Header2 header overrides")
  .option("--date-format <format>", "YMD | DMY | MDY (for ambiguous slash dates)", "YMD")
  .option(
    "--include-future",
    "keep rows dated after today (by default, formats whose source can contain not-yet-flown rostered rows have them dropped, see docs/IMPORTERS.md)"
  )
  .option("--profile <name>", "credential profile whose airport catalog and places are used when logged in", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .option("--offline", "do not fetch the airport catalog: resolve no airports (night time and distance-based figures are then not computed)")
  .action(
    async (
      files: string[],
      opts: {
        from: ConvertFormat;
        output?: string;
        selfRole?: string;
        self?: string;
        map?: string;
        dateFormat: DateFormat;
        includeFuture?: boolean;
        profile: string;
        baseUrl?: string;
        offline?: boolean;
      }
    ) => {
      await useLoggedInAirportsIfAvailable({ profile: opts.profile, baseUrl: opts.baseUrl, offline: opts.offline });
      const map: Record<string, string> = {};
      if (opts.map) {
        for (const pair of opts.map.split(",")) {
          const [field, header] = pair.split("=");
          if (field && header) map[field.trim()] = header.trim();
        }
      }

      const loaded = await Promise.all(
        files.map(async (file) => {
          const buffer = await readFile(file);
          return { content: buffer.toString("utf-8"), buffer, filename: basename(file) };
        })
      );

      const convertOptions = {
        selfRole: opts.selfRole,
        selfName: opts.self,
        map,
        dateFormat: opts.dateFormat,
        includeFuture: opts.includeFuture
      };

      const first = loaded[0]!;
      const { payload, skipped, notices, droppedFieldCount, droppedEntryCount, futureEntriesExcludedCount } =
        loaded.length === 1
          ? await convertFile(opts.from, first.content, { ...convertOptions, filename: first.filename }, first.buffer)
          : await convertFiles(opts.from, loaded, convertOptions);

      // Importer-backed formats report row-aware, grouped notices; the plain CSV presets report skipped rows only.
      const skippedCount = notices ? notices.filter((n) => n.kind === "skipped").length : skipped.length;
      if (notices) printNotices(notices);
      else for (const row of skipped) console.error(`skipped row ${row.row}: ${row.reason}`);

      const result = validatePayload(payload);
      if (!result.valid) {
        printValidationErrors(result);
        process.exitCode = 1;
        return;
      }

      const output = JSON.stringify(result.payload, null, 2);
      if (opts.output) {
        await writeFile(opts.output, output, "utf-8");
      } else {
        console.log(output);
      }
      console.error(`converted ${payload.entries?.length ?? 0} entries, ${skippedCount} skipped`);
      if (droppedEntryCount) {
        console.error(`${droppedEntryCount} parsed entr${droppedEntryCount === 1 ? "y" : "ies"} dropped (no public payload slot, e.g. FSTD sessions)`);
      }
      if (droppedFieldCount) {
        console.error(
          `${droppedFieldCount} field${droppedFieldCount === 1 ? "" : "s"} dropped converting to the public payload format (approaches, manual time overrides, IFR flag, actual route, see src/import/to-payload.ts)`
        );
      }
      if (futureEntriesExcludedCount) {
        console.error(
          `${futureEntriesExcludedCount} planned/future row${futureEntriesExcludedCount === 1 ? "" : "s"} excluded (not yet flown; pass --include-future to keep them)`
        );
      }
    }
  );

program
  .command("link")
  .description("Build jetlog.app import deeplinks for a payload")
  .argument("<file>", "file to read, or - for stdin")
  .option("--scheme <scheme>", "https or jetlog", "https")
  .option("--max-length <n>", "max URL length per link", "6000")
  .option("--open", "open the first link with the OS opener")
  .action(
    async (
      file: string,
      opts: { scheme: DeeplinkScheme; maxLength: string; open?: boolean }
    ) => {
      const content = await readInput(file);
      const data = JSON.parse(content);
      const result = validatePayload(data);
      if (!result.valid || !result.payload) {
        printValidationErrors(result);
        process.exitCode = 1;
        return;
      }
      const links = buildImportLinks(result.payload, {
        scheme: opts.scheme,
        maxLength: Number.parseInt(opts.maxLength, 10)
      });
      for (const link of links) console.log(link);
      if (opts.open && links[0]) {
        await openLink(links[0]);
      }
    }
  );

program
  .command("push")
  .description("Push a Jetlog import payload to the External Partner API")
  .argument("<file>", "file to read, or - for stdin")
  .option("--base-url <url>", "override API base URL", "https://jetlog.app")
  .option("--dry-run", "only validate, do not send")
  .action(async (file: string, opts: { baseUrl: string; dryRun?: boolean }) => {
    const content = await readInput(file);
    const data = JSON.parse(content);
    const result = validatePayload(data, "api");
    if (!result.valid || !result.payload) {
      printValidationErrors(result);
      process.exitCode = 1;
      return;
    }

    if (opts.dryRun) {
      console.log(`valid: ${result.payload.entries?.length ?? 0} entries, dry run, nothing sent`);
      return;
    }

    const userKey = process.env.JETLOG_USER_KEY;
    const partnerKey = process.env.JETLOG_PARTNER_KEY;
    if (!userKey || !partnerKey) {
      console.error("error: JETLOG_USER_KEY and JETLOG_PARTNER_KEY must be set");
      process.exitCode = 1;
      return;
    }

    const entries = result.payload.entries ?? [];
    const batchSize = 500;
    for (let i = 0; i < entries.length || i === 0; i += batchSize) {
      const batch: Payload = {
        entries: entries.slice(i, i + batchSize),
        people: i === 0 ? result.payload.people ?? [] : []
      };
      if (batch.entries!.length === 0 && i !== 0) break;

      const response = await fetch(`${opts.baseUrl}/external/v1/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userKey}:${partnerKey}`
        },
        body: JSON.stringify(batch)
      });
      const body = (await response.json().catch(() => ({}))) as {
        skipped?: unknown[];
        warnings?: unknown[];
        error?: string;
      };
      if (!response.ok) {
        console.error(`error: HTTP ${response.status}: ${body.error ?? "unknown error"}`);
        process.exitCode = 1;
        continue;
      }
      if (body.skipped?.length) console.log(`skipped: ${JSON.stringify(body.skipped, null, 2)}`);
      if (body.warnings?.length) console.log(`warnings: ${JSON.stringify(body.warnings, null, 2)}`);
      console.log(`batch ${Math.floor(i / batchSize) + 1}: OK`);

      if (entries.length === 0) break;
    }
  });

const ai = program.command("ai").description("AI-assisted conversion (bring your own API key)");

ai.command("convert")
  .description("Convert a logbook file to Jetlog JSON using an LLM")
  .argument("<file>", "file to convert (csv, tsv, txt, json, md)")
  .option("--provider <provider>", "anthropic or openai", "anthropic")
  .option("--model <model>", "model override")
  .option("-o, --output <file>", "output file (default: stdout)")
  .option("--instructions <text>", "extra instructions for the model")
  .action(
    async (
      file: string,
      opts: { provider: "anthropic" | "openai"; model?: string; output?: string; instructions?: string }
    ) => {
      const apiKeyEnv = opts.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        console.error(`error: ${apiKeyEnv} is not set`);
        process.exitCode = 1;
        return;
      }
      const content = await readFile(file, "utf-8");
      const provider = createProvider(opts.provider, apiKey);
      const model =
        opts.model ??
        process.env.JETLOG_AI_MODEL ??
        (opts.provider === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);

      const { payload, warnings } = await aiConvert(content, {
        provider,
        model,
        instructions: opts.instructions,
        jsonSchema: getJsonSchema()
      });

      for (const warning of warnings) console.error(`warning: ${warning}`);

      const parsed = payloadSchema.safeParse(payload);
      const entries = parsed.success ? parsed.data.entries ?? [] : [];
      const dates = entries.map((e) => e.date).sort();
      const range = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : "n/a";
      console.error(`converted ${entries.length} entries, date range ${range}`);
      console.error("nothing was written to Jetlog. Use `jetlog link` or `jetlog push` to import it.");

      const output = JSON.stringify(payload, null, 2);
      if (opts.output) {
        await writeFile(opts.output, output, "utf-8");
      } else {
        console.log(output);
      }
    }
  );

/** `--since`/`--until` as a derived-date period; undefined when neither is given. */
function parsePeriod(since: string | undefined, until: string | undefined): Period | undefined {
  for (const [flag, value] of [["--since", since], ["--until", until]] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${flag} must be a date like 2026-01-31`);
  }
  return since || until ? { from: since, to: until } : undefined;
}

async function runReadCommand(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`error: ${err.message}`);
    } else {
      console.error(`error: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

program
  .command("login")
  .description("Log in to Jetlog via the device-code flow")
  .option("--scope <scope>", "read or write (file access and signatures are requested along with it)", "read")
  .option("--profile <name>", "credential profile to save under", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .option("--no-qr", "don't print the QR code in the terminal")
  .option("--open", "also open the sign-in link in a browser")
  .action(async (opts: { scope: string; profile: string; baseUrl?: string; qr: boolean; open?: boolean }) => {
    const scope = opts.scope;
    if (scope !== "read" && scope !== "write") {
      console.error("error: --scope must be read or write");
      process.exitCode = 1;
      return;
    }
    await runReadCommand(() =>
      login({ profile: opts.profile, scope, baseUrl: opts.baseUrl, qr: opts.qr, open: opts.open })
    );
  });

program
  .command("logout")
  .description("Remove the locally stored Jetlog credential")
  .option("--profile <name>", "credential profile to remove", "default")
  .action(async (opts: { profile: string }) => {
    await runReadCommand(() => logout(opts.profile));
  });

program
  .command("whoami")
  .description("Show the account and token behind the active login")
  .option("--profile <name>", "credential profile", "default")
  .option("--json", "machine-readable output")
  .action(async (opts: { profile: string; json?: boolean }) => {
    await runReadCommand(() => whoami(opts.profile, { json: opts.json }));
  });

const token = program.command("token").description("Manage the stored credential");

token
  .command("print")
  .description("Print the active token (explicit opt-in only; never printed otherwise)")
  .option("--profile <name>", "credential profile", "default")
  .action(async (opts: { profile: string }) => {
    const { resolveToken } = await import("./auth/credentials.js");
    const value = await resolveToken(opts.profile);
    if (!value) {
      console.error(`error: not logged in (profile: ${opts.profile})`);
      process.exitCode = 1;
      return;
    }
    console.log(value);
  });

function addReadFormatOptions<T extends Command>(cmd: T): T {
  return cmd
    .option("--profile <name>", "credential profile", "default")
    .option("--base-url <url>", "override API base URL (for local dev)")
    .option("--json", "JSON output")
    .option("--csv", "CSV output")
    .option("--table", "table output (default)") as T;
}

interface EntryFilterOpts {
  profile: string;
  baseUrl?: string;
  json?: boolean;
  csv?: boolean;
  table?: boolean;
  from?: string;
  to?: string;
  type?: string;
  registration?: string;
  airport?: string;
  flightNumber?: string;
  personId?: string;
  role?: string;
  includeDeleted?: boolean;
  limit?: string;
  all?: boolean;
}

function addEntryFilters<T extends Command>(cmd: T): T {
  return cmd
    .option("--from <date>", "YYYY-MM-DD, inclusive")
    .option("--to <date>", "YYYY-MM-DD, inclusive")
    .option("--type <type>", "flight or fstd")
    .option("--registration <reg>", "aircraft registration")
    .option("--airport <icao>", "departure or arrival airport")
    .option("--flight-number <n>", "flight number")
    .option("--person-id <id>", "crew person id")
    .option("--role <role>", "crew role")
    .option("--include-deleted", "include soft-deleted entries")
    .option("--limit <n>", "page size, max 200", "50")
    .option("--all", "fetch every page instead of just the first") as T;
}

const entries = program.command("entries").description("Query your logbook entries");

for (const sub of [entries.command("list").description("List entries"), entries.command("search").description("Search entries (alias of list)")]) {
  addEntryFilters(addReadFormatOptions(sub)).action(async (opts: EntryFilterOpts) => {
    await runReadCommand(() =>
      entriesList({
        profile: opts.profile,
        baseUrl: opts.baseUrl,
        format: parseOutputFormat(opts),
        from: opts.from,
        to: opts.to,
        type: opts.type,
        registration: opts.registration,
        airport: opts.airport,
        flightNumber: opts.flightNumber,
        personId: opts.personId,
        role: opts.role,
        includeDeleted: opts.includeDeleted,
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        all: opts.all
      })
    );
  });
}

addReadFormatOptions(program.command("people").description("List people in your logbook")).action(
  async (opts: { profile: string; baseUrl?: string; json?: boolean; csv?: boolean; table?: boolean }) => {
    await runReadCommand(() => peopleList({ profile: opts.profile, baseUrl: opts.baseUrl, format: parseOutputFormat(opts) }));
  }
);

addReadFormatOptions(program.command("aircraft").description("List aircraft in your logbook")).action(
  async (opts: { profile: string; baseUrl?: string; json?: boolean; csv?: boolean; table?: boolean }) => {
    await runReadCommand(() => aircraftList({ profile: opts.profile, baseUrl: opts.baseUrl, format: parseOutputFormat(opts) }));
  }
);

program
  .command("export")
  .description("Export your full logbook (paginated, streamed to disk)")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .option("-o, --output <file>", "output file (default: stdout)")
  .option("--format <format>", "json or csv", "json")
  .option("--include-deleted", "include soft-deleted entries")
  .action(
    async (opts: { profile: string; baseUrl?: string; output?: string; format: "json" | "csv"; includeDeleted?: boolean }) => {
      await runReadCommand(() =>
        runExport({
          profile: opts.profile,
          baseUrl: opts.baseUrl,
          output: opts.output,
          format: opts.format,
          includeDeleted: opts.includeDeleted
        })
      );
    }
  );

program
  .command("times")
  .description("Compute per-entry flight times (PIC, night, IFR, EASA columns, ...) for a logbook file")
  .argument("<file>", "file to convert and compute times for")
  .requiredOption(
    "--from <format>",
    "csv | foreflight | logten | pilotlog | flylog | safelog | skylife | chrono | rblogbook | flightlogger | excel | monthly-overview | jetlog-csv | deeplink-json | jetlog | auto"
  )
  .option("--self <name>", "which crew name in the file is you (LogTen); default: the name that appears most often")
  .option("--self-role <role>", "credit yourself this role on every entry (csv, foreflight: formats whose rows do not say)")
  .option("--json", "print the per-entry calculation as JSON instead of a table")
  .option("--profile <name>", "credential profile whose airport catalog and places are used when logged in", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .option("--offline", "do not fetch the airport catalog: resolve no airports (night time and distance-based figures are then not computed)")
  .action(
    async (
      file: string,
      opts: { from: ConvertFormat; self?: string; selfRole?: string; json?: boolean; profile: string; baseUrl?: string; offline?: boolean }
    ) => {
      const content = await readFile(file, "utf-8");
      await useLoggedInAirportsIfAvailable({ profile: opts.profile, baseUrl: opts.baseUrl, offline: opts.offline });
      const { calculated, skippedNoSelfPersonCount, parseWarnings, notes } = await computeFileEntryTimes(opts.from, content, basename(file), {
        selfRole: opts.selfRole,
        selfName: opts.self
      });

      for (const warning of parseWarnings) console.error(`warning: ${warning}`);
      for (const note of notes) console.error(note);

      if (opts.json) {
        console.log(JSON.stringify(calculated, null, 2));
      } else if (calculated.length > 0) {
        console.log(formatEntryTimesTable(calculated));
      }
      reportSelfOutcome(opts.from, skippedNoSelfPersonCount, calculated.length, "computed times for");
    }
  );

program
  .command("totals")
  .description("Compute aggregate flight-time totals for a logbook file, or for your logged-in Jetlog data")
  .argument("[file]", "file to convert and total up, or omit to use your logged-in Jetlog data")
  .option(
    "--from <format>",
    "csv | foreflight | logten | pilotlog | flylog | safelog | skylife | chrono | rblogbook | flightlogger | excel | monthly-overview | jetlog-csv | deeplink-json | jetlog | auto (required when a file is given)"
  )
  .option("--self <name>", "which crew name in the file is you (LogTen); default: the name that appears most often")
  .option("--self-role <role>", "credit yourself this role on every entry (csv, foreflight: formats whose rows do not say)")
  .option("--json", "print the totals as a JSON object instead of a summary")
  .option("--since <date>", "only count entries whose derived date is on or after this date (YYYY-MM-DD)")
  .option("--until <date>", "only count entries whose derived date is on or before this date (YYYY-MM-DD)")
  .option("--profile <name>", "credential profile (when no file is given, and for the airport catalog when logged in)", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .option("--offline", "do not fetch the airport catalog: resolve no airports (night time and distance-based figures are then not computed)")
  .action(
    async (
      file: string | undefined,
      opts: {
        from?: ConvertFormat;
        self?: string;
        selfRole?: string;
        json?: boolean;
        since?: string;
        until?: string;
        profile: string;
        baseUrl?: string;
        offline?: boolean;
      }
    ) => {
      await runReadCommand(async () => {
        const period = parsePeriod(opts.since, opts.until);
        if (file) {
          if (!opts.from) {
            throw new Error("--from is required when a file is given");
          }
          const content = await readFile(file, "utf-8");
          await useLoggedInAirportsIfAvailable({ profile: opts.profile, baseUrl: opts.baseUrl, offline: opts.offline });
          const { entryTimesResult, ...totals } = await computeFileTotals(opts.from, content, basename(file), {
            period,
            selfRole: opts.selfRole,
            selfName: opts.self
          });

          for (const warning of entryTimesResult.parseWarnings) console.error(`warning: ${warning}`);
          for (const note of entryTimesResult.notes) console.error(note);
          console.log(opts.json ? JSON.stringify(totals, null, 2) : formatTotalsSummary(totals, period));
          reportSelfOutcome(opts.from, entryTimesResult.skippedNoSelfPersonCount, entryTimesResult.calculated.length, "computed totals from");
        } else {
          const client = await requireClient(opts.profile, opts.baseUrl);
          const { skippedNoSelfPersonCount, notes, ...totals } = await computeProfileTotals(client, {
            profile: opts.profile,
            offline: opts.offline,
            period
          });
          for (const note of notes) console.error(note);
          console.log(opts.json ? JSON.stringify(totals, null, 2) : formatTotalsSummary(totals, period));
          if (skippedNoSelfPersonCount > 0) {
            console.error(
              `${skippedNoSelfPersonCount} entr${skippedNoSelfPersonCount === 1 ? "y" : "ies"} skipped: no matching self person on ${skippedNoSelfPersonCount === 1 ? "it" : "them"}`
            );
          }
        }
      });
    }
  );

program
  .command("import")
  .description("Import a logbook file into your Jetlog account (requires `jetlog login --scope write`)")
  .argument("<files...>", "file(s) to import, see `jetlog convert`'s --from for multi-file formats (e.g. rblogbook)")
  .requiredOption(
    "--from <format>",
    "logten | pilotlog | flylog | safelog | skylife | chrono | rblogbook | flightlogger | excel | monthly-overview | jetlog-csv | deeplink-json | auto"
  )
  .option("--dry-run", "parse, match and preview only, never writes")
  .option("--yes", "skip the confirmation prompt")
  .option("--label <text>", "label for the import batch (shown in `jetlog batches list` and the app's Settings screen)")
  .option("--self <name>", "which crew name in the file is you (LogTen); default: the name that appears most often")
  .option("--include-future", "keep rows dated after today (see `jetlog convert --include-future`)")
  .option(
    "--as-new",
    "materialize every row that would otherwise match an existing entry as an independent new entry instead " +
      "(all-or-nothing for this run, see docs/IMPORTERS.md)"
  )
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(
    async (
      files: string[],
      opts: {
        from: string;
        dryRun?: boolean;
        yes?: boolean;
        label?: string;
        self?: string;
        includeFuture?: boolean;
        asNew?: boolean;
        profile: string;
        baseUrl?: string;
      }
    ) => {
      await runReadCommand(() =>
        runImport({
          files,
          from: opts.from,
          dryRun: opts.dryRun,
          yes: opts.yes,
          label: opts.label,
          self: opts.self,
          includeFuture: opts.includeFuture,
          asNew: opts.asNew,
          profile: opts.profile,
          baseUrl: opts.baseUrl
        })
      );
    }
  );

const batches = program.command("batches").description("Manage CLI import batches");

addReadFormatOptions(batches.command("list").description("List import batches")).action(
  async (opts: { profile: string; baseUrl?: string; json?: boolean; csv?: boolean; table?: boolean }) => {
    await runReadCommand(() => batchesList({ profile: opts.profile, baseUrl: opts.baseUrl, format: parseOutputFormat(opts) }));
  }
);

batches
  .command("remove")
  .description("Remove an import batch's created entries (soft-delete), previewing first")
  .argument("[id]", "import batch id, omit when passing --all-cli")
  .option("--all-cli", "remove every CLI-created entry across all import batches, ignoring [id]")
  .option("--include-link-signed", "also remove entries that were signed through a signing link a token created (kept by default)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(
    async (
      id: string | undefined,
      opts: { allCli?: boolean; includeLinkSigned?: boolean; yes?: boolean; profile: string; baseUrl?: string }
    ) => {
      await runReadCommand(() => {
        if (opts.allCli) {
          return batchesRemoveAllCli({ profile: opts.profile, baseUrl: opts.baseUrl, yes: opts.yes, includeLinkSigned: opts.includeLinkSigned });
        }
        if (!id) throw new Error("either pass <id> or --all-cli");
        return batchesRemove({ profile: opts.profile, baseUrl: opts.baseUrl, id, yes: opts.yes, includeLinkSigned: opts.includeLinkSigned });
      });
    }
  );

batches
  .command("remove-all-cli")
  .description("Remove every CLI-created entry across all import batches, previewing first")
  .option("--include-link-signed", "also remove entries that were signed through a signing link a token created (kept by default)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (opts: { includeLinkSigned?: boolean; yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() =>
      batchesRemoveAllCli({ profile: opts.profile, baseUrl: opts.baseUrl, yes: opts.yes, includeLinkSigned: opts.includeLinkSigned })
    );
  });

const attachments = program.command("attachments").description("Files on logbook entries (add needs `jetlog login --scope write`)");

addReadFormatOptions(attachments.command("list").description("List the files on an entry").argument("<entry-id>", "entry id")).action(
  async (entryId: string, opts: { profile: string; baseUrl?: string; json?: boolean; csv?: boolean; table?: boolean }) => {
    await runReadCommand(() => attachmentsList({ profile: opts.profile, baseUrl: opts.baseUrl, entryId, format: parseOutputFormat(opts) }));
  }
);

attachments
  .command("add")
  .description("Upload files and attach them to an entry (PNG, JPEG, HEIC or PDF, up to 25 MiB, 20 per entry)")
  .argument("<entry-id>", "entry id")
  .argument("<files...>", "local file(s) to attach")
  .option("--name <file_name>", "file name to store (a single file only), default: the local file name")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryId: string, files: string[], opts: { name?: string; yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => attachmentsAdd({ profile: opts.profile, baseUrl: opts.baseUrl, entryId, files, name: opts.name, yes: opts.yes }));
  });

attachments
  .command("get")
  .description("Download an entry file by its attachment id (signature images need `signatures get`)")
  .argument("<attachment-id>", "attachment id, as shown by `attachments list`")
  .option("-o, --output <path>", "file or directory to write to (default: the current directory)")
  .option("--force", "overwrite an existing file")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (attachmentId: string, opts: { output?: string; force?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() =>
      attachmentsGet({ profile: opts.profile, baseUrl: opts.baseUrl, attachmentId, output: opts.output, force: opts.force })
    );
  });

attachments
  .command("remove")
  .description("Remove a file from its entry")
  .argument("<entry-attachment-id>", "file row id, the first column of `attachments list`")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (id: string, opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => attachmentsRemove({ profile: opts.profile, baseUrl: opts.baseUrl, id, yes: opts.yes }));
  });

const photos = program.command("photos").description("Photos of people in your logbook (set needs `jetlog login --scope write`)");

photos
  .command("set")
  .description("Set a person's photo (PNG or JPEG, up to 2 MiB)")
  .argument("<person-id>", "person id")
  .argument("<image>", "local image file")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (personId: string, image: string, opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => photosSet({ profile: opts.profile, baseUrl: opts.baseUrl, personId, image, yes: opts.yes }));
  });

photos
  .command("get")
  .description("Download a person's photo")
  .argument("<person-id>", "person id")
  .option("-o, --output <path>", "file or directory to write to (default: the current directory)")
  .option("--force", "overwrite an existing file")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (personId: string, opts: { output?: string; force?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => photosGet({ profile: opts.profile, baseUrl: opts.baseUrl, personId, output: opts.output, force: opts.force }));
  });

const signatures = program
  .command("signatures")
  .description("Signatures on logbook entries (changes need `jetlog login --scope write`; images need the signatures permission). Attach, replace and remove are recorded in your audit log.");

signatures
  .command("show")
  .description("Show an entry's signature state and checksum (the image itself: `signatures get`)")
  .argument("<entry-id>", "entry id")
  .option("--json", "machine-readable output")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryId: string, opts: { json?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesShow({ profile: opts.profile, baseUrl: opts.baseUrl, entryId, json: opts.json }));
  });

signatures
  .command("get")
  .description("Download the signature image of a signed entry (needs the signatures permission)")
  .argument("<entry-id>", "entry id")
  .option("-o, --output <path>", "file or directory to write to (default: the current directory)")
  .option("--force", "overwrite an existing file")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryId: string, opts: { output?: string; force?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesGet({ profile: opts.profile, baseUrl: opts.baseUrl, entryId, output: opts.output, force: opts.force }));
  });

signatures
  .command("attach")
  .description("Attach a PNG image (up to 5 MiB) as the signature of an entry. On a signed entry it replaces the signature")
  .argument("<entry-id>", "entry id")
  .argument("<image>", "local PNG file")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryId: string, image: string, opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesAttach({ profile: opts.profile, baseUrl: opts.baseUrl, entryId, image, yes: opts.yes }));
  });

signatures
  .command("remove")
  .description("Remove the signature image from signed entries (they go back to unsigned)")
  .argument("<entry-id...>", "entry id(s)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryIds: string[], opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesRemove({ profile: opts.profile, baseUrl: opts.baseUrl, entryIds, yes: opts.yes }));
  });

signatures
  .command("waive")
  .description("Waive the signature on unsigned entries")
  .argument("<entry-id...>", "entry id(s)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryIds: string[], opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesWaive({ profile: opts.profile, baseUrl: opts.baseUrl, entryIds, yes: opts.yes }));
  });

signatures
  .command("unwaive")
  .description("Undo a waived signature")
  .argument("<entry-id...>", "entry id(s)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryIds: string[], opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesUnwaive({ profile: opts.profile, baseUrl: opts.baseUrl, entryIds, yes: opts.yes }));
  });

signatures
  .command("request")
  .description("Create a remote signing link for up to 20 entries (valid 48 hours, printed once)")
  .argument("<entry-id...>", "entry id(s)")
  .option("--yes", "skip the confirmation prompt")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (entryIds: string[], opts: { yes?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesRequest({ profile: opts.profile, baseUrl: opts.baseUrl, entryIds, yes: opts.yes }));
  });

signatures
  .command("revoke")
  .description("Revoke a signing link this login created")
  .argument("<request-id>", "request id, as printed by `signatures request`")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (requestId: string, opts: { profile: string; baseUrl?: string }) => {
    await runReadCommand(() => signaturesRevoke({ profile: opts.profile, baseUrl: opts.baseUrl, requestId }));
  });

const changes = program
  .command("changes")
  .description(
    "Inspect/apply AI-proposed pending changes (requires `jetlog login --scope write`), mostly for " +
      "testing the propose/apply flow by hand; proposing itself is done by an AI client or `jetlog mcp`, " +
      "not from here."
  );

changes
  .command("show")
  .description("Show a pending change's preview and status")
  .argument("<id>", "pending change id")
  .option("--json", "machine-readable output")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (id: string, opts: { json?: boolean; profile: string; baseUrl?: string }) => {
    await runReadCommand(() => changesShow({ profile: opts.profile, baseUrl: opts.baseUrl, id, json: opts.json }));
  });

changes
  .command("apply")
  .description("Apply a pending change for real, previewing and confirming first")
  .argument("<id>", "pending change id")
  .option("--yes", "skip the confirmation prompt")
  .option("--operation-indices <indices>", "comma-separated subset of operation indices to apply")
  .option("--profile <name>", "credential profile", "default")
  .option("--base-url <url>", "override API base URL (for local dev)")
  .action(async (id: string, opts: { yes?: boolean; operationIndices?: string; profile: string; baseUrl?: string }) => {
    await runReadCommand(() =>
      changesApply({
        profile: opts.profile,
        baseUrl: opts.baseUrl,
        id,
        yes: opts.yes,
        operationIndices: opts.operationIndices
          ? opts.operationIndices.split(",").map((s) => Number.parseInt(s.trim(), 10))
          : undefined
      })
    );
  });

program
  .command("mcp")
  .description("Run a stdio MCP server exposing Jetlog import tools")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program.parseAsync(process.argv);

#!/usr/bin/env node
// Copies the flight signatures out of the CL PILOTLOG (mccPILOTLOG) data folder on an
// Apple silicon Mac and, with --attach, puts them on the matching entries in Jetlog.
//
//   node pilotlog-signatures.mjs                      copy the signatures to ./pilotlog-signatures
//   node pilotlog-signatures.mjs --attach --dry-run   show which entries they would go on
//   node pilotlog-signatures.mjs --attach             attach them (asks first)
//
// Needs Node 20+, the macOS sqlite3 tool, and for --attach the jetlog CLI with a write login.
// The PILOTLOG folder is only read, never changed.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const DEFAULT_DATA = join(homedir(), "Library/Containers/aero.crewlounge.pilotlogclaero/Data/Documents");
const JETLOG = process.env.JETLOG_BIN || "jetlog";
const TIME_TOLERANCE_MINUTES = 30;

const USAGE = `Usage: pilotlog-signatures.mjs [options]

  --data <dir>      PILOTLOG data folder (default: ${DEFAULT_DATA})
  --out <dir>       where the PNG files, signatures.json and attach-list.json go (default: ./pilotlog-signatures)
  --attach          match the signatures to your Jetlog entries and attach them
  --dry-run         with --attach: show what would be attached, change nothing
  --yes             with --attach: do not ask for confirmation
  --profile <name>  Jetlog login profile, passed on to jetlog
  -h, --help        show this help

Set JETLOG_BIN to run another executable than "jetlog".`;

// The query selects signatures: images whose link code is a flight code.
const QUERY = `
SELECT i.ZIMGCODE AS image_code, i.ZFILENAME AS file_name, i.ZFILEEXT AS file_ext,
       i.ZRECORDMODIFIED AS image_modified,
       f.ZFLIGHTCODE AS flight_code, f.ZDATEUTC AS date_utc, f.ZDATELOCAL AS date_local,
       f.ZDATEBASE AS date_base, f.ZFLIGHTNUMBER AS flight_number,
       f.ZDEPTIMEUTC AS dep_minutes_utc,
       d.ZAFICAO AS dep_icao, d.ZAFIATA AS dep_iata,
       a.ZAFICAO AS arr_icao, a.ZAFIATA AS arr_iata,
       ac.ZREFERENCE AS registration, ac.ZDEVICECODE AS device_code
FROM ZMCCIMAGEPIC i
JOIN ZMCCFLIGHT f ON f.ZFLIGHTCODE = i.ZLINKCODE
LEFT JOIN ZMCCAIRFIELD d ON d.Z_PK = f.ZDEPARTUREAIRFIELD
LEFT JOIN ZMCCAIRFIELD a ON a.Z_PK = f.ZARRIVALAIRFIELD
LEFT JOIN ZMCCAIRCRAFT ac ON ac.Z_PK = f.ZAIRCRAFT
ORDER BY f.ZDATEUTC, f.ZDEPTIMEUTC, i.ZRECORDMODIFIED`;

class Fail extends Error {}

// ---------- small helpers ----------

// Values from the PILOTLOG database and from the server end up in the terminal, so control characters go.
const text = (v) => (v == null ? "" : String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim());
const norm = (v) => text(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
const code = (v) => text(v).toUpperCase();

function minutesToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Start of the PILOTLOG flight as minutes after midnight UTC, or null when no time was logged. */
function depMinutes(sig) {
  const m = sig.dep_minutes_utc;
  return typeof m === "number" && m >= 0 && m < 1440 ? m : null;
}

/** "HH:MM" or "HH:MM:SS" to minutes after midnight, or null. */
function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(text(v));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Epoch minutes of a YYYY-MM-DD date plus minutes of day, or null. */
function epochMinutes(date, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(date));
  if (!m || minutes == null) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 60000 + minutes;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function profileArgs(profile) {
  return profile ? ["--profile", profile] : [];
}

// ---------- step A: extract ----------

function checkDatabase(dbPath, dataDir) {
  try {
    statSync(dbPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Fail(
        `PILOTLOG data not found at ${dataDir}.\n` +
          "Install CL PILOTLOG from the App Store on this Mac and open it once so it has synced, " +
          "or pass the folder with --data."
      );
    }
    if (err.code === "EPERM" || err.code === "EACCES") {
      throw new Fail(
        "macOS blocked access to another app's data.\n" +
          "Answer Allow when macOS asks. If you denied it earlier, give your terminal Full Disk Access " +
          "under System Settings > Privacy & Security."
      );
    }
    throw new Fail(`Cannot read ${dbPath}: ${err.message}`);
  }
}

function queryDatabase(dbPath) {
  let out;
  try {
    out = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 5000", dbPath, QUERY], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    if (err.code === "ENOENT") throw new Fail("The sqlite3 command was not found. It ships with macOS.");
    throw new Fail(`sqlite3 failed: ${text(err.stderr) || err.message}`);
  }
  return out.trim() === "" ? [] : JSON.parse(out); // sqlite3 prints nothing for zero rows
}

/** One signature per flight: keep the newest image. Returns the kept rows and how many were left out. */
function newestPerFlight(rows) {
  const byFlight = new Map();
  let leftOut = 0;
  for (const row of rows) {
    const key = row.flight_code;
    const prev = byFlight.get(key);
    if (!prev) {
      byFlight.set(key, row);
      continue;
    }
    leftOut++;
    if (Number(row.image_modified) >= Number(prev.image_modified)) {
      byFlight.set(key, row);
    }
  }
  return { rows: [...byFlight.values()], leftOut };
}

const airport = (icao, iata) => code(icao) || code(iata) || "XXXX";
const clean = (v) => text(v).replace(/[^A-Za-z0-9_-]/g, "");

function fileNameFor(sig) {
  const when = sig.date_utc || sig.date_local || sig.date_base || "nodate";
  const mins = depMinutes(sig);
  const third = clean(sig.flight_number) || (mins == null ? "" : minutesToHHMM(mins).replace(":", ""));
  const parts = [clean(when), `${clean(sig.from)}-${clean(sig.to)}`, third, clean(text(sig.flight_code).slice(0, 8))];
  return `${parts.filter(Boolean).join("_")}.png`;
}

function extract(dataDir, outDir) {
  const dbPath = join(dataDir, "mccPilotLog.sqlite");
  checkDatabase(dbPath, dataDir);
  const { rows, leftOut } = newestPerFlight(queryDatabase(dbPath));
  if (leftOut > 0) console.log(`Note: ${leftOut} older image${leftOut === 1 ? "" : "s"} left out (flights with several images use the newest).`);

  const copied = [];
  for (const row of rows) {
    const sig = {
      ...row,
      from: airport(row.dep_icao, row.dep_iata),
      to: airport(row.arr_icao, row.arr_iata),
      simulator: row.device_code === 2
    };
    const label = `${sig.date_utc || sig.date_local || "no date"} ${sig.from}-${sig.to} ${text(sig.flight_number)}`.trim();
    const source = join(dataDir, "images", `${text(row.file_name)}.${text(row.file_ext)}`);
    if (text(row.file_ext).toLowerCase() !== "png") {
      console.log(`${label}: not a PNG, skipped`);
      continue;
    }
    if (!existsSync(source)) {
      console.log(`${label}: image not on this Mac yet (open PILOTLOG and let it sync)`);
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    sig.file = fileNameFor(sig);
    sig.path = join(outDir, sig.file);
    copyFileSync(source, sig.path);
    copied.push(sig);
  }

  if (rows.length === 0) {
    console.log("PILOTLOG holds no flight signatures.");
    return copied;
  }
  for (const s of copied) {
    const mins = depMinutes(s);
    console.log(
      [s.date_utc || s.date_local || "", mins == null ? "     " : minutesToHHMM(mins), `${s.from}-${s.to}`,
        text(s.flight_number), text(s.registration), s.file].join("  ")
    );
  }
  if (copied.length > 0) {
    const json = copied.map((s) => ({
      file: s.file,
      flight_code: s.flight_code ?? null,
      date: s.date_utc || s.date_local || s.date_base || null,
      from: s.from,
      to: s.to,
      off_blocks: depMinutes(s) == null ? null : minutesToHHMM(depMinutes(s)),
      flight_number: text(s.flight_number) || null,
      registration: text(s.registration) || null,
      simulator: s.simulator
    }));
    writeFileSync(join(outDir, "signatures.json"), JSON.stringify(json, null, 2) + "\n");
  }
  console.log(`Copied ${copied.length} signature${copied.length === 1 ? "" : "s"} to ${outDir}`);
  return copied;
}

// ---------- step B: match and attach ----------

/** The PILOTLOG dates a flight may carry (UTC, local and base date). */
const pilotlogDates = (sig) => [sig.date_utc, sig.date_local, sig.date_base].map(text).filter(Boolean);

function entryFields(entry) {
  const d = entry.derived ?? {};
  const pick = (k) => d[k] ?? entry[k];
  const date = pick("date");
  const timeOfDay = entry.type === "fstd" ? entry.start_time : pick("off_blocks");
  return {
    date,
    minutes: parseTime(timeOfDay),
    from: code(pick("from")),
    to: code(pick("to")),
    registration: norm(pick("registration")),
    flightNumber: norm(entry.flight_number)
  };
}

/** Does this entry fit the PILOTLOG flight? */
function isCandidate(sig, entry) {
  if (entry.is_deleted) return false;
  if (entry.type !== (sig.simulator ? "fstd" : "flight")) return false;
  const e = entryFields(entry);
  if (!sig.simulator) {
    const dep = [code(sig.dep_icao), code(sig.dep_iata)].filter(Boolean);
    const arr = [code(sig.arr_icao), code(sig.arr_iata)].filter(Boolean);
    if (!dep.includes(e.from) || !arr.includes(e.to)) return false;
  }
  const mine = epochMinutes(sig.date_utc, depMinutes(sig));
  const theirs = epochMinutes(e.date, e.minutes);
  if (mine != null && theirs != null) return Math.abs(mine - theirs) <= TIME_TOLERANCE_MINUTES;
  return pilotlogDates(sig).includes(text(e.date));
}

/** Narrow several candidates with a test, but only when that leaves at least one. */
function narrow(candidates, test) {
  if (candidates.length < 2) return candidates;
  const kept = candidates.filter(test);
  return kept.length > 0 ? kept : candidates;
}

function findEntry(sig, entries) {
  let found = entries.filter((entry) => isCandidate(sig, entry));
  const mins = epochMinutes(sig.date_utc, depMinutes(sig));
  found = narrow(found, (entry) => {
    const e = entryFields(entry);
    return mins != null && epochMinutes(e.date, e.minutes) === mins;
  });
  found = narrow(found, (entry) => norm(sig.registration) !== "" && entryFields(entry).registration === norm(sig.registration));
  found = narrow(found, (entry) => norm(sig.flight_number) !== "" && entryFields(entry).flightNumber === norm(sig.flight_number));
  return found;
}

/**
 * Signatures and entries in, one plan item per signature out. Nothing is read or written here.
 * An item is { sig, entry, action: "attach" | "replace" } or { sig, entry?, skip: "<reason>" }.
 */
function planAttachments(signatures, entries) {
  const plan = signatures.map((sig) => {
    const found = findEntry(sig, entries);
    if (found.length === 0) return { sig, skip: "no entry found", kind: "none" };
    if (found.length > 1) return { sig, skip: `ambiguous (${found.length} entries)`, kind: "ambiguous" };
    return { sig, entry: found[0] };
  });

  const uses = new Map();
  for (const item of plan) if (item.entry) uses.set(item.entry.id, (uses.get(item.entry.id) ?? 0) + 1);
  for (const item of plan) {
    if (!item.entry) continue;
    if (uses.get(item.entry.id) > 1) {
      item.skip = "ambiguous (two signatures for one entry)";
      item.kind = "ambiguous";
    } else if (item.entry.is_bulk) {
      item.skip = "bulk entry";
      item.kind = "other";
    } else if (item.entry.signature === "signed") {
      item.skip = "already signed";
      item.kind = "signed";
    } else {
      item.action = item.entry.signature === "waived" ? "replace" : "attach";
    }
  }
  return plan;
}

function fetchEntries(signatures, profile) {
  const dates = signatures.flatMap(pilotlogDates).sort();
  if (dates.length === 0) throw new Fail("None of the signatures has a flight date, so they cannot be matched.");
  // One day of margin on both sides, because the PILOTLOG and Jetlog dates can differ around midnight.
  const window = ["--from", addDays(dates[0], -1), "--to", addDays(dates.at(-1), 1)];
  const args = ["entries", "list", "--all", "--limit", "200", "--json", ...window, ...profileArgs(profile)];
  const res = spawnSync(JETLOG, args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] });
  if (res.error?.code === "ENOENT") throw new Fail("The jetlog command was not found. Install it with: npm i -g jetlog-cli (or set JETLOG_BIN).");
  if (res.error) throw new Fail(`Could not run jetlog: ${res.error.message}`);
  if (res.status !== 0) throw new Fail("Could not read your Jetlog entries (see the message above).");
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Fail("jetlog returned something that is not JSON.");
  }
}

function describeSignature(sig) {
  const mins = depMinutes(sig);
  return [sig.date_utc || sig.date_local || "", mins == null ? "     " : minutesToHHMM(mins), `${sig.from}-${sig.to}`, text(sig.flight_number), text(sig.registration)]
    .join("  ")
    .trimEnd();
}

function printPlan(plan) {
  for (const item of plan) {
    let tail = item.skip ?? item.action;
    if (item.entry) {
      const e = entryFields(item.entry);
      const time = item.entry.type === "fstd" ? item.entry.start_time : (item.entry.derived?.off_blocks ?? item.entry.off_blocks);
      const entryText = [`entry ${text(item.entry.id)}`, e.date, text(time), e.from || e.to ? `${e.from}-${e.to}` : "", text(item.entry.flight_number)].filter(Boolean).join(" ");
      tail = `-> ${entryText}  ${item.skip ?? (item.action === "replace" ? "attach (replaces the waiver)" : "attach")}`;
    }
    console.log(`${describeSignature(item.sig)}  ${tail}`);
  }
  const count = (kind) => plan.filter((i) => i.kind === kind).length;
  const toAttach = plan.filter((i) => i.action).length;
  console.log(
    `\n${toAttach} to attach, ${count("signed")} already signed, ${count("none")} no entry found, ` +
      `${count("ambiguous")} ambiguous, ${count("other")} other skipped.`
  );
  if (count("none") + count("ambiguous") > 0) {
    console.log("Signatures without a match can be attached by hand: jetlog signatures attach <entry-id> <file>");
  }
}

async function confirmAttach(count, yes) {
  console.error("The signatures are written in one go: one line in `jetlog batches list`, one notification on your phone, and a record in your account's audit log.");
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Fail("Not a terminal, so nothing was attached. Pass --yes to attach without asking.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Attach ${count} signature${count === 1 ? "" : "s"}? [y/N] `);
  rl.close();
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function attach(signatures, opts, outDir) {
  const plan = planAttachments(signatures, fetchEntries(signatures, opts.profile));
  console.log();
  printPlan(plan);
  const todo = plan.filter((i) => i.action);
  if (opts["dry-run"]) {
    console.log("Dry run: nothing was changed.");
    return;
  }
  if (todo.length === 0) {
    console.log("Nothing to attach.");
    return;
  }
  if (!(await confirmAttach(todo.length, opts.yes))) {
    console.log("aborted: nothing was changed.");
    return;
  }
  // The PNG files sit next to the list, so the list holds file names only.
  const listPath = join(outDir, "attach-list.json");
  const list = todo.map((item) => ({ entry_id: String(item.entry.id), file: item.sig.file }));
  writeFileSync(listPath, JSON.stringify(list, null, 2) + "\n");
  // Options first, then "--": the path must never be read as an option.
  const res = spawnSync(JETLOG, ["signatures", "attach-many", "--yes", ...profileArgs(opts.profile), "--", listPath], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Fail(
      "jetlog did not attach the signatures (see the message above). Nothing is lost.\n" +
        "Run the same command again to continue: entries that are already signed are skipped."
    );
  }
}

// ---------- main ----------

async function main() {
  let opts;
  try {
    opts = parseArgs({
      options: {
        data: { type: "string" }, out: { type: "string" }, attach: { type: "boolean" },
        "dry-run": { type: "boolean" }, yes: { type: "boolean" }, profile: { type: "string" },
        help: { type: "boolean", short: "h" }
      },
      allowPositionals: false
    }).values;
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) return console.log(USAGE);
  if (!opts.attach && (opts["dry-run"] || opts.yes)) throw new Fail("--dry-run and --yes only apply with --attach.");

  const outDir = resolve(opts.out ?? "pilotlog-signatures");
  const signatures = extract(resolve(opts.data ?? DEFAULT_DATA), outDir);
  if (signatures.length === 0) return;
  if (!opts.attach) return console.log("Add --attach to put them on the matching Jetlog entries.");
  await attach(signatures, opts, outDir);
}

main().catch((err) => {
  console.error(err instanceof Fail ? err.message : `Unexpected error: ${err.message}`);
  process.exit(1);
});

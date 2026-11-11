import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../examples/pilotlog-signatures/pilotlog-signatures.mjs");

// The example script is plain JavaScript with no type declarations.
type Row = Record<string, unknown>;
interface ScriptExports {
  LAYOUTS: { name: string; db: string; imageDirs: string[]; query: string }[];
  day(v: unknown): string;
  addDays(date: string, days: number): string;
  sqliteUri(path: string): string;
  parseRows(out: string): Row[];
  planAttachments(signatures: Row[], entries: Row[]): { sig: Row; entry?: Row; action?: string; skip?: string }[];
}
const script = (await import(SCRIPT)) as ScriptExports;

const hex = (v: string) => Buffer.from(v, "utf8").toString("hex").toUpperCase();
const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

describe("pilotlog-signatures helpers", () => {
  it("reads both date styles", () => {
    expect(script.day("2023-09-26")).toBe("2023-09-26");
    expect(script.day("2023-09-26 00:00:00")).toBe("2023-09-26");
    expect(script.day("26-09-2023")).toBe("");
    expect(script.addDays("2023-09-26 00:00:00", 1)).toBe("2023-09-27");
    expect(script.addDays("2023-12-31", 1)).toBe("2024-01-01");
    expect(() => script.addDays("not a date", 1)).toThrow('Cannot read the flight date "not a date".');
  });

  it("opens the database read-only through a URI", () => {
    expect(script.sqliteUri("/Applications/PILOTLOG.app/Contents/Resources/userdata/pilotlog.db")).toBe(
      "file:/Applications/PILOTLOG.app/Contents/Resources/userdata/pilotlog.db?mode=ro"
    );
    expect(script.sqliteUri("/tmp/a?b#c%d/x.db")).toBe("file:/tmp/a%3Fb%23c%25d/x.db?mode=ro");
  });

  it("decodes the hex output, numbers and NULLs, and cuts dates to the day", () => {
    const values = [
      hex("IMG1"), hex("ABC"), hex("png"), hex("1700000000"),
      hex("FL1"), hex("2023-09-26 00:00:00"), hex("2023-09-27 00:00:00"), "", hex("KL|880"), hex("1184"),
      hex("VOBL"), hex("BLR"), hex("EHAM"), "", hex("PH-BQI"), hex("1")
    ];
    const [row] = script.parseRows(`${values.join("|")}\n`);
    expect(row).toMatchObject({
      image_code: "IMG1", image_modified: 1700000000, date_utc: "2023-09-26", date_local: "2023-09-27",
      date_base: null, flight_number: "KL|880", dep_minutes_utc: 1184, arr_iata: null, device_code: 1
    });
    expect(script.parseRows("")).toEqual([]);
    expect(() => script.parseRows("abc|def\n")).toThrow("Unexpected sqlite3 output on row 1.");
  });

  it("matches a signature with a text date from the installer database", () => {
    const sig = {
      flight_code: "FL1", date_utc: "2023-09-26", date_local: "2023-09-27", date_base: "2023-09-26",
      dep_minutes_utc: 1184, dep_icao: "VOBL", dep_iata: "BLR", arr_icao: "EHAM", arr_iata: "AMS",
      from: "VOBL", to: "EHAM", simulator: false, file: "x.png"
    };
    const entries = [
      { id: "e1", type: "flight", date: "2023-09-26", off_blocks: "19:50", from: "VOBL", to: "EHAM", signature: "none" },
      { id: "e2", type: "flight", date: "2023-09-27", off_blocks: "19:44", from: "VOBL", to: "EHAM", signature: "none" }
    ];
    const [item] = script.planAttachments([sig], entries);
    expect(item.entry?.id).toBe("e1");
    expect(item.action).toBe("attach");
  });
});

describe.skipIf(!hasSqlite)("pilotlog-signatures on a database", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-pilotlog-sigs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sql = (db: string, statements: string) => execFileSync("sqlite3", [db], { input: statements });

  // Made-up flights in the layout of the PILOTLOG Mac app from Crew Lounge's own installer.
  async function installerData(): Promise<string> {
    const data = join(dir, "user data");
    await mkdir(join(data, "gallery", "endorsements"), { recursive: true });
    sql(
      join(data, "pilotlog.db"),
      `CREATE TABLE ImagePic (ImgCode guid, FileName varchar(250), FileExt varchar(5), LinkCode guid, Record_Modified numeric(10,0));
       CREATE TABLE Flight (FlightCode guid, DateUTC date, DateLOCAL date, DateBASE date, FlightNumber varchar(15),
         AircraftCode guid, DepCode guid, ArrCode guid, DepTimeUTC integer DEFAULT 0);
       CREATE TABLE Airfield (AFCode guid, AFICAO varchar(4), AFIATA varchar(3));
       CREATE TABLE Aircraft (AircraftCode guid, DeviceCode integer, Reference varchar(25));
       INSERT INTO Airfield VALUES ('A1', 'EHAM', 'AMS'), ('A2', 'LIRQ', 'FLR');
       INSERT INTO Aircraft VALUES ('AC1', 1, 'PH-EXA');
       INSERT INTO Flight VALUES ('F1', '2026-08-22 00:00:00', '2026-08-22 00:00:00', '2026-08-22 00:00:00', 'KL1651', 'AC1', 'A1', 'A2', 360),
                                 ('F2', '2026-08-22 00:00:00', '2026-08-22 00:00:00', '2026-08-22 00:00:00', 'KL1652', 'AC1', 'A2', 'A1', 540);
       INSERT INTO ImagePic VALUES ('I1', 'IMG-ONE', 'png', 'F1', 1), ('I2', 'IMG-TWO', 'png', 'F2', 2);`
    );
    await writeFile(join(data, "gallery", "endorsements", "IMG-ONE.png"), "one");
    await writeFile(join(data, "gallery", "endorsements", "IMG-TWO.png"), "two");
    return data;
  }

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  }

  it("copies the signatures out of the installer database", async () => {
    const data = await installerData();
    const res = run(["--data", data, "--out", join(dir, "out")]);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("(installer PILOTLOG)");
    expect(res.stdout).toContain("Copied 2 signatures");
    const list = JSON.parse(await readFile(join(dir, "out", "signatures.json"), "utf8"));
    expect(list.map((s: Row) => [s.date, s.from, s.to, s.off_blocks, s.file])).toEqual([
      ["2026-08-22", "EHAM", "LIRQ", "06:00", "2026-08-22_EHAM-LIRQ_KL1651_F1.png"],
      ["2026-08-22", "LIRQ", "EHAM", "09:00", "2026-08-22_LIRQ-EHAM_KL1652_F2.png"]
    ]);
    expect(await readFile(join(dir, "out", "2026-08-22_LIRQ-EHAM_KL1652_F2.png"), "utf8")).toBe("two");
  });

  it("plans the attach in a dry run without changing anything", async () => {
    const data = await installerData();
    const entries = [
      { id: "e1", type: "flight", date: "2026-08-22", off_blocks: "06:05", from: "EHAM", to: "LIRQ", signature: "none" },
      { id: "e2", type: "flight", date: "2026-08-22", off_blocks: "08:55", from: "LIRQ", to: "EHAM", signature: "signed" }
    ];
    const fake = join(dir, "fake-jetlog.mjs");
    await writeFile(
      fake,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "entries") process.stdout.write(${JSON.stringify(JSON.stringify(entries))});
else if (a[0] === "whoami") process.stdout.write('{"token":{"scopes":["read","write","signatures"]}}');
else { console.error("unexpected " + a.join(" ")); process.exitCode = 2; }
`
    );
    await chmod(fake, 0o755);
    const res = run(["--data", data, "--out", join(dir, "out"), "--attach", "--dry-run"], { JETLOG_BIN: fake });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("1 to attach, 1 already signed, 0 no entry found, 0 ambiguous, 0 other skipped.");
    expect(res.stdout).toContain("Dry run: nothing was changed.");
  });

  it("still reads the App Store database", async () => {
    const data = join(dir, "Documents");
    await mkdir(join(data, "images"), { recursive: true });
    sql(
      join(data, "mccPilotLog.sqlite"),
      `CREATE TABLE ZMCCIMAGEPIC (ZIMGCODE, ZFILENAME, ZFILEEXT, ZLINKCODE, ZRECORDMODIFIED);
       CREATE TABLE ZMCCFLIGHT (Z_PK, ZFLIGHTCODE, ZDATEUTC, ZDATELOCAL, ZDATEBASE, ZFLIGHTNUMBER, ZDEPTIMEUTC,
         ZDEPARTUREAIRFIELD, ZARRIVALAIRFIELD, ZAIRCRAFT);
       CREATE TABLE ZMCCAIRFIELD (Z_PK, ZAFICAO, ZAFIATA);
       CREATE TABLE ZMCCAIRCRAFT (Z_PK, ZREFERENCE, ZDEVICECODE);
       INSERT INTO ZMCCAIRFIELD VALUES (1, 'EHLE', 'LEY');
       INSERT INTO ZMCCAIRCRAFT VALUES (1, 'SIM-1', 2);
       INSERT INTO ZMCCFLIGHT VALUES (1, 'F9', '2025-03-14', '2025-03-14', '2025-03-14', '', 600, 1, 1, 1);
       INSERT INTO ZMCCIMAGEPIC VALUES ('I9', 'IMG-SIM', 'png', 'F9', 5);`
    );
    await writeFile(join(data, "images", "IMG-SIM.png"), "sim");
    const res = run(["--data", data, "--out", join(dir, "out")]);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("(App Store PILOTLOG)");
    const [sig] = JSON.parse(await readFile(join(dir, "out", "signatures.json"), "utf8"));
    expect(sig).toMatchObject({ date: "2025-03-14", from: "EHLE", to: "EHLE", off_blocks: "10:00", simulator: true });
  });

  it("says where it looked when there is no PILOTLOG database", async () => {
    const res = run(["--data", join(dir, "nothing")]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("PILOTLOG data not found in");
    expect(res.stderr).toContain("mccPilotLog.sqlite or pilotlog.db");
  });
});

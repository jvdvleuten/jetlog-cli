# PILOTLOG signatures

Copies the flight signatures out of CL PILOTLOG (mccPILOTLOG) on your Mac and
attaches them to the matching entries in your Jetlog logbook.

PILOTLOG's CSV export has no signatures. The iPhone and iPad app also runs on
Apple silicon Macs, and there it keeps its data in a readable folder, signature
images included. This script reads that folder and never changes it.

## What you need

- An Apple silicon Mac with CL PILOTLOG installed from the App Store, opened
  once so it has synced your logbook.
- Node 20 or newer. The script has no dependencies and uses the `sqlite3` tool
  that ships with macOS.
- For the attach step: `npm i -g jetlog-cli` (a version that has
  `jetlog signatures attach-many`) and a login with write access
  (`jetlog login --scope write`). In the app, "Make changes to your logbook"
  has to be switched on before you pick the number; it is off by default.
- Your flights already in Jetlog, for example with
  `jetlog import <export.csv> --from pilotlog`.

## Step 1: copy the signatures

```sh
node examples/pilotlog-signatures/pilotlog-signatures.mjs
```

This needs no Jetlog login. It writes one PNG per signed flight and a
`signatures.json` that lists them, in `./pilotlog-signatures` (change it with
`--out`):

```
2025-03-14  10:00  EHLE-EHLE  KL123  PH-ABC  2025-03-14_EHLE-EHLE_KL123_1A2B3C4D.png
2025-03-20  08:15  EHAM-EGLL  KL1023  PH-XYZ  2025-03-20_EHAM-EGLL_KL1023_5E6F7A8B.png
Copied 2 signatures to /Users/you/pilotlog-signatures
Add --attach to put them on the matching Jetlog entries.
```

You can run it again at any time, existing files are overwritten. If you keep
the PILOTLOG data somewhere else, pass the folder with `--data`.

## Step 2: attach them to your entries

Look first, nothing is changed:

```sh
node examples/pilotlog-signatures/pilotlog-signatures.mjs --attach --dry-run
```

Then attach (it shows the plan and asks before it does anything):

```sh
node examples/pilotlog-signatures/pilotlog-signatures.mjs --attach
```

The script writes `attach-list.json` next to `signatures.json` and hands it to
`jetlog signatures attach-many`. Use `--yes` to skip the question and
`--profile <name>` for a login profile other than the default.

## How matching works

A signature goes on a Jetlog entry when the entry is not deleted, has the same
type (a simulator session matches a simulator entry), flies the same route and
starts at about the same time. The route compares airport codes, ICAO or IATA.
The start times may differ by up to 30 minutes. When either side has no time,
the date has to match instead.

If several entries still fit, the script prefers the one with the exact same
start minute, then the same registration, then the same flight number. If that
still leaves more than one, the signature is not attached.

These are left alone and listed in the plan:

- entries that are already signed
- bulk entries
- signatures without a matching entry, or with several equally good ones
- two signatures that match the same entry

An entry with a waived signature does get the signature, and the plan says so.
Anything left over can be attached by hand with
`jetlog signatures attach <entry-id> <file>`.

## Limits

- One run is one write: all signatures go in together, so it is one line in
  `jetlog batches list` and one notification to your phone, and the whole run
  is recorded in your account's audit log.
- Jetlog allows 200 signature changes per hour, so one run attaches at most
  200. With more, the first 200 are attached and the rest are left. Run the
  same command again an hour later: entries that are already signed are
  skipped, so it continues where it stopped. If the attach fails, nothing is
  lost and the same rerun works too.
- To undo one: `jetlog signatures remove <entry-id>`.

## Notes

- The first time, macOS asks whether your terminal may access data from other
  apps. Answer Allow. If you denied it before, give the terminal Full Disk
  Access under System Settings > Privacy & Security.
- The PILOTLOG folder is only read. Nothing there is written, moved or deleted.
- Written against PILOTLOG 5.4.69. The data layout is not a public format and
  can change with an update.
- Matching of simulator sessions was tested with made-up data only. Look at
  those lines in the dry run before you attach.
- Not affiliated with Crew Lounge. The faint flight date behind the signature
  is part of the image PILOTLOG makes.

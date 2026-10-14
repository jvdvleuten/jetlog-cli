# jetlog-cli

A command-line tool for [Jetlog](https://jetlog.app), a pilot logbook app.
The binary is called `jetlog`.

- Convert logbook exports from other apps (LogTen, mccPILOTLOG, ForeFlight,
  SafeLog and more) to Jetlog's import format.
- Import them into your Jetlog account, with a preview first and an undo
  afterwards.
- Read your logbook back: entries, people, aircraft, full export.
- Work with the files, photos and signatures in your logbook.
- Compute flight-time totals locally (PIC, IFR, EASA columns). Night time and
  distance-based figures need your airport catalog, so they need a login.
- Let a coding agent such as Claude Code or Codex work with your logbook
  through this CLI (`jetlog skill install`), with edits you confirm. A local
  MCP server is available for chat apps.

## Install

Needs Node.js 20 or newer.

```sh
npm i -g jetlog-cli
jetlog --help
```

Or run it without installing: `npx jetlog-cli <command>`.

From source instead (for development):

```sh
git clone https://github.com/jvdvleuten/jetlog-cli.git
cd jetlog-cli
npm install && npm run build && npm link
```

## Quick start

These work without an account. Night time and distance-based figures are
not computed without a login, because the package ships no airport data.
[examples/flights.csv](https://github.com/jvdvleuten/jetlog-cli/blob/main/examples/flights.csv) is a small sample file; download it from GitHub to follow along.

```sh
jetlog convert examples/flights.csv --from csv --self-role PIC -o payload.json
jetlog validate payload.json
jetlog totals examples/flights.csv --from csv --self-role PIC
jetlog link payload.json    # a jetlog.app link that opens an import preview in the app
```

To import a file into your own account:

```sh
jetlog login --scope write                                # scan the QR code with your iPhone
jetlog import logten-export.txt --from logten --dry-run   # preview, writes nothing
jetlog import logten-export.txt --from logten             # preview, confirm, then write
jetlog batches list                                       # every import, each one can be undone
```

When the app shows the login request, switch on "Make changes to your logbook"
before you pick the number. It is off by default, and without it the login can
only read. The CLI says so when that happens.

## Use it with an AI assistant

Quick start for coding agents (Claude Code, Codex):

```sh
npm i -g jetlog-cli
jetlog login --scope write
jetlog skill install
```

Then just ask your agent, for example "how many hours did I fly in March?" or
"fix the registration on yesterday's flight". The skill tells the agent to run
`jetlog guide`. It can read, search, export and import (previewing first) and
make targeted edits. An edit is only written after you confirm the preview in
the chat, and the Jetlog app lists it under Settings > Connected Apps & CLI >
Logbook Changes, where you can undo it.

Chat apps that cannot run shell commands, such as Claude Desktop, can use
`jetlog mcp`, a local [MCP](https://modelcontextprotocol.io) server. It is not
needed for coding agents or for edits.

```sh
claude mcp add jetlog -- npx -y jetlog-cli mcp
```

[docs/AI.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/AI.md) has the details, the MCP tool list and how the
confirm step works.

## Commands

| Command | What it does | Login |
| --- | --- | --- |
| `jetlog convert <file>` | Convert a logbook export to Jetlog JSON | no |
| `jetlog validate <file>` | Check a payload against the schema | no |
| `jetlog schema` | Print the payload JSON Schema | no |
| `jetlog link <file>` | Build import links for the Jetlog app | no |
| `jetlog times <file>` | Flight times per entry | no |
| `jetlog totals [file]` | Flight-time totals for a file, or for your account when no file is given | only without a file |
| `jetlog ai convert <file>` | Convert messy text with an LLM, using your own API key | no |
| `jetlog login`, `logout`, `whoami` | Sign in with the Jetlog app, sign out, show the active login | |
| `jetlog entries list`, `people`, `aircraft` | Read your logbook | read |
| `jetlog export` | Download your whole logbook as JSON or CSV | read |
| `jetlog attachments list`, `get` | List and download the files on an entry | read, files |
| `jetlog photos get` | Download a person's photo | read, files |
| `jetlog signatures show` | Show whether an entry is signed or waived | read |
| `jetlog signatures get` | Download the signature image of a signed entry | read, signatures |
| `jetlog attachments add`, `remove` | Add files to an entry, remove one | write, files |
| `jetlog photos set` | Set a person's photo | write, files |
| `jetlog signatures attach`, `attach-many`, `remove`, `waive`, `unwaive`, `request`, `revoke` | Add, replace or remove a signature, waive it, create or revoke a signing link | write, signatures |
| `jetlog import <file>` | Import a file into your account | write |
| `jetlog batches list`, `batches remove <id>` | List and undo imports | write |
| `jetlog changes propose [file]`, `changes schema`, `changes show <id>`, `changes apply <id>` | Propose a targeted edit and see the preview, print the payload schema, inspect or apply a proposal | write |
| `jetlog guide` | Print the guide for coding agents | no |
| `jetlog skill install`, `skill uninstall` | Install or remove the agent skill for Claude Code and Codex | no |
| `jetlog push <file>` | Deprecated. Send a payload to the partner API with the key pair | partner keys |
| `jetlog mcp` | Run the MCP server | optional |

Every command has `--help`. [docs/COMMANDS.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/COMMANDS.md) is the full
reference.

## Supported formats

Pass one of these to `--from`, or use `--from auto` to detect it from the file.

| `--from` | Source |
| --- | --- |
| `logten` | LogTen Pro tab-separated export |
| `pilotlog` | mccPILOTLOG / CrewLounge PILOTLOG CSV or zipped backup |
| `flylog` | Flylog CSV |
| `safelog` | SafeLog CSV |
| `skylife` | Skylife CSV |
| `rblogbook` | RB Logbook (RosterBuster) flights, aircraft and people CSVs |
| `flightlogger` | FlightLogger CSV |
| `chrono` | KLM "Chronologisch overzicht vlieguren" PDF |
| `monthly-overview` | KLM Cityhopper "Monthly Overview" PDF |
| `excel`, `jetlog-csv` | Jetlog's own Excel and CSV exports |
| `deeplink-json`, `jetlog` | A Jetlog import payload |
| `foreflight` | ForeFlight CSV (best effort, convert only) |
| `csv` | Any CSV with recognisable headers (convert only) |

Details per format are in [docs/COMMANDS.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/COMMANDS.md#jetlog-convert).

## What writes to your logbook

Most commands only read files or produce output. These can change your
account:

- `jetlog import` writes after showing a preview and asking you to confirm.
  `--dry-run` never writes. Every import is a batch that
  `jetlog batches remove <id>` undoes.
- `jetlog attachments add`, `attachments remove`, `photos set` and the
  `signatures` commands that change something (`attach`, `attach-many`,
  `remove`, `waive`, `unwaive`, `request`, `revoke`) show what they will do
  and ask you to confirm. With the `signatures` permission a login can add, replace and
  remove the signature on an entry. Replace and remove are recorded in your
  account's audit log, and you get a push notification.
- `jetlog changes apply` and the MCP tool `apply_changes` write a change that
  was proposed and previewed first (`jetlog changes propose`). `--yes` skips
  the question, and an agent passes it only after you confirmed the preview in
  the chat. Files, photos and signatures go through the same proposal step in
  the MCP server.
- `jetlog push` sends a payload to the partner API straight away. It is
  deprecated and prints a warning on stderr, because the key pair it uses is
  being replaced by token authentication (see the
  [migration guide](https://github.com/jvdvleuten/JetlogAPI/blob/main/MIGRATION.md)).

A link from `jetlog link` writes nothing by itself. The app shows an import
preview that you confirm there.

Your login is a personal access token stored in
`~/.config/jetlog/credentials.json` (mode 0600). It is read-only unless you
ask for `--scope write`. Besides `read` and `write` a token can carry the
scopes `files` and `signatures`. `jetlog login` asks for `read files signatures`, and
`jetlog login --scope write` asks for `read write files signatures`. A login
made with an older version of the tool lacks the last two, so log in again to
use the file, photo and signature commands. Revoke a token in the Jetlog app
under Settings > Connected Apps.

## Examples

- [examples/flights.csv](https://github.com/jvdvleuten/jetlog-cli/blob/main/examples/flights.csv): a small CSV to try
  `jetlog convert` with
- [examples/payload.json](https://github.com/jvdvleuten/jetlog-cli/blob/main/examples/payload.json): a Jetlog import payload
- [examples/pilotlog-signatures/](https://github.com/jvdvleuten/jetlog-cli/blob/main/examples/pilotlog-signatures/): copy the
  signatures from CL PILOTLOG on a Mac and attach them to your entries

## Documentation

- [docs/COMMANDS.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/COMMANDS.md): every command and option
- [docs/AI.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/AI.md): MCP setup, tools, and a guide for AI assistants
- [docs/IMPORTERS.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/IMPORTERS.md): how the format importers work and
  how to add one
- [docs/TIMES.md](https://github.com/jvdvleuten/jetlog-cli/blob/main/docs/TIMES.md): how flight times are computed, and known
  limitations
- [JetlogAPI](https://github.com/jvdvleuten/JetlogAPI): the import payload
  format

## Development

```sh
npm install
npm run build   # esbuild bundle to dist/
npm test        # vitest
npm run dev -- convert examples/flights.csv --from csv   # run from source
```

[AGENTS.md](AGENTS.md) describes the repo layout and conventions, for people
and for coding agents.

## License

MIT

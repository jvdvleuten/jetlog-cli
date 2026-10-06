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
- Run an MCP server so an AI assistant such as Claude can read your logbook
  and propose changes that you confirm.

## Install

Needs Node.js 20 or newer.

```sh
npm i -g jetlog-cli
jetlog --help
```

Or run it without installing: `npx jetlog-cli <command>`.

## Quick start

These work without an account. Night time and distance-based figures are
not computed without a login, because the package ships no airport data.
[examples/flights.csv](examples/flights.csv) is a small sample file.

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

## Use it with an AI assistant

`jetlog mcp` runs a local [MCP](https://modelcontextprotocol.io) server. The
assistant can then convert files, search your logbook, compute totals and
propose edits. An edit is only written after you confirm it in the chat.

Claude Code:

```sh
claude mcp add jetlog -- npx -y jetlog-cli mcp
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jetlog": { "command": "npx", "args": ["-y", "jetlog-cli", "mcp"] }
  }
}
```

Run `jetlog login --scope write` once in a terminal so the server can reach
your logbook. [docs/AI.md](docs/AI.md) has the full tool list, how the
confirm step works, and a short guide written for the assistant itself.

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
| `jetlog attachments add`, `remove` | Add files to an entry, remove one | write, files |
| `jetlog photos set` | Set a person's photo | write, files |
| `jetlog signatures attach`, `waive`, `unwaive`, `request`, `revoke` | Add or waive a signature, create or revoke a signing link | write, signatures |
| `jetlog import <file>` | Import a file into your account | write |
| `jetlog batches list`, `batches remove <id>` | List and undo imports | write |
| `jetlog changes show <id>`, `changes apply <id>` | Inspect or apply a change an assistant proposed | write |
| `jetlog push <file>` | Send a payload to the partner API | partner keys |
| `jetlog mcp` | Run the MCP server | optional |

Every command has `--help`. [docs/COMMANDS.md](docs/COMMANDS.md) is the full
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

Details per format are in [docs/COMMANDS.md](docs/COMMANDS.md#jetlog-convert).

## What writes to your logbook

Most commands only read files or produce output. These can change your
account:

- `jetlog import` writes after showing a preview and asking you to confirm.
  `--dry-run` never writes. Every import is a batch that
  `jetlog batches remove <id>` undoes.
- `jetlog attachments add`, `attachments remove`, `photos set` and the
  `signatures` commands that change something (`attach`, `waive`, `unwaive`,
  `request`, `revoke`) show what they will do and ask you to confirm. A token
  can add a signature but never replace or remove one.
- `jetlog changes apply` and the MCP tool `apply_changes` write a change that
  was proposed and previewed first. Files, photos and signatures go through
  the same proposal step in the MCP server.
- `jetlog push` sends a payload to the partner API straight away.

A link from `jetlog link` writes nothing by itself. The app shows an import
preview that you confirm there.

Your login is a personal access token stored in
`~/.config/jetlog/credentials.json` (mode 0600). It is read-only unless you
ask for `--scope write`. Besides `read` and `write` a token can carry the
scopes `files` and `signatures`. `jetlog login` asks for `read files`, and
`jetlog login --scope write` asks for `read write files signatures`. A login
made with an older version of the tool lacks the last two, so log in again to
use the file, photo and signature commands. Revoke a token in the Jetlog app
under Settings > Connected Apps.

## Documentation

- [docs/COMMANDS.md](docs/COMMANDS.md): every command and option
- [docs/AI.md](docs/AI.md): MCP setup, tools, and a guide for AI assistants
- [docs/IMPORTERS.md](docs/IMPORTERS.md): how the format importers work and
  how to add one
- [docs/TIMES.md](docs/TIMES.md): how flight times are computed, and known
  limitations
- [JetlogAPI](https://github.com/jvdvleuten/JetlogAPI): the import payload
  format

## Development

```sh
npm install
npm run build   # tsc to dist/
npm test        # vitest
npm run dev -- convert examples/flights.csv --from csv   # run from source
```

[AGENTS.md](AGENTS.md) describes the repo layout and conventions, for people
and for coding agents.

## License

MIT

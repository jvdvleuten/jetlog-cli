# Using jetlog with an AI assistant

## Coding agents: the shell CLI and the skill

For Claude Code, Codex and other coding agents, the recommended way is the
`jetlog` command line plus the Jetlog skill. The agent runs `jetlog` commands
in your shell. It can read your logbook, search, export, import files and make
targeted edits to entries, people, aircraft and places. No MCP server is needed.

```sh
npm i -g jetlog-cli
jetlog login --scope write     # scan the QR code with your iPhone
jetlog skill install           # Claude Code and Codex, in your home folder
```

Then ask your agent, for example "how many night hours did I fly last year?"
or "fix the registration on yesterday's flight".

When the Jetlog app shows the login request, switch on "Make changes to your
logbook" before you pick the number. It is off by default, and without it the
login can only read. `jetlog login` without `--scope write` is enough if the
agent should only read.

What the skill does: it tells the agent to run `jetlog whoami` and then
`jetlog guide`. `jetlog guide` prints the guide for the installed version, the
single source for what an agent needs to know: the read commands, how to
search, how to import (always `--dry-run` first), how to make targeted edits,
which commands write, and when to stop and ask. The same text is in
[AGENT_GUIDE.md](AGENT_GUIDE.md).

`jetlog skill install` writes `SKILL.md` to:

| Agent | Your home folder | With `--project` (this folder) |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/jetlog/` | `.claude/skills/jetlog/` |
| Codex | `~/.agents/skills/jetlog/` | `.agents/skills/jetlog/` |

Use `--claude` or `--codex` to install for one of them. Running it again
replaces an older Jetlog skill. `jetlog skill uninstall` removes it.

### How an edit is confirmed on the command line

1. You ask for a change, for example "fix the registration on yesterday's
   flight".
2. The agent looks up the ids with `jetlog entries list`, `jetlog people`,
   `jetlog aircraft` and `jetlog places`, then runs `jetlog changes propose`. Nothing is written.
   It prints a preview with the before and after of every changed field, and a
   change id. `jetlog changes schema` prints the JSON Schema of the payload.
3. The agent shows you that preview. You say yes, no, or ask for something
   different.
4. Only after a clear yes it runs `jetlog changes apply <id> --yes`. Agents
   pass `--yes` only after you confirmed that exact preview in the chat. If you
   run the command yourself, leave `--yes` off and it asks you.
5. The Jetlog app sends you a notification. Under Settings > Connected Apps &
   CLI > Logbook Changes you can see what changed and undo it.

A proposal expires after 24 hours. Only the login that proposed it can apply
it. If the data changed in the meantime, apply writes nothing and prints a
fresh preview to confirm again. Importing a file works the same way: the agent
runs `jetlog import --dry-run` first and shows you the result.

## Chat apps: the MCP server

`jetlog mcp` runs a local MCP server for chat apps such as Claude Desktop that
cannot run shell commands. Coding agents do not need it, and editing does not
require it. Clients that only support remote MCP servers, such as ChatGPT,
cannot use this local server.

## Connect the MCP server

Claude Code:

```sh
claude mcp add jetlog -- npx -y jetlog-cli@latest mcp
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jetlog": { "command": "npx", "args": ["-y", "jetlog-cli@latest", "mcp"] }
  }
}
```

Any other client that supports local (stdio) MCP servers works the same way:
the command is `npx -y jetlog-cli@latest mcp`, or `jetlog mcp` when the
package is installed globally.

With `@latest`, npx checks for a newer version each time the client starts the
server, so restarting the client updates it. A global install updates with
`npm i -g jetlog-cli@latest`. When a newer version is out, the server tells the
assistant, which passes it on to you.

## Log in

The conversion tools work without an account. To let the assistant read your
logbook, log in once in a terminal:

```sh
jetlog login                  # read only, plus downloading files
jetlog login --scope write    # also allow edits that you confirm, plus files and signatures
```

For `--scope write`, switch on "Make changes to your logbook" in the Jetlog app
before you pick the number. It is off by default.

A login made with an older version of the tool lacks the `files` and
`signatures` scopes, so log in again to use the file tools below. Then restart
or reconnect the MCP server. If you logged in with
`--profile <name>`, set `JETLOG_PROFILE=<name>` in the server's environment.

The assistant never sees your token. Without a login the logbook tools return
a message that tells the assistant to ask you to log in.

## Tools

Work on files, no login needed:

| Tool | What it does |
| --- | --- |
| `get_import_schema` | The JSON Schema of the import payload |
| `validate_payload` | Validate a payload, with errors per row |
| `convert_file` | Convert a logbook file on disk to a payload |
| `compute_totals` | Flight-time totals for a file, or for your account when no file is given |
| `make_import_links` | Turn a payload into import links for the Jetlog app |
| `import_preview` | Show what importing a file would do, plus import links. Never writes |

Read your logbook, needs a login:

| Tool | What it does |
| --- | --- |
| `whoami` | The logged-in account and whether it can write |
| `search_entries` | Search entries by date, aircraft, airport, flight number or crew |
| `list_people` | People in your logbook |
| `list_aircraft` | Aircraft in your logbook |
| `list_places` | Places in your logbook (airports and your own places), searchable by code or name, paged |

Edit your logbook, needs a login with `--scope write`:

| Tool | What it does |
| --- | --- |
| `propose_changes` | Propose creating, updating or deleting entries, people, aircraft, simulator sessions or places, and adding files, photos, signatures and signing links. Writes nothing and returns a preview |
| `apply_changes` | Write a proposed change, after you confirmed it. A signing link that the change created is returned in `links` |
| `get_change_status` | Whether a proposal is pending, applied, rejected, stale or expired |

Files, photos and signatures, needs a login with the `files` scope. A login
made before that scope existed gets a message to run `jetlog login` again.
`upload_file` and `create_upload_link` also need write access, and
`upload_file` with kind `signature` needs the `signatures` scope instead of
`files`, and so does downloading a signature image:

| Tool | What it does |
| --- | --- |
| `upload_file` | Upload one file from this computer (an absolute path) to your account and return its `attachment_id`. Kinds: `entry_file`, `person_photo`, `signature`. Nothing in the logbook changes until a confirmed change references the file |
| `list_entry_attachments` | The signature state (none, waived, signed), the id of the signature image and the files of one entry |
| `download_attachment` | Save an entry file, person photo or signature image into the download folder and return the path. A signature image needs the `signatures` scope |
| `create_upload_link` | A short-lived page for adding files to one entry or a photo to one person from another device |
| `get_upload_link_status` | What has landed through an upload link |

`push_payload` (write a payload through the partner API) is deprecated and only
exists when `JETLOG_USER_KEY` and `JETLOG_PARTNER_KEY` are set. It writes
immediately, with the partner key pair, which is being replaced by token
authentication (see the
[migration guide](https://github.com/jvdvleuten/JetlogAPI/blob/main/MIGRATION.md)).

The resource `jetlog://format-rules` holds the payload rules in plain text.

## How an edit is confirmed over MCP

1. You ask for a change, for example "fix the registration on yesterday's
   flight" or "add the sim session I did on Monday".
2. The assistant looks up what it needs and calls `propose_changes`. Nothing
   is written. It gets back a preview with the before and after values of
   every operation, and shows you that preview. Deletions are listed
   separately.
3. You say yes, no, or ask for something different. Only after a clear yes
   does the assistant call `apply_changes`.
4. The Jetlog app sends you a notification. Under Settings > Connected Apps &
   CLI > Logbook Changes you can see what changed and undo it.

A proposal expires after 24 hours. Only the login that proposed it can apply
it. If the data changed in the meantime, `apply_changes` writes nothing and
returns a fresh preview to confirm again.

A new entry gets you as crew with your default role. The assistant can set a
different role, or leave you off when you were not on that flight.

Importing a whole file is never done by the assistant itself. `import_preview`
shows what would happen and gives you links to confirm in the app, or you run
`jetlog import` in a terminal.

Files, photos and signatures follow the same rule. Attaching a file to an
entry, setting a person's photo, attaching, replacing, removing or waiving a signature and creating
a signing link are all operations of `propose_changes`: you see the preview in
the chat and nothing happens until you confirm and the assistant calls
`apply_changes`. Two tools act before that, and neither changes your logbook:
`upload_file` stores the bytes of one file in your account, where they stay
unused until a confirmed change references them, and `create_upload_link`
makes a page you can open to add a file from another device (you get a push
notification, the link expires after 30 minutes, and every file that lands
through it shows up as a change you can undo in the app). Signature changes
may be switched off for AI changes. With the `signatures` scope the assistant
can download a signature image, replace it with another one and remove it.
Each of those is recorded in your audit log and you get a push notification. A waive credits the hours as signed in
your own totals and is not accepted by an authority, the assistant is told to
say so.

### Local file access

Two of the local tools touch files on your computer, so know what they can do:

- `upload_file` reads the file at the absolute path the model gives it and
  stores it in your own Jetlog account. It only reads regular files below the
  size limit of the kind, refuses a symbolic link, takes the type from the
  content, and refuses anything under `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config` and the Jetlog config folder. It can still read any other file
  you can read, which is inherent to an upload tool. That is why the model is
  told to upload only a file you asked for, and why the file is not used for
  anything until you confirm the change that references it.
- `download_attachment` writes only inside one folder: `~/Downloads/jetlog`,
  or the folder in the `JETLOG_DOWNLOAD_DIR` environment variable. The model
  never picks a path, at most a file name, which is reduced to a plain name
  with an extension that matches the file's type. It never overwrites an
  existing file. A signature image is saved the same way when the login has
  the `signatures` scope.

## Guide for the assistant

The guide for the model is [AGENT_GUIDE.md](AGENT_GUIDE.md). It is bundled into
the CLI, so `jetlog guide` prints the version that matches the installed tool.
An assistant that connects over MCP should read the same text, with
`propose_changes` and `apply_changes` standing in for `jetlog changes propose`
and `jetlog changes apply`. Two rules are specific to MCP:

- Read `jetlog://format-rules` or call `get_import_schema` before you build a
  payload, and run `validate_payload` on it before you hand it over.
- To get a file into the logbook, call `import_preview`, show the counts and
  warnings, and give the pilot the import links or the `jetlog import` command
  to run. An MCP assistant does not import files itself.

---
name: jetlog
description: Work with a pilot's logbook in Jetlog through the jetlog CLI. Use when the user asks about their pilot logbook, flights, flight hours, totals, crew, aircraft or airports in their logbook, importing a logbook file, or correcting a Jetlog entry.
---

# Jetlog

Use the `jetlog` command line to read and edit the pilot's logbook.

1. Run `jetlog whoami` to check the login. If it is missing or read-only and you need to write, ask the pilot to run `jetlog login --scope write` themselves.
2. Run `jetlog guide` and follow it. It covers reading, searching, importing, targeted edits and what needs the pilot's explicit yes.

Rules that always apply: never guess crew, roles or times, times are UTC, preview before you write, and run `jetlog changes apply --yes` or a real import only after the pilot confirmed that exact preview in the chat.

If `jetlog` is not installed, tell the pilot to run `npm i -g jetlog-cli`.

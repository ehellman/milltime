# @erikhellman/milltime

Unofficial TypeScript client, CLI and MCP server for Milltime: time reporting, expenses and allowances.

Requires Node ≥ 22.

## Quick start with an AI assistant

```sh
npx -y @erikhellman/milltime@latest auth login
claude mcp add milltime -- npx -y @erikhellman/milltime@latest mcp
```

`npx` checks for a newer version each time the server starts, so updates arrive on the next restart of the assistant.

## CLI

```sh
npm install -g @erikhellman/milltime     # or run any command below as: npx -y @erikhellman/milltime@latest <command>
```

Log in once. The password is never stored; only the session is, in the system keychain (`secret-tool` on Linux, Keychain on macOS) or, without one, in `~/.config/milltime/session.json` (mode 0600). Sessions expire after about 8 idle hours. The address (e.g. `https://yourcompany.millnet.cloud`) and instance are remembered; when an address serves several instances, `auth login` lists them and asks which one.

```sh
milltime auth login                      # prompts for your Milltime address, username and password
milltime auth login --username me        # skips the username prompt
milltime auth status [--check]           # --check asks the server whether the session is still valid
milltime auth logout
```

Read commands:

```sh
milltime time week [week]                # reported time per day, totals and flex balance
milltime time projects [--all]           # projects and activities you can report on (--all adds absence)
milltime lock status [week]              # whether a week is locked, or what blocks locking it
milltime expenses list [YYYY-MM]         # a month's expenses with a home-currency total
milltime expenses types | currencies | projects
milltime allowances list [YYYY-MM]       # trips overlapping a month, day by day, with Milltime's compensation
milltime allowances countries | projects
```

`week` is a date (`2026-10-14` selects its Monday–Sunday week), `today` (default), `prev`, `next`, `2026-W42` or `w42`.

Write commands. Each takes `--dry-run`, which does the same checks and prints the request instead of sending it:

```sh
milltime time add <date> --activity <id> --hours <h> [--note <text>]   # id from `time projects --all`
milltime time edit <date> <row-id> [--hours <h>] [--note <text>]       # row id from `time week`
milltime time delete <date> <row-id>
milltime expenses add <date> --type <id> --project <id> --amount <n> [--vat <n>] [--currency <code>] [--note <text>] [--receipt <file>]
milltime expenses edit <date> <id> [--new-date <date>] [--project <id>] [--amount <n>] [--vat <n>] [--note <text>] [--receipt <file>] [--remove-receipts]
milltime expenses delete <date> <id>                                   # id from `expenses list`
milltime expenses receipt <id> --out <file>
milltime allowances add --from <date> --to <date> --departure before-noon|after-noon --return before-7pm|after-7pm \
  --destination <text> --purpose <text> --project <id> --breakfast <x> --lunch <x> --dinner <x> \
  --private-accommodation yes|no [--country <code>] [--day <date>:lunch=employer,accommodation=yes]…
milltime allowances edit <date> <id> [any add option]                  # date: any day of the trip; id from `allowances list`
milltime allowances delete <date> <id>
milltime lock week <week> --yes                                        # cannot be undone; without --yes, only shows the plan
```

Allowances: every option that changes the amount is required, and a missing one is listed rather than defaulted (only `--country` defaults to domestic). Breakfast is `paid-myself`, `hotel`, `ticket` or `employer`; lunch and dinner are `paid-myself`, `deduction`, `ticket` or `employer`. Private accommodation counts on the day after the night, so never on the departure day. Milltime computes the compensation.

`date` is `YYYY-MM-DD`, `today` or `yesterday`. Locked days, rows and expenses are refused before anything is sent. Milltime itself refuses writes to a week until all earlier weeks are locked; its message is shown as is.

Every command takes `--json` for machine-readable output and `--help` for usage.

Exit codes: `0` success, `1` Milltime or network error, `2` usage error, `3` not logged in (run `milltime auth login`).

Environment: `MILLTIME_CONFIG_DIR` stores settings and the session as files in that directory instead of the keychain.

## MCP server

`milltime mcp` serves the same features to an assistant over stdio. It uses the login saved by `milltime auth login` (and `MILLTIME_CONFIG_DIR`, if set), so log in with the CLI first; it never sees the password.

Claude Code:

```sh
claude mcp add milltime -- npx -y @erikhellman/milltime@latest mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "milltime": { "command": "npx", "args": ["-y", "@erikhellman/milltime@latest", "mcp"] } } }
```

Tools: `get_week`, `list_projects`, `report_time`, `update_time_row`, `delete_time_row`, `get_lock_status`, `lock_week`, `list_expenses`, `list_expense_types`, `list_currencies`, `list_expense_projects`, `get_expense_receipts`, `create_expense`, `update_expense`, `delete_expense`, `list_allowances`, `list_countries`, `list_allowance_projects`, `create_allowance`, `update_allowance`, `delete_allowance`.

`report_time` takes a list of rows, so a whole week is previewed and confirmed at once; if one row fails, it says which rows were already reported. `list_projects` gives each activity the `key` to report it with.

Every write takes two calls. Without `confirmToken` it sends nothing and returns what it would do (every day of a trip) and a token; the same call with that token sends it. The token signs the exact request, so if anything changed in between, the tool returns a new preview instead of writing. Tokens die with the server process.

`create_allowance` lists every missing field at once, with what to ask and the valid values, so the assistant asks instead of guessing; `list_allowances` gives earlier trips to use as templates. `lock_week` cannot be undone.

## Development

Runs the TypeScript sources directly on Node ≥ 23.6: `node src/bin.ts <command>`, and `node src/bin.ts mcp` for the server.

```sh
pnpm typecheck
pnpm build        # compiles to dist/, which is what the package ships
pnpm test         # unit tests against fixtures, no network
pnpm test:live    # read-only calls against the real instance; needs .env (see .env.example)
MILLTIME_LIVE_WRITES=1 pnpm test:live   # also creates, edits and deletes a time row, an expense and an allowance this week
```

Release: `npm version patch && npm publish` (`prepublishOnly` typechecks, tests and builds first), then `git push --follow-tags`.


## License

MIT with the Commons Clause: free to use, modify and share, but not to sell, including as a hosted or paid service. See [LICENSE](LICENSE).

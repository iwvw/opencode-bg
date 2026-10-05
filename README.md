# opencode-bg

A custom tool for [opencode](https://opencode.ai) that runs long-lived shell commands in the background, so they stop blocking the agent loop.

## The problem

opencode's built-in `bash` tool waits for the command to exit. Its schema is exactly `{ command, workdir?, timeout? }` — there is **no** background option — and it defaults to a 120-second timeout (max 600s). Any command that never exits on its own therefore hangs the whole turn until it times out:

- dev servers: `npm run dev`, `vite`, `next dev`, `webpack serve`
- long-running services: `opencode serve`, `python -m http.server`, `http-server`
- watchers: anything with `--watch` / `-w`, `tsc -w`, `nodemon`
- foreground containers: `docker compose up` (without `-d`)
- REPLs and anything that waits on stdin

## The fix

This repo adds two tools:

| Tool | Purpose |
| --- | --- |
| `bg_start` | Launch a command detached from opencode, return immediately with the PID and a log file path |
| `bg_stop` | Kill a previously started process (whole process tree on Windows, process group on POSIX) |

Output is redirected to a log file under the OS temp directory (`%TEMP%/opencode-bg` on Windows, `/tmp/opencode-bg` on POSIX), so you can tail it live.

## Install

### One-click (recommended)

Works on Windows, macOS, and Linux.

```bash
git clone https://github.com/iwvw/opencode-bg.git
cd opencode-bg
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux:

```bash
bash install.sh
```

The installer does two things:

1. Copies `tools/bg.js` into your opencode config's `tools/` directory (backs up any existing file, runs a syntax check).
2. Appends the "long-running commands" convention to `instructions.md`, so the agent knows when to use `bg_start` instead of `bash`. Skips if the section already exists.

It is idempotent and non-interactive. Extra flags:

- `-Force` / `--force`: overwrite an existing `bg.js` without a backup.
- `-SkipInstructions` / `--skip-instructions`: do not touch `instructions.md`.

Then **restart opencode** — the tool registry is cached per instance and only rescanned on start.

### Manual

1. Copy `tools/bg.js` to:
   - Windows: `%USERPROFILE%\.config\opencode\tools\bg.js`
   - macOS / Linux: `~/.config/opencode/tools/bg.js`
2. Append the contents of `instructions-snippet.md` to `instructions.md` in the same config directory.
3. Restart opencode.

### For an AI agent

Paste this prompt to an AI agent that has shell access (opencode, Claude Code, etc.):

```
Install the opencode bg tool from https://github.com/iwvw/opencode-bg so long-running
commands can run in the background.

Steps:
1. Clone the repo to a temp directory.
2. Run the installer for this OS:
   - Windows: powershell -ExecutionPolicy Bypass -File .\install.ps1
   - macOS/Linux: bash install.sh
   The installer copies tools/bg.js into the opencode config tools dir AND appends
   the long-running-commands convention to instructions.md.
3. Confirm tools/bg.js exists under the opencode config dir
   (%USERPROFILE%\.config\opencode\tools on Windows, ~/.config/opencode/tools elsewhere).
4. Confirm instructions.md contains the section "长时命令后台执行约定".
5. Tell the user to restart opencode for the tool to load.
Do not overwrite an existing bg.js without backing it up (the installer already does this).
```

## Usage

Once opencode is restarted, the agent can call:

```
bg_start(command="npx vite --port 5199", workdir="E:\\Code\\MyProject")
```

Returns:

```
Started in background.
PID: 11560
Log: C:\Users\...\Temp\opencode-bg\1791208941783-npx-vite-port-5199.log
Stop: call bg_stop with pid 11560.
```

Inspect the log with the Read tool or `Get-Content -LiteralPath "<log>" -Tail 50`. Stop with:

```
bg_stop(pid=11560)
```

## Requirements

- opencode (any recent version that scans `~/.config/opencode/tools/*.js`)
- Node.js (opencode bundles its own runtime; `node` is only used by the installer for the syntax check)
- Windows PowerShell 5.1+ or PowerShell 7+ (Windows); `bash` (POSIX)

## How it works

opencode scans `{tool,tools}/*.{js,ts}` in each config directory and registers every export that has `args` + `description` + `execute`. This file exports `start` and `stop`, so the tool names become `bg_start` and `bg_stop`.

Windows specifics (all discovered by testing, not assumption):

- `detached: true` makes `pwsh.exe` exit immediately, so the child never runs. Instead the launcher uses PowerShell's `Start-Process -PassThru`, which is the reliable way to spawn a process that outlives the parent.
- Passing the command through `-ArgumentList` mangles quotes (`Write-Output "tick $_"` becomes two lines). The command is written to a temp `.ps1` file and run with `-File` instead.
- With `detached`, inherited file descriptors are lost, so output redirection is done by PowerShell's `-RedirectStandardOutput/Error`.

## Notes

- `bg_stop` on an already-exited process reports `process not found`. That is expected — the process finished on its own.
- The tool registry is only scanned at opencode startup. Adding or editing a tool file requires a restart.
- A custom tool with the same name as a built-in replaces it. This tool deliberately uses the `bg` prefix to avoid collisions.

## License

MIT

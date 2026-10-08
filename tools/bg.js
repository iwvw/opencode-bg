import { tool } from "@opencode-ai/plugin"
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(tmpdir(), "opencode-bg")
const REGISTRY_FILE = join(LOG_DIR, "registry.json")
const REGISTRY_MAX = 100

function resolvePwsh() {
  const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  if (existsSync(pwsh7)) return pwsh7
  const legacy = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  if (existsSync(legacy)) return legacy
  return "pwsh.exe"
}

function slug(input) {
  return (
    input
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cmd"
  )
}

function readTail(path, maxChars) {
  const content = readLogText(path)
  return content.length > maxChars ? content.slice(content.length - maxChars) : content
}

function decodeLog(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le")
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8")
  }
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
  let zeros = 0
  for (let i = 1; i < probe.length; i += 2) {
    if (probe[i] === 0x00) zeros++
  }
  if (probe.length >= 4 && zeros > probe.length / 8) {
    return buffer.toString("utf16le")
  }
  return buffer.toString("utf8")
}

function readLogText(path) {
  try {
    return decodeLog(readFileSync(path))
  } catch {
    return ""
  }
}

function tailLines(text, count) {
  if (count <= 0) return []
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-count)
}

function formatLogBlock(path, tail, stream, offset) {
  if (!existsSync(path)) {
    return `[${stream}] (no log file yet)`
  }
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    // ignore
  }
  if (size === 0) {
    return `[${stream}] (empty)`
  }
  const lines = tailLines(readLogText(path), tail)
  const shown = offset > 0 ? lines.slice(0, Math.max(0, lines.length - offset)) : lines
  const skipped = offset > 0 ? lines.length - shown.length : 0
  const header = `[${stream}] (${lines.length} tail lines${skipped > 0 ? `, skipped last ${skipped}` : ""})`
  return `${header}\n${shown.join("\n")}`
}

function describeEntry(entry) {
  const alive = isAlive(entry.pid)
  const started = entry.startedAt ? new Date(entry.startedAt).toLocaleString() : "?"
  return `pid ${entry.pid} [${alive ? "running" : "exited"}] started ${started}  ${entry.command}`
}

function isAlive(pid) {
  if (!pid) return false
  try {
    if (process.platform === "win32") {
      return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).includes(String(pid))
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function readRegistry() {
  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function saveRegistry(entries) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(REGISTRY_FILE, JSON.stringify(entries.slice(-REGISTRY_MAX), null, 2), "utf8")
  } catch {
    // ignore
  }
}

function rememberEntry(entry) {
  const entries = readRegistry().filter(e => e.pid !== entry.pid)
  entries.push(entry)
  saveRegistry(entries)
}

function latestEntry() {
  const entries = readRegistry().filter(e => isAlive(e.pid))
  return entries.length ? entries[entries.length - 1] : null
}

function findEntry(pid) {
  const entries = readRegistry()
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].pid === pid) return entries[i]
  }
  return null
}

async function launch(command, cwd) {
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = Date.now()
  const base = `${stamp}-${slug(command)}`
  const outLog = join(LOG_DIR, `${base}.log`)
  const errLog = join(LOG_DIR, `${base}.err.log`)
  const pidFile = join(LOG_DIR, `${base}.pid`)

  let pid = 0
  let scriptFile = ""
  if (process.platform === "win32") {
    const started = await startWindows(command, cwd, outLog, errLog, pidFile)
    scriptFile = started.scriptFile
    if (started.code !== 0 && !existsSync(pidFile)) {
      return { pid: 0, outLog, errLog, scriptFile, failed: started.code }
    }
    pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || 0 : 0
  } else {
    pid = await startPosix(command, cwd, outLog)
  }

  await new Promise(resolve => setTimeout(resolve, 700))

  try {
    rmSync(pidFile, { force: true })
  } catch {
    // ignore
  }

  if (pid && isAlive(pid)) {
    rememberEntry({ pid, command, workdir: cwd, outLog, errLog, startedAt: stamp })
  }

  return { pid, outLog, errLog, scriptFile, failed: null }
}

/**
 * Windows: 外层 pwsh 用 Start-Process 拉起一个独立后台进程（-PassThru 拿 PID），
 * 输出重定向到日志文件，PID 落盘后外层立即退出。
 *
 * 为什么不用 Node 的 detached:true：实测 Windows 上 pwsh.exe 在 detached:true 时
 * 会立刻退出（cmd.exe 则正常），导致后台命令根本没跑起来。Start-Process 是 Windows
 * 上真正「独立于父进程存活」的启动方式。
 */
function startWindows(command, cwd, outLog, errLog, pidFile) {
  const shell = resolvePwsh()
  // 把用户命令写入独立脚本文件，再用 -File 执行：绕开 -ArgumentList 对引号/空格的
  // 拆词问题（实测 `Write-Output "tick $_"` 经 -Command 传参会退化成两行输出）。
  const scriptFile = join(LOG_DIR, `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  writeFileSync(scriptFile, command, "utf8")

  const inner =
    `$p = Start-Process -FilePath ${psQuote(shell)} ` +
    `-ArgumentList ${psQuote("-NoProfile")},${psQuote("-NonInteractive")},${psQuote("-ExecutionPolicy")},${psQuote("Bypass")},${psQuote("-File")},${psQuote(scriptFile)} ` +
    `-WorkingDirectory ${psQuote(cwd)} ` +
    `-RedirectStandardOutput ${psQuote(outLog)} -RedirectStandardError ${psQuote(errLog)} ` +
    `-WindowStyle Hidden -PassThru; Set-Content -LiteralPath ${psQuote(pidFile)} -Value $p.Id -Encoding ascii`
  const outer = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", inner], {
    stdio: "ignore",
    windowsHide: true,
  })
  return new Promise(resolve => {
    outer.on("close", code => resolve({ code, scriptFile }))
    outer.on("error", () => resolve({ code: -1, scriptFile }))
  })
}

/**
 * POSIX: 用 `setsid`/`nohup` 让进程脱离父进程，shell 内做重定向。
 */
function startPosix(command, cwd, outLog) {
  const wrapped = `nohup ${command} > ${JSON.stringify(outLog)} 2>&1 & echo $!`
  const child = spawn(process.env.SHELL || "/bin/sh", ["-c", wrapped], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  })
  return new Promise(resolve => {
    let out = ""
    child.stdout?.on("data", d => (out += d.toString()))
    child.on("close", () => resolve(Number(out.trim()) || child.pid || 0))
    child.on("error", () => resolve(0))
  })
}

export const start = tool({
  description:
    "Start a long-running or never-exiting shell command in the background and return immediately. Use this instead of the normal bash tool for dev servers, watchers, `serve`, REPLs, port listeners, `--watch`, `docker compose up`, and anything that does not exit on its own. The command runs detached from opencode; its output goes to a log file. Returns the PID and log path so you can inspect output or stop it later with bg_stop.",
  args: {
    command: tool.schema.string().describe("Shell command string to run in the background"),
    workdir: tool.schema
      .string()
      .optional()
      .describe("Working directory. Defaults to the active project directory."),
  },
  async execute(args, context) {
    const cwd = args.workdir || context.directory
    const { pid, outLog, errLog, scriptFile, failed } = await launch(args.command, cwd)

    if (failed !== null && !pid) {
      return `Failed to start background command (launcher exited with ${failed}).`
    }

    const outTail = readTail(outLog, 2000)
    const errTail = readTail(errLog, 1000)
    const alive = isAlive(pid)
    const scriptNote = scriptFile ? `Script: ${scriptFile}` : ""

    if (!alive) {
      return [
        `Command finished or failed immediately (no live process).`,
        `PID: ${pid}`,
        `Log: ${outLog}`,
        scriptNote,
        outTail ? `--- stdout ---\n${outTail}` : "",
        errTail ? `--- stderr ---\n${errTail}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    }

    return [
      `Started in background.`,
      `PID: ${pid}`,
      `Log: ${outLog}`,
      errTail ? `Stderr: ${errLog}` : "",
      scriptNote,
      `Inspect: call bg_logs with pid ${pid}, or Read the log file (${outLog}), or run \`Get-Content -LiteralPath "${outLog}" -Tail 50 -Wait\` for a live view.`,
      `Restart: call bg_restart with pid ${pid} (or omit pid for the latest process).`,
      `Stop: call bg_stop with pid ${pid}.`,
      outTail ? `--- output so far ---\n${outTail}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  },
})

export const restart = tool({
  description:
    "Restart a process previously started with bg_start: stops the old process tree (if still alive) and starts a fresh instance with the same command and working directory. Omit pid to restart the most recently started still-running background process. Returns the new PID and log path.",
  args: {
    pid: tool.schema
      .number()
      .optional()
      .describe("PID returned by bg_start. Omit to restart the latest running background process."),
  },
  async execute(args) {
    const entry = args.pid ? findEntry(args.pid) : latestEntry()

    if (!entry) {
      return args.pid
        ? `No recorded background process for pid ${args.pid}. It may have been started before restart tracking existed, or the registry was cleared.`
        : `No running background process found in the registry.`
    }

    const stopped = isAlive(entry.pid)
    if (stopped) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(entry.pid), "/F", "/T"], { stdio: "pipe" })
        } else {
          process.kill(-entry.pid, "SIGTERM")
        }
      } catch (error) {
        return `Failed to stop pid ${entry.pid} before restart: ${error instanceof Error ? error.message : String(error)}`
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    const { pid, outLog, errLog, failed } = await launch(entry.command, entry.workdir)

    if (failed !== null && !pid) {
      return `Stopped old pid ${entry.pid}, but failed to start new command (launcher exited with ${failed}).`
    }

    const outTail = readTail(outLog, 2000)
    const errTail = readTail(errLog, 1000)
    const alive = isAlive(pid)

    if (!alive) {
      return [
        `Restarted command but the new process finished or failed immediately.`,
        `Old PID: ${entry.pid}`,
        `New PID: ${pid}`,
        `Log: ${outLog}`,
        outTail ? `--- stdout ---\n${outTail}` : "",
        errTail ? `--- stderr ---\n${errTail}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    }

    return [
      `Restarted in background.`,
      `Old PID: ${entry.pid}${stopped ? " (stopped)" : " (already gone)"}`,
      `New PID: ${pid}`,
      `Log: ${outLog}`,
      `Command: ${entry.command}`,
      `Workdir: ${entry.workdir}`,
      errTail ? `Stderr: ${errLog}` : "",
      `Inspect: call bg_logs with pid ${pid}, or Read the log file (${outLog}), or run \`Get-Content -LiteralPath "${outLog}" -Tail 50 -Wait\` for a live view.`,
      `Stop: call bg_stop with pid ${pid}.`,
      outTail ? `--- output so far ---\n${outTail}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  },
})

export const logs = tool({
  description:
    "Read the captured stdout/stderr of a background process started with bg_start. Omit pid to read the latest registered process. Does not follow the file (no -Wait); it returns a snapshot. Use this instead of reading the raw log path when you want both streams or a clean tail.",
  args: {
    pid: tool.schema
      .number()
      .optional()
      .describe("PID returned by bg_start. Omit to read the latest registered process."),
    tail: tool.schema.number().optional().describe("Number of trailing lines to return (default 50)."),
    stream: tool.schema
      .enum(["stdout", "stderr", "both"])
      .optional()
      .describe("Which stream to read (default both)."),
    offset: tool.schema
      .number()
      .optional()
      .describe("Skip this many newer lines from the bottom, to page backwards through older output."),
  },
  async execute(args) {
    const entry = args.pid ? findEntry(args.pid) : latestEntry() || (readRegistry().slice(-1)[0] ?? null)

    if (!entry) {
      return args.pid
        ? `No recorded background process for pid ${args.pid}.`
        : `No background process found in the registry.`
    }

    const tail = args.tail && args.tail > 0 ? args.tail : 50
    const offset = args.offset && args.offset > 0 ? args.offset : 0
    const stream = args.stream || "both"
    const alive = isAlive(entry.pid)
    const started = entry.startedAt ? new Date(entry.startedAt).toLocaleString() : "?"

    const parts = [
      `Background process pid ${entry.pid} [${alive ? "running" : "exited"}]`,
      `Command: ${entry.command}`,
      `Workdir: ${entry.workdir}`,
      `Started: ${started}`,
    ]
    if (stream === "stdout" || stream === "both") {
      parts.push(formatLogBlock(entry.outLog, tail, "stdout", offset))
    }
    if (stream === "stderr" || stream === "both") {
      parts.push(formatLogBlock(entry.errLog, tail, "stderr", offset))
    }
    return parts.join("\n")
  },
})

export const list = tool({
  description:
    "List background processes started with bg_start (most recent last), with PID, running/exited status, start time, and command. Use it to find the pid to pass to bg_logs, bg_restart, or bg_stop.",
  args: {
    all: tool.schema
      .boolean()
      .optional()
      .describe("Include exited processes (default true). Set false to show only still-running ones."),
  },
  async execute(args) {
    const all = args.all ?? true
    const entries = readRegistry()
    const shown = all ? entries : entries.filter(e => isAlive(e.pid))

    if (!shown.length) {
      return all ? "No background processes recorded." : "No running background processes."
    }

    const lines = shown.map(describeEntry)
    return [`Background processes (${shown.length}):`, ...lines].join("\n")
  },
})

export const stop = tool({
  description:
    "Stop a process previously started with bg_start. On Windows it kills the whole process tree; on POSIX it kills the process group.",
  args: {
    pid: tool.schema.number().describe("PID returned by bg_start"),
    tree: tool.schema.boolean().optional().describe("Kill the whole process tree (default true)."),
  },
  async execute(args) {
    const pid = args.pid
    const tree = args.tree ?? true
    try {
      if (process.platform === "win32") {
        const flags = ["/PID", String(pid), "/F"]
        if (tree) flags.push("/T")
        execFileSync("taskkill", flags, { stdio: "pipe" })
      } else {
        process.kill(tree ? -pid : pid, "SIGTERM")
      }
      return `Stopped pid ${pid}.`
    } catch (error) {
      return `Failed to stop pid ${pid}: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

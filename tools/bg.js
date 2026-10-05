import { tool } from "@opencode-ai/plugin"
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(tmpdir(), "opencode-bg")

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
  try {
    const content = readFileSync(path, "utf8")
    return content.length > maxChars ? content.slice(content.length - maxChars) : content
  } catch {
    return ""
  }
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
    mkdirSync(LOG_DIR, { recursive: true })
    const cwd = args.workdir || context.directory
    const stamp = Date.now()
    const outLog = join(LOG_DIR, `${stamp}-${slug(args.command)}.log`)
    const errLog = join(LOG_DIR, `${stamp}-${slug(args.command)}.err.log`)
    const pidFile = join(LOG_DIR, `${stamp}-${slug(args.command)}.pid`)

    let pid = 0
    let scriptFile = ""
    if (process.platform === "win32") {
      const started = await startWindows(args.command, cwd, outLog, errLog, pidFile)
      scriptFile = started.scriptFile
      if (started.code !== 0 && !existsSync(pidFile)) {
        return `Failed to start background command (launcher exited with ${started.code}).`
      }
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || 0 : 0
    } else {
      pid = await startPosix(args.command, cwd, outLog)
    }

    await new Promise(resolve => setTimeout(resolve, 700))
    const outTail = readTail(outLog, 2000)
    const errTail = readTail(errLog, 1000)
    const alive = isAlive(pid)

    try {
      rmSync(pidFile, { force: true })
    } catch {
      // ignore
    }

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
      `Inspect: Read the log file (${outLog}), or run \`Get-Content -LiteralPath "${outLog}" -Tail 50 -Wait\` for a live view.`,
      `Stop: call bg_stop with pid ${pid}.`,
      outTail ? `--- output so far ---\n${outTail}` : "",
    ]
      .filter(Boolean)
      .join("\n")
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

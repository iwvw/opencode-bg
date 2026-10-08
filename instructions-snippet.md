
# 长时命令后台执行约定（禁止用 bash 跑阻塞命令）

opencode 的 bash 工具是**同步等待命令退出**的（内部 `detached:false`），默认 120 秒超时、最长 600 秒，且没有后台参数。凡是「不会自行退出」的命令，用 bash 工具跑就会把整个回合阻塞到超时。

**必须用 `bg_start` 而不是 bash 的场景：**

- dev server / 预览服务：`npm run dev`、`vite`、`next dev`、`webpack serve`
- 常驻服务：`opencode serve`、`python -m http.server`、`http-server`、`php -S`
- 监听类：带 `--watch` / `-w` 的命令、`tsc -w`、`nodemon`
- 前台容器：`docker compose up`（不带 `-d`）
- 交互式：REPL、`python` / `node` 无脚本进入、需要 stdin 的命令
- 任何会一直运行或等待输入、无法自行结束的命令

**用法：**

- `bg_start`：后台启动，立即返回 PID 与日志路径；`workdir` 指定工作目录。
- 查看输出：优先用 `bg_logs`（传 PID，可带 `tail` / `stream` / `offset`）直接读截取的 stdout/stderr；省略 PID 读最新进程。也可用 Read 工具读返回的日志路径，或 bash 跑 `Get-Content -LiteralPath "<日志路径>" -Tail 50`。
- 列出进程：用 `bg_list` 查看所有后台进程（PID、运行/已退出、启动时间、命令），`all=false` 只看存活的。
- 重启：用 `bg_restart` 传 PID（省略 PID 重启最新存活进程），会先停旧进程树再用原命令与原工作目录重启。
- 停止：`bg_stop` 传 PID（Windows 上会连同子进程树一起结束）。

**仍然用普通 bash 的场景：** 有明确终点的命令，如 `npm run build`、`npm test`、`git status`、`npm install`、`tsc`、一次性脚本等。这类命令正常等待即可。

**注意：** 不要用 `Start-Process ... &` 之类自行拼后台命令来绕过——直接调 `bg_start` 即可，它已处理 Windows 上 pwsh `detached` 失效、引号拆词、日志重定向等问题。

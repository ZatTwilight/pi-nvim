import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";

const SOCKETS_DIR = "/tmp/pi-nvim-sockets";
const NVIM_SOCKETS_DIR = "/tmp/pi-nvim-nvim-sockets";
const LATEST_LINK = "/tmp/pi-nvim-latest.sock";
const EDITED_FILES_ENTRY = "pi-nvim-edited-file";

type MuxInfo = { type: "tmux" | "zellij"; session: string; pane?: string } | null;
type NvimInfo = {
  cwd?: string;
  pid?: number;
  socket?: string;
  mux?: MuxInfo;
  focusOnOpen?: boolean;
};
type OpenTarget = { path: string; line?: number; column?: number };

function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function getSocketPath(cwd: string): string {
  return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

function getMuxInfo(): MuxInfo {
  if (process.env.ZELLIJ_SESSION_NAME) {
    return { type: "zellij", session: process.env.ZELLIJ_SESSION_NAME };
  }
  if (process.env.TMUX) {
    let session = process.env.PI_NVIM_TMUX_SESSION;
    if (!session) {
      try {
        session = execFileSync("tmux", ["display-message", "-p", "#S"], {
          encoding: "utf8",
        }).trim();
      } catch {
        session = process.env.TMUX.split(",")[0];
      }
    }
    return { type: "tmux", session };
  }
  return null;
}

function sameMux(a: MuxInfo | undefined, b: MuxInfo): boolean {
  return !!a && !!b && a.type === b.type && a.session === b.session;
}

function parseOpenTarget(value: string, cwd: string): OpenTarget | null {
  const match = value.trim().match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (!match || !match[1]) return null;
  return {
    path: path.resolve(cwd, match[1]),
    line: match[2] ? Number(match[2]) : undefined,
    column: match[3] ? Number(match[3]) : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let socketPath: string | null = null;
  let cwd = process.cwd();
  let editedFiles: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    editedFiles = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === EDITED_FILES_ENTRY) {
        const editedPath = (entry.data as { path?: unknown } | undefined)?.path;
        if (typeof editedPath === "string") recordEditedFile(editedPath);
      }
    }

    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    socketPath = getSocketPath(cwd);
    try {
      fs.unlinkSync(socketPath);
    } catch {}

    server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (data) => {
        buffer += data.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) handleMessage(line, conn);
        }
      });
      conn.on("error", () => {});
    });

    server.listen(socketPath, () => {
      try {
        fs.unlinkSync(LATEST_LINK);
      } catch {}
      try {
        fs.symlinkSync(socketPath!, LATEST_LINK);
      } catch {}
      fs.writeFileSync(
        socketPath + ".info",
        JSON.stringify({
          cwd,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          mux: getMuxInfo(),
        }),
      );
    });

    server.on("error", (err) => ctx.ui.notify(`pi-nvim error: ${err.message}`, "error"));
  });

  function recordEditedFile(editedPath: string) {
    const absolutePath = path.resolve(cwd, editedPath);
    editedFiles = editedFiles.filter((candidate) => candidate !== absolutePath);
    editedFiles.push(absolutePath);
  }

  pi.on("tool_result", (event) => {
    if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const absolutePath = path.resolve(cwd, input.path.replace(/^@/, ""));
    recordEditedFile(absolutePath);
    pi.appendEntry(EDITED_FILES_ENTRY, { path: absolutePath });
  });

  function handleMessage(raw: string, conn: net.Socket) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "ping") return respond(conn, { ok: true, type: "pong" });
      if (msg.type === "prompt" && typeof msg.message === "string") {
        process.stdout.write("\x1b[?1049h\x1b[?1049l");
        pi.sendUserMessage(msg.message, { deliverAs: "followUp" });
        return respond(conn, { ok: true });
      }
      respond(conn, { ok: false, error: `Unknown command type: ${msg.type}` });
    } catch (error) {
      respond(conn, { ok: false, error: `Parse error: ${(error as Error).message}` });
    }
  }

  function respond(conn: net.Socket, value: unknown) {
    try {
      conn.write(JSON.stringify(value) + "\n");
    } catch {}
  }

  function findNvim(): NvimInfo | null {
    let candidates: Array<{ info: NvimInfo; score: number; mtime: number }> = [];
    const mux = getMuxInfo();
    try {
      for (const name of fs.readdirSync(NVIM_SOCKETS_DIR)) {
        if (!name.endsWith(".info")) continue;
        const info = JSON.parse(
          fs.readFileSync(path.join(NVIM_SOCKETS_DIR, name), "utf8"),
        ) as NvimInfo;
        if (!info.socket || !fs.existsSync(info.socket)) continue;
        const score = (info.cwd === cwd ? 2 : 0) + (sameMux(info.mux, mux) ? 4 : 0);
        const mtime = fs.statSync(info.socket).mtimeMs;
        candidates.push({ info, score, mtime });
      }
    } catch {}
    candidates = candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    return candidates[0]?.info ?? null;
  }

  async function focusNvimPane(info: NvimInfo): Promise<void> {
    if (info.focusOnOpen === false || !info.mux?.pane) return;
    const args =
      info.mux.type === "tmux"
        ? ["select-pane", "-t", info.mux.pane]
        : ["--session", info.mux.session, "action", "focus-pane-id", info.mux.pane];
    const command = info.mux.type === "tmux" ? "tmux" : "zellij";
    await new Promise<void>((resolve, reject) => {
      execFile(command, args, (error) => (error ? reject(error) : resolve()));
    });
  }

  async function openInNvim(
    target: OpenTarget,
    ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void } },
  ) {
    const nvim = findNvim();
    if (!nvim?.socket) {
      ctx.ui.notify("No Neovim instance found for this cwd/multiplexer session", "warning");
      return;
    }
    const conn = net.createConnection(nvim.socket);
    conn.on("connect", () => {
      conn.end(JSON.stringify({ type: "open", ...target }) + "\n", () => {
        focusNvimPane(nvim).catch((error: Error) =>
          ctx.ui.notify(`Opened file, but could not focus Neovim: ${error.message}`, "warning"),
        );
      });
    });
    conn.on("error", (error) =>
      ctx.ui.notify(`Could not open in Neovim: ${error.message}`, "error"),
    );
  }

  pi.registerCommand("open", {
    description: "Open a file in the linked Neovim; without arguments, select a file edited by pi",
    handler: async (args, ctx) => {
      let target: OpenTarget | null = args.trim() ? parseOpenTarget(args, cwd) : null;
      if (!target) {
        if (editedFiles.length === 0) {
          ctx.ui.notify(
            "Pi has not edited any files with the edit/write tools in this session",
            "warning",
          );
          return;
        }
        const choices = [...editedFiles].reverse();
        const selected = await ctx.ui.select(
          "Open Pi-edited file:",
          choices.map((file) => path.relative(cwd, file)),
        );
        if (!selected) return;
        target = {
          path: choices[choices.map((file) => path.relative(cwd, file)).indexOf(selected)],
        };
      }
      await openInNvim(target, ctx);
    },
  });

  pi.registerCommand("pi-nvim-info", {
    description: "Show pi-nvim socket path",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        socketPath ? `Socket: ${socketPath}` : "pi-nvim not active",
        socketPath ? "info" : "warning",
      ),
  });

  function cleanup() {
    if (server) {
      server.close();
      server = null;
    }
    try {
      if (socketPath) fs.unlinkSync(socketPath);
    } catch {}
    try {
      if (socketPath) fs.unlinkSync(socketPath + ".info");
    } catch {}
    try {
      if (fs.readlinkSync(LATEST_LINK) === socketPath) fs.unlinkSync(LATEST_LINK);
    } catch {}
  }

  pi.on("session_shutdown", async () => cleanup());
  process.on("exit", cleanup);
}

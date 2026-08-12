import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createTwoFilesPatch } from "diff";

const SOCKETS_DIR = "/tmp/pi-nvim-sockets";
const NVIM_SOCKETS_DIR = "/tmp/pi-nvim-nvim-sockets";
const LATEST_LINK = "/tmp/pi-nvim-latest.sock";
const EDITED_FILES_ENTRY = "pi-nvim-edited-file";

type MuxInfo =
  | { type: "tmux" | "zellij"; session: string; pane?: string }
  | {
      type: "herdr";
      session: string;
      pane: string;
      tab?: string;
      socket?: string;
    }
  | null;
type HerdrPane = { pane_id: string; tab_id: string; workspace_id: string };
type NvimInfo = {
  cwd?: string;
  pid?: number;
  socket?: string;
  mux?: MuxInfo;
  focusOnOpen?: boolean;
};
type OpenTarget = { path: string; line?: number; column?: number };
type EditRange = {
  startLine: number;
  endLine: number;
  added: number;
  removed: number;
};
type FileMutation = {
  path: string;
  toolName: "edit" | "write";
  turnId: string;
  timestamp: number;
  added: number;
  removed: number;
  ranges: EditRange[];
  diff?: string;
};

type EditToolDetails = { diff?: unknown; patch?: unknown; firstChangedLine?: unknown };

function parseDiff(
  diff: string,
  firstChangedLine?: number,
): Pick<FileMutation, "added" | "removed" | "ranges"> {
  const lines = diff.split("\n");
  const ranges: EditRange[] = [];
  let current: EditRange | null = null;
  let newLine: number | null = null;
  let added = 0;
  let removed = 0;

  const finishRange = () => {
    if (current) ranges.push(current);
    current = null;
  };

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      finishRange();
      newLine = Math.max(1, Number(header[3]));
      continue;
    }
    if (newLine === null || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      current ??= { startLine: newLine, endLine: newLine, added: 0, removed: 0 };
      current.endLine = newLine;
      current.added++;
      added++;
      newLine++;
    } else if (line.startsWith("-")) {
      current ??= { startLine: newLine, endLine: newLine, added: 0, removed: 0 };
      current.removed++;
      removed++;
    } else if (line.startsWith(" ")) {
      finishRange();
      newLine++;
    }
  }
  finishRange();

  // Pi versions that expose a rendered diff instead of a unified patch use
  // lines such as "+  42 added" and "-  41 removed".
  if (added === 0 && removed === 0) {
    for (const line of lines) {
      const rendered = line.match(/^([+-])\s*(\d+)\s/);
      if (!rendered) continue;
      const lineNumber = Number(rendered[2]);
      if (rendered[1] === "+") added++;
      else removed++;
      const last = ranges[ranges.length - 1];
      if (last && lineNumber <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, lineNumber);
        if (rendered[1] === "+") last.added++;
        else last.removed++;
      } else {
        ranges.push({
          startLine: lineNumber,
          endLine: lineNumber,
          added: rendered[1] === "+" ? 1 : 0,
          removed: rendered[1] === "-" ? 1 : 0,
        });
      }
    }
  }

  if (ranges.length === 0 && firstChangedLine !== undefined) {
    ranges.push({ startLine: firstChangedLine, endLine: firstChangedLine, added, removed });
  }
  return { added, removed, ranges };
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function getSocketPath(cwd: string): string {
  return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

function getHerdrPane(pane: string, socket?: string): HerdrPane | null {
  try {
    const output = execFileSync("herdr", ["pane", "get", pane], {
      encoding: "utf8",
      env: socket ? { ...process.env, HERDR_SOCKET_PATH: socket } : process.env,
    });
    const result = JSON.parse(output) as { result?: { pane?: Partial<HerdrPane> } };
    const resolved = result.result?.pane;
    if (
      typeof resolved?.pane_id === "string" &&
      typeof resolved.tab_id === "string" &&
      typeof resolved.workspace_id === "string"
    ) {
      return resolved as HerdrPane;
    }
  } catch {}
  return null;
}

function getMuxInfo(): MuxInfo {
  if (process.env.HERDR_PANE_ID) {
    const socket = process.env.HERDR_SOCKET_PATH;
    const resolved = getHerdrPane(process.env.HERDR_PANE_ID, socket);
    const session = resolved?.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
    if (session) {
      return {
        type: "herdr",
        session,
        pane: resolved?.pane_id ?? process.env.HERDR_PANE_ID,
        tab: resolved?.tab_id ?? process.env.HERDR_TAB_ID,
        socket,
      };
    }
  }
  if (process.env.ZELLIJ_SESSION_NAME) {
    return {
      type: "zellij",
      session: process.env.ZELLIJ_SESSION_NAME,
      pane: process.env.ZELLIJ_PANE_ID,
    };
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
    return { type: "tmux", session, pane: process.env.TMUX_PANE };
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
  let mutations: FileMutation[] = [];
  let currentTurnId = "session-start";
  const beforeWrites = new Map<string, string>();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    mutations = [];
    currentTurnId = "session-start";
    beforeWrites.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "user") {
        currentTurnId = entry.id;
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== EDITED_FILES_ENTRY) continue;
      const data = entry.data as Partial<FileMutation> | undefined;
      if (!data || typeof data.path !== "string") continue;
      if (data.toolName === "edit" || data.toolName === "write") {
        const diff = typeof data.diff === "string" ? data.diff : undefined;
        const recovered = parseDiff(diff ?? "");
        mutations.push({
          path: path.resolve(cwd, data.path),
          toolName: data.toolName,
          turnId: typeof data.turnId === "string" ? data.turnId : currentTurnId,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
          added: recovered.added || (typeof data.added === "number" ? data.added : 0),
          removed: recovered.removed || (typeof data.removed === "number" ? data.removed : 0),
          ranges:
            recovered.ranges.length > 0
              ? recovered.ranges
              : Array.isArray(data.ranges)
                ? data.ranges
                : [],
          diff,
        });
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

  pi.on("before_agent_start", () => {
    currentTurnId = crypto.randomUUID();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const absolutePath = path.resolve(cwd, input.path.replace(/^@/, ""));
    try {
      beforeWrites.set(event.toolCallId, await fs.promises.readFile(absolutePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        beforeWrites.set(event.toolCallId, "");
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const beforeWrite = beforeWrites.get(event.toolCallId);
    beforeWrites.delete(event.toolCallId);
    if (event.isError) return;

    const input = event.input as { path?: unknown; content?: unknown };
    if (typeof input.path !== "string") return;
    const absolutePath = path.resolve(cwd, input.path.replace(/^@/, ""));
    let diff: string | undefined;
    let firstChangedLine: number | undefined;

    if (event.toolName === "edit") {
      const details = event.details as EditToolDetails | undefined;
      diff =
        typeof details?.patch === "string"
          ? details.patch
          : typeof details?.diff === "string"
            ? details.diff
            : undefined;
      firstChangedLine =
        typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
    } else if (beforeWrite !== undefined && typeof input.content === "string") {
      diff = createTwoFilesPatch(
        absolutePath,
        absolutePath,
        beforeWrite,
        input.content,
        "before",
        "after",
      );
    }

    const stats = parseDiff(diff ?? "", firstChangedLine);
    const mutation: FileMutation = {
      path: absolutePath,
      toolName: event.toolName,
      turnId: currentTurnId,
      timestamp: Date.now(),
      ...stats,
      diff,
    };
    mutations.push(mutation);
    pi.appendEntry(EDITED_FILES_ENTRY, mutation);
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
    if (info.mux.type === "herdr") {
      const resolved = getHerdrPane(info.mux.pane, info.mux.socket);
      const workspace = resolved?.workspace_id ?? info.mux.session;
      const tab = resolved?.tab_id ?? info.mux.tab;
      if (!tab) throw new Error(`Could not resolve herdr pane ${info.mux.pane}`);
      const env = info.mux.socket
        ? { ...process.env, HERDR_SOCKET_PATH: info.mux.socket }
        : process.env;
      await exec("herdr", ["workspace", "focus", workspace], env);
      await exec("herdr", ["tab", "focus", tab], env);
      return;
    }
    const args =
      info.mux.type === "tmux"
        ? ["select-pane", "-t", info.mux.pane]
        : ["--session", info.mux.session, "action", "focus-pane-id", info.mux.pane];
    await exec(info.mux.type === "tmux" ? "tmux" : "zellij", args);
  }

  function exec(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(command, args, { env }, (error) => (error ? reject(error) : resolve()));
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

  async function selectMutation(
    block: FileMutation[],
    ctx: ExtensionContext,
    showEarlierTurns: boolean,
  ): Promise<OpenTarget | "earlier" | null> {
    const byFile = new Map<string, FileMutation[]>();
    for (const mutation of block) {
      const history = byFile.get(mutation.path) ?? [];
      history.push(mutation);
      byFile.set(mutation.path, history);
    }
    const files = [...byFile.entries()].sort(
      (a, b) => b[1][b[1].length - 1].timestamp - a[1][a[1].length - 1].timestamp,
    );
    const fileLabels = files.map(([file, history]) => {
      const added = history.reduce((total, mutation) => total + mutation.added, 0);
      const removed = history.reduce((total, mutation) => total + mutation.removed, 0);
      const latest = history[history.length - 1];
      const fileName = ctx.ui.theme.fg("accent", path.relative(cwd, file));
      const additions = ctx.ui.theme.fg("success", `+${added}`);
      const removals = ctx.ui.theme.fg("error", `-${removed}`);
      const metadata = ctx.ui.theme.fg(
        "dim",
        `· ${history.length} edit${history.length === 1 ? "" : "s"} · ${formatRelativeTime(latest.timestamp)}`,
      );
      return `${fileName}  ${additions} ${removals} ${metadata}`;
    });
    const earlierTurnsLabel = ctx.ui.theme.fg("muted", "Show edits from earlier turns…");
    const choices = showEarlierTurns ? [...fileLabels, earlierTurnsLabel] : fileLabels;
    const selectedFile = await ctx.ui.select("Open Pi-edited file:", choices);
    if (!selectedFile) return null;
    if (selectedFile === earlierTurnsLabel) return "earlier";
    const [selectedPath, history] = files[fileLabels.indexOf(selectedFile)];

    const newestFirst = [...history].reverse();
    if (newestFirst.length === 1) {
      return { path: selectedPath, line: newestFirst[0].ranges[0]?.startLine };
    }

    const editLabels = newestFirst.map((mutation, index) => {
      const range = mutation.ranges[0];
      const location = range
        ? range.startLine === range.endLine
          ? `line ${range.startLine}`
          : `lines ${range.startLine}-${range.endLine}`
        : "location unavailable";
      const moreRanges = mutation.ranges.length > 1 ? ` + ${mutation.ranges.length - 1} more` : "";
      const number = ctx.ui.theme.fg("muted", `${index + 1}.`);
      const tool = ctx.ui.theme.fg("accent", mutation.toolName);
      const additions = ctx.ui.theme.fg("success", `+${mutation.added}`);
      const removals = ctx.ui.theme.fg("error", `-${mutation.removed}`);
      const time = ctx.ui.theme.fg("dim", formatRelativeTime(mutation.timestamp));
      return `${number} ${tool} · ${location}${moreRanges} · ${additions} ${removals} · ${time}`;
    });
    const selectedEdit = await ctx.ui.select(
      `Open edit in ${path.relative(cwd, selectedPath)}:`,
      editLabels,
    );
    if (!selectedEdit) return null;
    const mutation = newestFirst[editLabels.indexOf(selectedEdit)];
    return { path: selectedPath, line: mutation.ranges[0]?.startLine };
  }

  const openInLinkedNvim = async (args: string, ctx: ExtensionContext) => {
    let target: OpenTarget | null = args.trim() ? parseOpenTarget(args, cwd) : null;
    if (!target) {
      if (mutations.length === 0) {
        ctx.ui.notify(
          "Pi has not edited any files with the edit/write tools in this session",
          "warning",
        );
        return;
      }

      const blocks = new Map<string, FileMutation[]>();
      for (const mutation of mutations) {
        const block = blocks.get(mutation.turnId) ?? [];
        block.push(mutation);
        blocks.set(mutation.turnId, block);
      }
      const newestFirst = [...blocks.values()].reverse();
      const selection = await selectMutation(newestFirst[0], ctx, newestFirst.length > 1);
      if (selection !== "earlier") target = selection;

      if (selection === "earlier") {
        const earlierBlocks = newestFirst.slice(1);
        const blockLabels = earlierBlocks.map((block, index) => {
          const latest = block[block.length - 1];
          const files = new Set(block.map((mutation) => mutation.path)).size;
          return `${index + 1}. ${block.length} edit${block.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} · ${formatRelativeTime(latest.timestamp)}`;
        });
        const selectedBlock = await ctx.ui.select(
          "Show edits from which earlier turn?",
          blockLabels,
        );
        if (!selectedBlock) return;
        const earlierSelection = await selectMutation(
          earlierBlocks[blockLabels.indexOf(selectedBlock)],
          ctx,
          false,
        );
        target = earlierSelection === "earlier" ? null : earlierSelection;
      }
      if (!target) return;
    }
    await openInNvim(target, ctx);
  };

  pi.registerCommand("open", {
    description: "Open a file in the linked Neovim; without arguments, select a file edited by pi",
    handler: openInLinkedNvim,
  });

  pi.registerShortcut("alt+o", {
    description: "Open a Pi-edited file in the linked Neovim",
    handler: (ctx) => openInLinkedNvim("", ctx),
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

# pi-nvim

Bridge between [pi](https://github.com/badlogic/pi) coding agent and Neovim. Run pi in one terminal pane and Neovim in another — send files, selections, and prompts from Neovim directly into your running pi session.

![demo](./demo/demo.gif)

## How it works

The repo contains two components:

1. **Pi extension** (`extension.ts`) — opens a unix socket when pi starts. External tools can send JSON messages to inject prompts into the active pi session.
2. **Neovim plugin** (`lua/pi-nvim/`) — connects to that socket via libuv. Sends context from your editor to pi.

Discovery is automatic: the extension writes socket info to `/tmp/pi-nvim-sockets/`, and the Neovim plugin scans that directory. It prefers sessions matching the current tmux/Zellij session and working directory, then falls back to the newest live session.

Neovim also publishes a local socket so pi can open files in the matching editor instance.

## Install

### Pi side

```bash
pi install npm:pi-nvim
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["https://github.com/carderne/pi-nvim"]
}
```

Then `/reload` in pi.

### Neovim side

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{ "carderne/pi-nvim" }
```

Then in your config:

```lua
require("pi-nvim").setup()
```

Options (defaults):

```lua
require("pi-nvim").setup({
  socket_path = nil, -- auto-discover
  set_default_keymaps = true,
  focus_on_open = true, -- focus Neovim's pane after /open
  focus_on_send = true, -- focus pi's pane after sending a prompt
})
```

## Usage

Start pi in one terminal. Start Neovim in another. The pi extension automatically opens a socket on session start.

### Commands

| Command | Description |
|---|---|
| `:Pi` | Open the Send to pi dialog (works in normal and visual mode) |
| `:PiSend` | Type a prompt and send to pi |
| `:PiSendFile` | Send current file path + prompt |
| `:PiSendSelection` | Send visual selection + prompt |
| `:PiSendBuffer` | Send entire buffer + prompt |
| `:PiPing` | Check if pi is reachable |
| `:PiSessions` | List/switch between running pi sessions |
| `/open` (in pi) | Select a file edited by pi and open it in Neovim |
| `/open path[:line[:column]]` (in pi) | Open a specific location directly in Neovim |

### Default keybindings

- In Neovim, `<leader>p` is mapped to `:Pi` in both normal and visual mode.
- In pi, `Alt+O` opens the Pi-edited file picker and sends the selected location to Neovim.

To disable the default Neovim mappings:

```lua
require("pi-nvim").setup({
  set_default_keymaps = false,
})
```

### The `:Pi` dialog

Opens a floating window in the center of the screen:

- Shows the current **file name** (always sent)
- If you had a **visual selection**, it shows the line range and sends the selected text
- If no selection, you can press **Tab** to toggle sending the **entire buffer**
- Type a prompt and press **Enter** to send (or just Enter with no prompt)
- Press **Esc** or **Ctrl-C** to cancel

### Additional keybindings

```lua
vim.keymap.set("n", "<leader>pp", ":PiSend<CR>")
vim.keymap.set("n", "<leader>pf", ":PiSendFile<CR>")
vim.keymap.set("v", "<leader>ps", ":PiSendSelection<CR>")
vim.keymap.set("n", "<leader>pb", ":PiSendBuffer<CR>")
vim.keymap.set("n", "<leader>pi", ":PiPing<CR>")
```

## Edited-file tracking

Pi tracks every successful use of its `edit` and `write` tools, including its timestamp, exact changed line ranges, and Git-style added/removed line counts. For `edit`, this comes from pi's resulting unified diff. For `write`, the extension snapshots the previous content and computes a before/after diff.

The history is persisted in pi's session entries, so it survives extension reloads and session resume. Running `/open` without arguments first shows files ordered by their latest mutation, with aggregate `+added -removed` totals, edit count, and relative time. Selecting a file shows its individual edit/write operations; selecting an operation opens Neovim at its first changed line.

This practical default intentionally does **not** claim to detect files changed by arbitrary `bash` commands, formatters, generators, or other custom tools. More complete alternatives would be:

- compare VCS/worktree state around each turn;
- watch filesystem changes while pi is active; or
- wrap additional mutation tools and report their output paths.

Those options add either overhead or false positives and are not enabled currently.

## Multiplexer matching

Both pi and Neovim publish their working directory, multiplexer identity, and pane ID. Zellij uses `ZELLIJ_SESSION_NAME` and `ZELLIJ_PANE_ID`. tmux uses `TMUX_PANE` plus `PI_NVIM_TMUX_SESSION` when set, otherwise it queries `tmux display-message -p '#S'` for the session name. herdr uses `HERDR_PANE_ID` as its canonical identity and resolves the pane's current tab and workspace with `herdr pane get`; the environment's `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` are fallback hints. Candidates in the same multiplexer session or herdr workspace are preferred, with cwd used as an additional match signal.

After `/open` sends the file location, pi focuses the corresponding Neovim pane. In the other direction, a successful `:Pi`/`:PiSend*` request focuses the receiving pi pane. tmux and Zellij focus panes directly. herdr focuses the resolved workspace and tab; herdr currently cannot target an arbitrary pane within a split tab by ID.

Set `focus_on_open = false` to keep focus in pi after `/open`, or `focus_on_send = false` to stay in Neovim after sending. Focus failures only produce warnings; messages and file-open requests still succeed.

## Protocol

The socket accepts newline-delimited JSON:

```json
{"type": "prompt", "message": "your prompt here"}
{"type": "ping"}
```

The Neovim-owned socket accepts open requests from pi:

```json
{"type":"open","path":"/absolute/file.ts","line":42,"column":1}
```

Responses:

```json
{"ok": true}
{"ok": true, "type": "pong"}
{"ok": false, "error": "..."}
```

This means you can also send prompts from any tool:

```bash
echo '{"type":"prompt","message":"hello"}' | socat - UNIX-CONNECT:/tmp/pi-nvim-sockets/<hash>.sock
```

## License

MIT

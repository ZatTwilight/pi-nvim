# pi-nvim

<!-- Temporary comment -->

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

`<leader>p` is mapped to `:Pi` in both normal and visual mode by default.

To disable the default mappings:

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

Pi tracks successful uses of its `edit` and `write` tools for the current session. The list is persisted in pi's session entries, so it survives extension reloads and session resume. Running `/open` without arguments shows those files in a TUI selector, most recently edited first.

This practical default intentionally does **not** claim to detect files changed by arbitrary `bash` commands, formatters, generators, or other custom tools. More complete alternatives would be:

- compare VCS/worktree state around each turn;
- watch filesystem changes while pi is active; or
- wrap additional mutation tools and report their output paths.

Those options add either overhead or false positives and are not enabled currently.

## Multiplexer matching

Both pi and Neovim publish their working directory and multiplexer identity. Zellij uses `ZELLIJ_SESSION_NAME`. tmux uses `PI_NVIM_TMUX_SESSION` when set, otherwise it queries `tmux display-message -p '#S'` for the session name. Candidates in the same multiplexer session are preferred, with cwd used as an additional match signal.

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

# AIchat2MD

Shoutouts to [agarwalvishal](https://github.com/agarwalvishal). This project is forked from his [claude-chat-exporter](https://github.com/agarwalvishal/claude-chat-exporter) (MIT) which has been a godsend for my notes.

ChatGPT and DeepSeek attachment handling, and the DeepSeek message reader, are adapted from the approaches in [AI-Exporter](https://github.com/sisodiabhumca/AI-Exporter) by Gaurav Sisodia and [deepseek-exporter](https://github.com/pionxzh/deepseek-exporter) by Pionxzh (both MIT). Thanks to both.

One click, no menus: export the conversation you're viewing — **Claude, ChatGPT, Gemini, or DeepSeek** — straight to a clean Markdown file, built for dropping into an **Obsidian** vault or a **RAG** pipeline.

> Sections marked 🟢 are substantially the original project's writing/design, still accurate here. Unmarked sections are new for AIchat2MD.

## Install

Get it from [addons.mozilla.org](#) *(add your AMO listing link here)*, or grab the signed `.xpi` from this repo's [Releases](../../releases).

## Features

- **One-click export** — toolbar button or sidebar panel (your choice, in settings), no menus to navigate
- **Four platforms** — Claude, ChatGPT, Gemini, and DeepSeek, auto-detected from whatever tab you're on
- 🟢 **Perfect Markdown fidelity (Claude)** — reads Claude's own source markdown from its API — no HTML parsing, no conversion
- 🟢 **Complete element support (Claude)** — tables, math, code, lists, artifacts, created files, charts, and attachments, all in place and in order
- 🟢 **Complete & in order** — every message on the current branch, correctly ordered, even in long conversations that only partly render on screen
- **Attachments (Claude, ChatGPT, DeepSeek)** — images and files from the chat saved as a second download, `[Chat title] - attachments.zip`; unzip it next to the `.md` and the links resolve
- **Obsidian-ready frontmatter** — `title`, `agent`, `exported` date, and `source` in every file's YAML header
- 🟢 **Private by design** — no servers of its own; runs entirely in your browser and only ever calls the AI service's own backend, over your existing session

## How it works

Not every platform exposes the same thing, so this uses whichever approach each one actually allows:

### 🟢 Claude

1. **Fetch** — calls Claude's internal API for the current conversation (`/api/organizations/{orgId}/chat_conversations/{conversationId}`), authenticated by your existing session cookie
2. **Order** — reconstructs the conversation's current branch by walking the message tree from the current leaf up its parent chain, so a regenerated response exports exactly what's on screen
3. **Extract** — walks each message's content blocks in order: text blocks (Claude's original source markdown) plus artifacts, created files, and widgets, rendered in position
4. **Output** — writes a single markdown file: YAML frontmatter followed by one `#`-level header per turn

> **Branches / regenerated responses:** the export follows whichever branch is currently on screen — Claude's *active leaf* — not necessarily the newest one. Switch branches in Claude first (the `‹ ›` arrows on a regenerated message) if you want a different one.

### ChatGPT

Same approach, adapted to ChatGPT's own API:

1. **Session** — reads an access token from ChatGPT's `/api/auth/session` endpoint
2. **Fetch** — calls `/backend-api/conversation/{id}` with that token, which returns the full conversation as a node graph rather than a flat list
3. **Order** — walks from `current_node` back to the root via each node's `parent` link, then reverses — same branch-following logic as the Claude side
4. **Clean** — leaves out tool steps (code execution, web search), hidden system messages, ChatGPT's interactive-layout markup (`<box>`, `<row>`, `{@body …}`) and its citation markers
5. **Attachments** — uploaded images (`image_asset_pointer` parts), uploaded files (`metadata.attachments`), and images ChatGPT generates; each is downloaded in two steps: `/backend-api/files/download/{id}` returns a temporary link, which serves the file
6. **Output** — same frontmatter + per-turn header format

### Gemini

Gemini doesn't expose a usable conversation API (its internal RPCs are protobuf-based and not practical to read directly), so this reads the rendered page instead:

1. **Locate** — finds each `<conversation-turn>` element and, within it, the `<user-query>`/`<model-response>` pair
2. **Force full render** — a quick scroll to the top and back down first, since long conversations can lazy-unmount turns that have scrolled out of view
3. **Convert** — walks each response's HTML into Markdown by hand (headings, lists, tables, code blocks — including Gemini's custom `<code-block>` element, which can render inside an open shadow root), filtering out the "what would you like to do next" suggestion chips Gemini appends after each answer
4. **Output** — same frontmatter format as Claude/ChatGPT

Being DOM-based rather than API-based, this one is more exposed to breaking if Google changes the page's structure than the Claude/ChatGPT side is.

### DeepSeek

DeepSeek does have an internal API, but its exact shape isn't publicly documented, so this tries two approaches in order:

1. **API (normal path)** — calls DeepSeek's internal `history_messages` endpoint with your session token, follows the branch on screen, and reads each message's typed fragments: `REQUEST`/`RESPONSE` are exported; reasoning (`THINK`), web-search panels and citation markers are left out. Attached files come from DeepSeek's file service (`files.deepseeksvc.com`)
2. **DOM fallback** — only if the API path fails, falls back to reading the rendered page: finds message-like elements, strips DeepSeek's own UI chrome (buttons, icons — anything with a `ds-`-prefixed class), and assumes strict user/assistant alternation starting with the user, since that holds for any non-group chat

### 🟢 Why not always just read the page?

```
❌ Driving the page (DOM + copy buttons):
- Only sees the messages currently rendered → long chats export partially
- Pairs turns by index → a regenerated branch can misalign them
- Reaches only what has a copy button → no artifacts, files or attachments
- Couples to CSS selectors that change constantly → a maintenance nightmare

✅ Reading the service's own API, where one exists (Claude, ChatGPT, DeepSeek):
- Complete conversation, always, in the order it appears on screen
- Original source markdown → perfect fidelity, zero conversion
- A stable data contract instead of brittle selectors
```

Gemini has no such API to read, so it's stuck with the DOM approach above — same tradeoffs as any scraper, just done as carefully as possible.

## File output

- **Filename**: `[Chat title].md` — no date suffix as of v2.0.0 (dropped once exports started coming from four different platforms instead of two; re-exporting will overwrite a file of the same name)
- **Frontmatter**: `title`, `agent` (Claude/ChatGPT/Gemini/DeepSeek), `exported`, `source`, and `model` when available
- 🟢 **Content**: complete conversation, in order, with per-message timestamps where the platform provides them
- 🟢 **Encoding**: UTF-8 with standard line endings

```yaml
---
title: "Sorting algorithm comparison"
agent: "Claude"
exported: "2026-09-12"
source: "https://claude.ai/chat/…"
model: "claude-opus-5"
---

# Human — Aug 30, 2026, 10:30 AM

Can you compare the common sorting algorithms in a table?

# Claude — Aug 30, 2026, 10:31 AM

| Algorithm  | Best       | Average    | Worst      |
| ---------- | ---------- | ---------- | ---------- |
| Merge Sort | O(n log n) | O(n log n) | O(n log n) |
```

## 🟢 Complete element support (Claude)

Because this reads Claude's source markdown directly, it automatically handles:

- Tables, math (LaTeX), code blocks with language detection, nested lists, links, formatting, blockquotes, all heading levels
- Artifacts (final version), created files, and charts/diagrams/widgets, as labelled fenced code blocks

**ChatGPT** and **DeepSeek** export each message's original markdown plus attachments (see How it works). **Gemini** handles headings, lists, tables, links, and code blocks via its own HTML-to-Markdown conversion, but not images or attachments yet — see Roadmap.

## Settings

Toolbar or sidebar — pick one in the extension's options page (`about:addons` → AIchat2MD → Preferences). Toolbar mode exports the instant you click the icon; sidebar mode opens a small panel with its own Export button.

**Attachments** (on by default): also download a chat's images and files as `[Chat title] - attachments.zip`, containing an `_attachments/` folder the `.md` links to. Only created when the chat has attachments. Turn it off to keep links/labels only. Files that can't be downloaded keep a link or label in the `.md`, and you get a notification naming them.

## 🟢 Privacy & security

- No backend of its own — this tool runs no servers; your conversations are never sent to us or any other party
- All processing happens locally, in your browser
- The only network calls are to the AI service's own API and its own file storage, over your existing session — the same data the web app already loads for you
- Nothing is retained — messages are transformed and downloaded immediately

## Limitations

- 🟢 Requires the account you're currently signed into on each platform
- 🟢 Relies on each service's internal, undocumented API (Claude, ChatGPT, DeepSeek) or rendered page structure (Gemini) — a response-shape or UI change would require an update
- 🟢 **Claude**: other tool calls (web search, bash, file view/edit) and internal thinking blocks aren't exported by design
- **Gemini**: images and attachments aren't exported yet, and a few text glitches remain in your own messages (see Roadmap)
- **ChatGPT**: verified live (Oct 2026) for uploaded and generated images and for files its code tool creates (PDF, PNG, ZIP). Those created files expire some time after the chat, and some can't be downloaded at all — a generated `.js` file failed in ChatGPT's own preview and Download button too. Either way the `.md` gets a "file not saved" label instead of a dead link
- **Claude**: uploaded images export as Claude's downscaled WebP preview; whether the original file can be downloaded is unconfirmed
- **DeepSeek**: verified live (Oct 2026). Uploaded images are saved at DeepSeek's preview size. Uploaded documents (PDF, DOCX…) aren't downloaded yet — DeepSeek's file server rejects the request without a file-type parameter whose value for documents is still unknown — so they stay as links (which expire) with name and size. DeepSeek can't generate files, so this only affects copies of your own uploads
- **Gemini and DeepSeek's DOM-scraping paths** are inherently more fragile than Claude/ChatGPT's API-based ones — a Google or DeepSeek UI update is more likely to break these than a Claude/OpenAI one is to break theirs
- All four only export the currently-selected branch of a conversation, not every regenerated alternative

## Roadmap

**Done:**
- v1.0 — Claude and ChatGPT export via each service's own API
- v2.0.0 — added Gemini and DeepSeek, toolbar/sidebar toggle, dropped the filename date suffix, moved to listed AMO distribution
- v2.0.1 — export no longer lost when Firefox's download step fails (falls back to Downloads folder, then an in-page download)
- v2.1.0 — Claude attachments: text files inlined, images/PDFs in a separate ZIP
- v2.2.0 — ChatGPT and DeepSeek attachments; DeepSeek reads its API properly (previously always fell back to page-scraping); ChatGPT exports drop tool steps and layout markup

**Next up:**
- Perplexity support — attempted for v2.0.0 (it has its own native "Export as Markdown" feature, reachable via its `···` menu) but pulled before release; the DOM interaction was tricky enough to need more testing than this cycle had room for
- Meta AI, Grok, and Copilot — rounding out support for all of the "Big 8" AI chat platforms
- Gemini attachments — likely by moving Gemini off page-scraping onto its internal data feed, as AI-Exporter does
- Gemini text fixes (found in live testing, present since v2.0.0): your messages pick up Gemini's hidden "You said" label plus a truncated preview before the full text; line breaks in your messages are lost; attachment-chip text (e.g. "PDF+ 2") leaks into replies. Either fixed against Gemini's current page structure, or by the data-feed rewrite above
- DeepSeek uploaded documents and full-size images — needs the `ty=` value DeepSeek's own viewer uses (one network capture)

## Contributing

Issues and PRs welcome — this is a small personal project, so response time varies.

## License

MIT — see [`LICENSE`](LICENSE). Original work Copyright (c) agarwalvishal; this fork's additions Copyright (c) PK.

## Disclaimer

This tool is not officially associated with Anthropic, OpenAI, Google, DeepSeek, Claude, ChatGPT, or Gemini. It's a community-created tool to enhance the user experience. Use it responsibly and in accordance with each service's terms of service.

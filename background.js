// AIchat2MD — background script.
//
// Two ways to trigger an export, both funneling into the same runExport():
//   1. Toolbar mode: clicking the toolbar icon exports immediately.
//   2. Sidebar mode: clicking the toolbar icon opens the sidebar panel,
//      which has its own "Export" button that sends a message here.
// Which mode is active is a single value in browser.storage.local, set from
// the options page (options.html/options.js).
//
// v2.0.0 adds Gemini and DeepSeek alongside Claude/ChatGPT. Claude and
// ChatGPT read straight from each site's internal REST API — clean,
// stable, exactly what their own web apps use. Gemini has no such API, so
// it scrapes the rendered DOM instead, which is inherently more fragile:
// it'll break if the site ships a UI overhaul. DeepSeek sits in between —
// it does have an internal API, but the exact response shape here is a
// best guess (adapted from how similar open-source DeepSeek exporters
// work), with a DOM-scraping fallback if the API attempt fails.
//
// Perplexity was also attempted for v2.0.0 but pulled before release —
// its native "Export as Markdown" feature turned out to sit behind a
// Radix UI menu that needed a full pointer-event sequence to trigger
// programmatically, plus an aria-label collision between the current
// thread's menu button and every sidebar history row's identically-
// labeled button. Both were tracked down and fixed, but not fully
// confirmed working before this release shipped — see perplexity-wip.js
// for the parked implementation to pick back up later.

const PLATFORMS = [
  { label: "Claude", test: (url) => /^https:\/\/claude\.ai\//.test(url), func: exportClaude },
  { label: "ChatGPT", test: (url) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url), func: exportChatGPT },
  { label: "Gemini", test: (url) => /^https:\/\/gemini\.google\.com\//.test(url), func: exportGemini },
  { label: "DeepSeek", test: (url) => /^https:\/\/chat\.deepseek\.com\//.test(url), func: exportDeepSeek },
];

const DEFAULT_MODE = "toolbar"; // "toolbar" | "sidebar"

browser.action.onClicked.addListener(async (tab) => {
  const { uiMode = DEFAULT_MODE } = await browser.storage.local.get("uiMode");
  if (uiMode === "sidebar") {
    browser.sidebarAction.open();
    return;
  }
  await runExport(tab);
});

// The sidebar panel can't call scripting.executeScript on an arbitrary tab
// as conveniently as the background script can, so it just asks us to do it.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "export") return;
  return (async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: "Couldn't find the active tab." };
    return runExport(tab);
  })();
});

async function runExport(tab) {
  try {
    const url = tab.url || "";
    const platform = PLATFORMS.find((p) => p.test(url));
    if (!platform) {
      notify("AIchat2MD", "Open a Claude, ChatGPT, Gemini, or DeepSeek conversation first.");
      return { error: "Not a supported conversation page." };
    }

    const [injected] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: platform.func,
    });

    const value = injected && injected.result;
    if (!value) throw new Error("Got no result back from the page.");
    if (value.error) throw new Error(value.error);

    const filename = buildFilename(value.title);
    return await saveMarkdown(tab, value.markdown, filename);
  } catch (err) {
    console.error("[AIchat2MD]", err);
    notify("Export failed", err.message || String(err));
    return { error: err.message || String(err) };
  }
}

// v2.0.1: the save step now has fallbacks. Firefox's downloads API can
// reject with a bare "An unexpected error occurred" for reasons outside the
// extension (a remembered save folder that no longer exists, a misbehaving
// file-picker portal, a download-capturing add-on). The chat itself has
// already been read and converted at this point, so instead of throwing it
// away we try, in order:
//   1. downloads.download with the "Save as" dialog (the normal path)
//   2. downloads.download without the dialog (straight to Downloads)
//   3. an ordinary <a download> click inside the chat tab — the same route
//      the original claude-chat-exporter bookmarklet uses, which bypasses
//      the downloads API entirely.
// A user pressing Cancel in the dialog is not a failure and stops here.
async function saveMarkdown(tab, markdown, filename) {
  const errors = [];

  for (const saveAs of [true, false]) {
    const blobUrl = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    try {
      const downloadId = await browser.downloads.download({ url: blobUrl, filename, saveAs });
      revokeWhenDone(downloadId, blobUrl);
      if (errors.length) console.warn("[AIchat2MD] Saved after fallback. Earlier attempts:", errors);
      return { ok: true, filename, method: saveAs ? "dialog" : "downloads-folder" };
    } catch (err) {
      URL.revokeObjectURL(blobUrl);
      const msg = err?.message || String(err);
      if (/cancel/i.test(msg)) return { error: "Export cancelled." };
      errors.push(`downloads.download(saveAs: ${saveAs}): ${msg}`);
      console.warn("[AIchat2MD] Download attempt failed:", errors[errors.length - 1], err);
    }
  }

  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageDownload,
      args: [markdown, filename],
    });
    if (res?.result?.ok) {
      console.warn("[AIchat2MD] Saved via in-page download. Downloads API attempts failed:", errors);
      return { ok: true, filename, method: "page" };
    }
    errors.push(`in-page download: ${res?.result?.error || "no result"}`);
  } catch (err) {
    errors.push(`in-page download: ${err?.message || String(err)}`);
  }

  throw new Error(`Couldn't save the file. ${errors.join(" | ")}`);
}

// Keep the blob alive until Firefox has finished reading it. The old fixed
// 60-second revoke could fire while a "Save as" dialog was still open.
function revokeWhenDone(downloadId, blobUrl) {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    browser.downloads.onChanged.removeListener(listener);
    URL.revokeObjectURL(blobUrl);
  };
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    const state = delta.state?.current;
    if (state === "complete" || state === "interrupted") cleanup();
  };
  browser.downloads.onChanged.addListener(listener);
  setTimeout(cleanup, 10 * 60 * 1000);
}

// Injected into the chat tab (self-contained, like the exporters below).
function pageDownload(markdown, filename) {
  try {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// v2.0.0: dropped the trailing "(MM.DD.YY)" — agent already lives in the
// frontmatter, and the date added little once you're pulling exports from
// five different platforms instead of two. Just "[Title].md" now.
function buildFilename(rawTitle) {
  const title = (rawTitle || "Untitled").trim() || "Untitled";
  const safeTitle = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return `${safeTitle}.md`;
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-96.png",
    title,
    message,
  });
}

// ---------------------------------------------------------------------------
// Exporter functions below are injected into the page via
// scripting.executeScript, so each one must be fully self-contained: no
// references to anything outside its own body, including no shared helpers
// or other top-level functions in this file (a DeepSeek bug early in
// v2.0.0's testing came from violating exactly this rule — see its comment
// below). Each returns { title, markdown } on success, or { error } on
// failure — never throws, since a thrown error from an injected function
// surfaces as an opaque "Error in invocation" on the caller side.
// ---------------------------------------------------------------------------

// Adapted from agarwalvishal/claude-chat-exporter (MIT License) — reads the
// conversation straight from claude.ai's own internal API (same endpoint the
// app uses), which returns every message's source markdown in order, rather
// than scraping the rendered DOM.
async function exportClaude() {
  try {
    const conversationId = window.location.pathname.split("/").pop();
    const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];
    if (!conversationId || conversationId.length < 20 || !conversationId.includes("-")) {
      return { error: "Open a specific Claude conversation first." };
    }
    if (!orgId) {
      return { error: "Couldn't read your Claude session — are you signed in?" };
    }

    const apiUrl = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
    const res = await fetch(apiUrl, { credentials: "include", headers: { "Content-Type": "application/json" } });
    if (!res.ok) return { error: `Claude API request failed (HTTP ${res.status}).` };
    const data = await res.json();

    const all = data?.chat_messages || [];
    if (!all.length) return { error: "No messages found in this conversation." };
    const byUuid = new Map(all.map((m) => [m.uuid, m]));

    // Follow the currently-selected branch from the leaf back to the root,
    // then reverse — this exports exactly what's on screen even after a
    // regenerated response.
    let ordered = null;
    const leaf = data.current_leaf_message_uuid;
    if (leaf && byUuid.has(leaf)) {
      const path = [];
      const seen = new Set();
      let cur = byUuid.get(leaf);
      while (cur && !seen.has(cur.uuid)) {
        seen.add(cur.uuid);
        path.push(cur);
        cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : null;
      }
      if (path.length) ordered = path.reverse();
    }
    if (!ordered) ordered = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    // Reconstruct each artifact's final content (create/rewrite carry full
    // content; update carries an old_str -> new_str diff) so it renders once.
    const artifacts = new Map();
    for (const m of ordered) {
      for (const block of m.content || []) {
        if (block.type !== "tool_use" || block.name !== "artifacts") continue;
        const input = block.input || {};
        const id = input.id || "__artifact__";
        let a = artifacts.get(id);
        if (!a) { a = { content: "" }; artifacts.set(id, a); }
        if (input.command === "update") {
          if (typeof input.old_str === "string" && typeof input.new_str === "string" && a.content.includes(input.old_str)) {
            a.content = a.content.replace(input.old_str, () => input.new_str);
          }
        } else if (typeof input.content === "string") {
          a.content = input.content;
        }
        if (input.title) a.title = input.title;
        if (input.language) a.language = input.language;
        a.lastVersionUuid = input.version_uuid;
      }
    }

    const fence = (src) => "`".repeat(Math.max(3, ...((src.match(/`+/g) || []).map((s) => s.length + 1))));
    const renderToolUse = (block) => {
      const input = block.input || {};
      if (block.name === "artifacts") {
        const a = artifacts.get(input.id || "__artifact__");
        if (!a || input.version_uuid !== a.lastVersionUuid || !a.content) return "";
        const f = fence(a.content);
        return `**Artifact: ${a.title || "untitled"}**\n\n${f}${a.language || ""}\n${a.content}\n${f}`;
      }
      if (block.name === "create_file" && typeof input.file_text === "string" && input.file_text) {
        const file = String(input.path || "file").split("/").pop();
        const f = fence(input.file_text);
        return `**File: ${file}**\n\n${f}\n${input.file_text}\n${f}`;
      }
      return "";
    };

    const formatTs = (iso) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (isNaN(d.getTime())) return null;
      return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    };

    const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

    const title = data?.name?.trim() && data.name.trim() !== "New conversation" ? data.name.trim() : "Claude conversation";
    let markdown = [
      "---",
      `title: ${yamlStr(title)}`,
      `agent: "Claude"`,
      `exported: ${new Date().toISOString().slice(0, 10)}`,
      `source: ${yamlStr(window.location.href)}`,
    ];
    if (data?.model) markdown.push(`model: ${yamlStr(data.model)}`);
    markdown.push("---", "");
    let body = markdown.join("\n") + "\n";
    let count = 0;

    for (const m of ordered) {
      const parts = [];
      for (const block of m.content || []) {
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text.trim());
        else if (block.type === "tool_use") parts.push(renderToolUse(block));
      }
      const text = parts.filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      const who = m.sender === "human" ? "Human" : "Claude";
      const ts = formatTs(m.created_at);
      body += `${ts ? `# ${who} — ${ts}` : `# ${who}`}\n\n${text}\n\n`;
      count++;
    }

    if (!count) return { error: "No exportable content found in this conversation." };
    return { title, markdown: body };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// Reads the conversation from ChatGPT's internal backend API: fetches a
// session access token, then the conversation's node graph, and walks the
// current branch from `current_node` back to the root.
async function exportChatGPT() {
  try {
    const conversationId = window.location.pathname.split("/").filter(Boolean).pop();
    if (!conversationId || conversationId.length < 20) {
      return { error: "Open a specific ChatGPT conversation first." };
    }

    const sessionRes = await fetch("/api/auth/session", { credentials: "include" });
    if (!sessionRes.ok) return { error: `Couldn't read your ChatGPT session (HTTP ${sessionRes.status}) — are you signed in?` };
    const session = await sessionRes.json();
    const token = session?.accessToken;
    if (!token) return { error: "Couldn't get a ChatGPT access token — are you signed in?" };

    const convoRes = await fetch(`/backend-api/conversation/${conversationId}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!convoRes.ok) return { error: `ChatGPT API request failed (HTTP ${convoRes.status}).` };
    const data = await convoRes.json();

    const mapping = data?.mapping;
    if (!mapping) return { error: "Unexpected ChatGPT API response — no conversation data." };

    // Walk from the current leaf node back to the root via `parent`, reverse
    // to get conversation order — same approach as the Claude exporter.
    let ordered = [];
    let nodeId = data.current_node;
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      ordered.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    ordered.reverse();

    const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const title = (data?.title || "").trim() || "ChatGPT conversation";
    let markdown = [
      "---",
      `title: ${yamlStr(title)}`,
      `agent: "ChatGPT"`,
      `exported: ${new Date().toISOString().slice(0, 10)}`,
      `source: ${yamlStr(window.location.href)}`,
    ];
    if (data?.model_slug) markdown.push(`model: ${yamlStr(data.model_slug)}`);
    markdown.push("---", "");
    let body = markdown.join("\n") + "\n";
    let count = 0;

    for (const node of ordered) {
      const msg = node.message;
      if (!msg) continue;
      const role = msg.author?.role;
      if (role !== "user" && role !== "assistant") continue; // skip system/tool nodes
      const contentType = msg.content?.content_type;
      let text = "";
      if (contentType === "text" && Array.isArray(msg.content.parts)) {
        text = msg.content.parts.filter((p) => typeof p === "string").join("\n\n").trim();
      } else if (contentType === "code" && typeof msg.content.text === "string") {
        text = "```\n" + msg.content.text + "\n```";
      }
      if (!text) continue;

      const who = role === "user" ? "Human" : "ChatGPT";
      const created = msg.create_time ? new Date(msg.create_time * 1000) : null;
      const ts = created && !isNaN(created.getTime())
        ? created.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
        : null;
      body += `${ts ? `# ${who} — ${ts}` : `# ${who}`}\n\n${text}\n\n`;
      count++;
    }

    if (!count) return { error: "No exportable content found in this conversation." };
    return { title, markdown: body };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// NEW in v2.0.0 — UNVERIFIED against a live session, first draft only.
// Selector strategy incorporates Gemini's own description of its DOM
// (asked directly, Sept 2026) on top of the original guesswork: turns are
// paired inside <conversation-turn>, code renders in a custom <code-block>
// element (possibly behind an open shadow root — the walker below pierces
// shadowRoot when present), and long conversations can lazy-unmount
// off-screen turns, hence the scroll pre-pass. All of that is still a
// model's self-description, not verified ground truth — if this comes back
// with "Found 0 conversation turns", open devtools and check what's
// actually there now.
async function exportGemini() {
  try {
    // Force lazy-loaded/virtualized turns into the DOM before reading, per
    // Gemini's own note that off-screen turns can unmount on long chats.
    const originalScroll = window.scrollY;
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 600));
    window.scrollTo(0, originalScroll);
    await new Promise((r) => setTimeout(r, 200));

    // Prefer the <conversation-turn> wrapper so user/model pairs stay in
    // their actual order even if the page ever interleaves them oddly;
    // fall back to querying the two message types directly if that
    // wrapper doesn't exist.
    const turnWrappers = Array.from(document.querySelectorAll("conversation-turn"));
    const allTurns = turnWrappers.length
      ? turnWrappers.flatMap((t) => Array.from(t.querySelectorAll("user-query, model-response")))
      : Array.from(document.querySelectorAll("user-query, model-response"));

    if (!allTurns.length) {
      return { error: "Found 0 conversation turns — Gemini's page structure has likely changed since this exporter was written. Open devtools and check what element wraps a user/model message pair now." };
    }

    // Self-contained HTML -> Markdown converter (can't be shared with
    // other exporters — see the note above on why every injected function
    // duplicates its own copy of helpers like this instead).
    // Pierces an open shadowRoot when present, since Gemini's <code-block>
    // may render its content that way rather than as plain light-DOM children.
    const htmlToMarkdown = (root) => {
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const tag = node.tagName.toLowerCase();
        // Confirmed via live inspection (Sept 2026): Gemini's follow-up
        // suggestion chips ("Get a complete DOM-to-Markdown parser script",
        // etc.) live inside a <elicitations> element, whose own container
        // carries a "hide-from-message-actions" attribute — Google's own
        // code marking it as not part of the actual message. Drop it entirely.
        if (tag === "elicitations" || node.hasAttribute("hide-from-message-actions") || node.classList?.contains("elicitations-container")) {
          return "";
        }
        const childRoot = node.shadowRoot || node;
        const kids = () => Array.from(childRoot.childNodes).map(walk).join("");
        switch (tag) {
          case "br": return "\n";
          case "p": return kids().trim() + "\n\n";
          case "strong": case "b": return `**${kids()}**`;
          case "em": case "i": return `*${kids()}*`;
          case "h1": return `# ${kids().trim()}\n\n`;
          case "h2": return `## ${kids().trim()}\n\n`;
          case "h3": return `### ${kids().trim()}\n\n`;
          case "h4": case "h5": case "h6": return `#### ${kids().trim()}\n\n`;
          case "a": {
            const href = node.getAttribute("href") || "";
            const text = kids().trim();
            return href ? `[${text}](${href})` : text;
          }
          case "code": {
            if (node.parentElement && node.parentElement.tagName.toLowerCase() === "pre") return kids();
            return `\`${kids()}\``;
          }
          case "pre": {
            const codeEl = node.querySelector("code");
            const langMatch = codeEl?.className?.match(/language-(\S+)/);
            const lang = langMatch ? langMatch[1] : "";
            return `\`\`\`${lang}\n${(codeEl || node).textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
          }
          // Gemini-specific: code/ASCII diagrams can render inside this
          // custom element instead of a plain <pre><code>.
          case "code-block": {
            const searchRoot = node.shadowRoot || node;
            const codeEl = searchRoot.querySelector("code, pre") || node;
            const lang = node.getAttribute("data-language") || node.getAttribute("language") ||
              (codeEl.className && codeEl.className.match(/language-(\S+)/)?.[1]) || "";
            const text = (codeEl.textContent || "").replace(/\n$/, "");
            return `\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
          }
          case "ul": return Array.from(childRoot.children).map((li) => `- ${walk(li).trim()}`).join("\n") + "\n\n";
          case "ol": return Array.from(childRoot.children).map((li, i) => `${i + 1}. ${walk(li).trim()}`).join("\n") + "\n\n";
          case "li": return kids();
          case "blockquote": return kids().trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
          case "table": {
            const rows = Array.from(node.querySelectorAll("tr")).map((tr) =>
              Array.from(tr.children).map((cell) => walk(cell).trim().replace(/\|/g, "\\|"))
            );
            if (!rows.length) return "";
            const header = `| ${rows[0].join(" | ")} |`;
            const divider = `| ${rows[0].map(() => "---").join(" | ")} |`;
            const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`).join("\n");
            return `${header}\n${divider}\n${body}\n\n`;
          }
          default: return kids();
        }
      };
      return walk(root).replace(/\n{3,}/g, "\n\n").trim();
    };

    const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const rawTitle = document.title.replace(/\s*-\s*Gemini\s*$/i, "").trim();
    const title = rawTitle && rawTitle.toLowerCase() !== "gemini" ? rawTitle : "Gemini conversation";

    let body = ["---", `title: ${yamlStr(title)}`, `agent: "Gemini"`, `exported: ${new Date().toISOString().slice(0, 10)}`, `source: ${yamlStr(window.location.href)}`, "---", ""].join("\n") + "\n";
    let count = 0;

    for (const el of allTurns) {
      const isUser = el.tagName.toLowerCase() === "user-query";
      const textContainer = el.querySelector(".message-content, .query-text, .markdown, [class*='markdown']") || el;
      const text = isUser ? textContainer.textContent.trim() : htmlToMarkdown(textContainer);
      if (!text) continue;
      body += `# ${isUser ? "Human" : "Gemini"}\n\n${text}\n\n`;
      count++;
    }

    if (!count) return { error: "Found conversation turn elements, but couldn't extract any text from them — Gemini's internal markup for message content has likely changed." };
    return { title, markdown: body };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// NEW in v2.0.0 — UNVERIFIED against a live session, first draft only.
//
// Tries two independently-uncertain approaches so a wrong guess on one
// doesn't sink the whole export: first the internal API (unconfirmed
// endpoint/shape), then falls back to DOM scraping if that fails
// (unconfirmed selectors, but backed by real evidence this time — see
// below). Whichever path actually works, check the console output either
// way to see what happened on the other.
// NEW in v2.0.0 — UNVERIFIED against a live session, first draft only.
//
// Tries two independently-uncertain approaches so a wrong guess on one
// doesn't sink the whole export: first the internal API (unconfirmed
// endpoint/shape), then falls back to DOM scraping if that fails
// (unconfirmed selectors, but backed by real evidence — see below).
// Whichever path actually works, check the console output either way to
// see what happened on the other.
//
// IMPORTANT: tryApi/tryDom are declared INSIDE this function on purpose.
// scripting.executeScript only ships the one function passed to it into
// the target page — separate top-level functions aren't visible from
// inside the injected context, and calling one throws a ReferenceError
// that never surfaces cleanly (an early version of this file had that
// exact bug: DeepSeek's export failed instantly with no console output
// at all, because the crash happened before any of this file's own
// logging ever ran). Nested declarations avoid that; every exporter in
// this file follows the same fully-self-contained rule for the same reason.
async function exportDeepSeek() {
  // Adapted from how similar open-source DeepSeek exporters describe the
  // endpoint/auth — not confirmed against a real logged-in session.
  async function tryApi() {
    try {
      const chatSessionId = window.location.pathname.split("/").filter(Boolean).pop();
      if (!chatSessionId || chatSessionId.length < 8) {
        return { error: "Couldn't read a conversation ID from the URL." };
      }

      let token = null;
      try {
        const raw = localStorage.getItem("userToken");
        if (raw) {
          const parsed = JSON.parse(raw);
          token = parsed?.value || parsed?.token || (typeof parsed === "string" ? parsed : null);
        }
      } catch (e) {
        // fall through — token stays null, handled below
      }
      if (!token) return { error: "no auth token found in localStorage under 'userToken'." };

      const apiUrl = `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${chatSessionId}`;
      const res = await fetch(apiUrl, { credentials: "include", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { error: `API request failed (HTTP ${res.status}).` };
      const data = await res.json();
      console.log("[AIchat2MD] DeepSeek raw API response:", data);

      const messages =
        data?.data?.biz_data?.chat_messages || data?.data?.chat_messages ||
        data?.biz_data?.chat_messages || data?.chat_messages || null;
      if (!Array.isArray(messages)) return { error: "response wasn't in the expected shape (logged to console)." };
      if (!messages.length) return { error: "no messages in API response." };

      const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      const rawTitle = document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, "").trim();
      const title = rawTitle && rawTitle.toLowerCase() !== "deepseek" ? rawTitle : "DeepSeek conversation";
      let body = ["---", `title: ${yamlStr(title)}`, `agent: "DeepSeek"`, `exported: ${new Date().toISOString().slice(0, 10)}`, `source: ${yamlStr(window.location.href)}`, "---", ""].join("\n") + "\n";
      let count = 0;

      for (const m of messages) {
        const role = m.role || m.author_role;
        if (role !== "USER" && role !== "ASSISTANT" && role !== "user" && role !== "assistant") continue;
        const text = (m.content || m.text || "").trim();
        if (!text) continue;
        body += `# ${/user/i.test(role) ? "Human" : "DeepSeek"}\n\n${text}\n\n`;
        count++;
      }
      if (!count) return { error: "parsed API response but found no usable message text." };
      return { title, markdown: body };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  // DOM-scraping fallback. Two confirmed real details went into this (from
  // an actual working DeepSeek export userscript's source, not model
  // guesswork): DeepSeek strips UI chrome via "ds"-prefixed classes
  // (ds-flex, ds-icon, ds-icon-button, ds-button) before reading message
  // text, and there's a chain-of-thought "thinking" block distinct from the
  // final "response" for reasoning models — the two get concatenated here
  // rather than kept separate, a known simplification. Everything else
  // (which selector actually IS a message container) is still a guess, so
  // this sidesteps needing to know which class means "user" vs "assistant":
  // it assumes strict alternation starting with the user, same as basically
  // every non-group chat UI works, rather than trying to detect role from
  // styling.
  async function tryDom() {
    try {
      const originalScroll = window.scrollY;
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 300));
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 600));
      window.scrollTo(0, originalScroll);
      await new Promise((r) => setTimeout(r, 200));

      let nodes = Array.from(document.querySelectorAll('[class*="message"]'));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll('[class*="chat"] [class*="content"], [class*="bubble"]'));
      if (!nodes.length) {
        return { error: "found 0 message-like elements with any fallback selector — inspect the live page for what actually wraps a message." };
      }

      const CHROME_SELECTOR = "button, .ds-flex, .ds-icon, .ds-icon-button, .ds-button, svg";
      const cleanText = (el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll(CHROME_SELECTOR).forEach((chrome) => chrome.remove());
        return clone.textContent.replace(/\n{2,}/g, "\n").trim();
      };

      const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      const rawTitle = document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, "").trim();
      const title = rawTitle && rawTitle.toLowerCase() !== "deepseek" ? rawTitle : "DeepSeek conversation";
      let body = ["---", `title: ${yamlStr(title)}`, `agent: "DeepSeek"`, `exported: ${new Date().toISOString().slice(0, 10)}`, `source: ${yamlStr(window.location.href)}`, "---", ""].join("\n") + "\n";
      let count = 0;
      let nextIsUser = true; // conversations always open with the user

      for (const node of nodes) {
        const text = cleanText(node);
        if (!text) continue;
        body += `# ${nextIsUser ? "Human" : "DeepSeek"}\n\n${text}\n\n`;
        nextIsUser = !nextIsUser;
        count++;
      }

      if (!count) return { error: "found message-like elements but couldn't extract text from any of them." };
      return { title, markdown: body };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  const apiResult = await tryApi();
  if (!apiResult.error) return apiResult;
  console.warn("[AIchat2MD] DeepSeek API attempt failed, falling back to DOM scraping:", apiResult.error);
  const domResult = await tryDom();
  if (!domResult.error) return domResult;
  return { error: `Both DeepSeek export methods failed. API: ${apiResult.error} | DOM: ${domResult.error}` };
}

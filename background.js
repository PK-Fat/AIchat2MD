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
const DEFAULT_DOWNLOAD_ATTACHMENTS = true; // keep in sync with options.js

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

    const { downloadAttachments = DEFAULT_DOWNLOAD_ATTACHMENTS } = await browser.storage.local.get("downloadAttachments");

    const [injected] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: platform.func,
      args: [{ downloadAttachments }],
    });

    const value = injected && injected.result;
    if (!value) throw new Error("Got no result back from the page.");
    if (value.error) throw new Error(value.error);

    const filename = buildFilename(value.title);
    const mdResult = await saveFile(tab, { text: value.markdown, mime: "text/markdown" }, filename);
    if (mdResult.error) return mdResult;

    // Second download: the attachments ZIP, only when there's something in it.
    // Unzipped next to the .md, its _attachments/ folder is what the links
    // in the .md point at.
    const files = value.files || [];
    const failed = value.failed || [];
    if (failed.length) {
      console.warn("[AIchat2MD] Attachments not downloaded:", failed);
      notify("Some attachments weren't downloaded", `${failed.length} left as links or labels in the .md: ${failed.join(", ")}`.slice(0, 250));
    }
    if (!files.length) return mdResult;

    const zipName = filename.replace(/\.md$/, " - attachments.zip");
    const zipBytes = buildZip(files.map((f) => ({ path: `_attachments/${f.name}`, data: base64ToBytes(f.base64) })));
    const zipResult = await saveFile(tab, { bytes: zipBytes, mime: "application/zip" }, zipName);
    if (zipResult.error) {
      notify("Attachments not saved", `${filename} was saved, but the attachments ZIP wasn't: ${zipResult.error}`);
      return { ok: true, filename: `${filename} (attachments ZIP not saved)` };
    }
    return { ok: true, filename: `${filename} + ${zipName}` };
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
// `content` is { text, mime } or { bytes: Uint8Array, mime }.
async function saveFile(tab, content, filename) {
  const errors = [];
  const makeBlob = () => new Blob([content.bytes || content.text], { type: content.mime });

  for (const saveAs of [true, false]) {
    const blobUrl = URL.createObjectURL(makeBlob());
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
      args: [content.bytes ? { base64: bytesToBase64(content.bytes) } : { text: content.text }, content.mime, filename],
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
function pageDownload(payload, mime, filename) {
  try {
    let data = payload.text;
    if (payload.base64 != null) {
      const bin = atob(payload.base64);
      data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    }
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
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

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Minimal ZIP writer (store only, no compression — attachments are images
// and PDFs, which are already compressed). UTF-8 filenames (flag bit 11).
// Avoids pulling in a library for ~60 lines of format.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const name = enc.encode(path);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
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
async function exportClaude(opts = {}) {
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

    // --- Attachments (v2.1.0) -------------------------------------------
    // Format matches upstream claude-chat-exporter's describeAttachments():
    // images embed, documents link, audio/blobs are named, and text
    // extractions (.md/.docx/…) are inlined as a blockquote. New here: with
    // opts.downloadAttachments on, images and documents are fetched with
    // the signed-in session and returned as `files` for the background
    // script to ZIP, and the .md links point at _attachments/<name> instead
    // of claude.ai URLs (which only load while signed in). A file that
    // fails to download keeps its claude.ai link.
    const toAbsolute = (u) => {
      if (!u || typeof u !== "string") return null;
      try { return new URL(u, "https://claude.ai").href; } catch { return null; }
    };
    const meta = (...bits) => bits.filter(Boolean).join(" · ");
    const formatBytes = (n) => {
      if (n == null || isNaN(n)) return null;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };
    const files = [];
    const failed = [];
    const usedNames = new Set();
    const uniqueName = (raw) => {
      const clean = String(raw || "file").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "file";
      const dot = clean.lastIndexOf(".");
      const stem = dot > 0 ? clean.slice(0, dot) : clean;
      const ext = dot > 0 ? clean.slice(dot) : "";
      let name = clean;
      for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
      usedNames.add(name.toLowerCase());
      return name;
    };
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      // FileReader, not typed-array tricks: in Firefox the fetched data
      // belongs to the page, and touching its ArrayBuffer/Uint8Array from
      // injected extension code throws "Permission denied to access
      // property 'constructor'".
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
      fr.onerror = () => reject(fr.error || new Error("couldn't read file"));
      fr.readAsDataURL(blob);
    });
    const localLink = (name) => "_attachments/" + encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
    // Returns the link to use: local path if downloaded, else the remote URL.
    const fetchLocal = async (url, name) => {
      if (!url || !opts.downloadAttachments) return url;
      try {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (!blob.size) throw new Error("empty file");
        const base64 = await blobToBase64(blob);
        const finalName = uniqueName(name);
        files.push({ name: finalName, base64 });
        return localLink(finalName);
      } catch (e) {
        failed.push(`${name} (${e.message || e})`);
        return url;
      }
    };
    const escAlt = (s) => String(s).replace(/[[\]]/g, "\\$&");
    const describeAttachments = async (m) => {
      const parts = [];
      for (const f of m.files || []) {
        const name = f.file_name || "file";
        if (f.file_kind === "image") {
          const url = toAbsolute(f.preview_url || f.preview_asset?.url);
          const link = await fetchLocal(url, name);
          parts.push(link ? `**Attachment: ${name} · image**\n\n![${escAlt(name)}](${link})` : `**Attachment: ${name} · image**`);
        } else if (f.file_kind === "document") {
          const url = toAbsolute(f.document_asset?.url);
          // document_asset is Claude's PDF rendering of the upload.
          const saveAs = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
          const link = await fetchLocal(url, saveAs);
          const pages = f.document_asset?.page_count ?? f.page_count;
          const info = meta("document", pages ? `${pages} page${pages === 1 ? "" : "s"}` : null);
          parts.push(link ? `**Attachment: [${escAlt(name)}](${link}) · ${info}**` : `**Attachment: ${name} · ${info}**`);
        } else {
          parts.push(`**Attachment: ${meta(name, f.file_kind, formatBytes(f.size_bytes))}**`);
        }
      }
      for (const a of m.attachments || []) {
        const name = a.file_name || a.name || "attachment";
        let block = `**Attachment: ${meta(name, a.file_type, formatBytes(a.file_size))}**`;
        if (typeof a.extracted_content === "string" && a.extracted_content.trim()) {
          block += "\n\n" + a.extracted_content.trim();
        }
        parts.push(block.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n"));
      }
      return parts.join("\n\n");
    };
    // ----------------------------------------------------------------------

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
      const parts = [await describeAttachments(m)];
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
    return { title, markdown: body, files, failed };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// Reads the conversation from ChatGPT's internal backend API: fetches a
// session access token, then the conversation's node graph, and walks the
// current branch from `current_node` back to the root.
//
// v2.2.0: attachments + cleanup. File handling follows the approach in
// AI-Exporter by Gaurav Sisodia (MIT, github.com/sisodiabhumca/AI-Exporter):
//   - images are `image_asset_pointer` parts whose pointer is
//     `file-service://<id>` or `sediment://<id>`
//   - uploaded documents are listed in `metadata.attachments` ({ id, name })
//   - downloading is two steps: /backend-api/files/download/<id> returns
//     JSON with a temporary `download_url`, which serves the actual bytes
// Images ChatGPT generates arrive in hidden `tool` messages; they're shown
// at the start of the next ChatGPT turn. Tool calls (code execution, web
// search), hidden system messages and ChatGPT's interactive-layout markup
// (<box>, <row>, {@body …}, citation markers) are left out of the export.
async function exportChatGPT(opts = {}) {
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
    const authInit = { credentials: "include", headers: { Authorization: `Bearer ${token}` } };

    const convoRes = await fetch(`/backend-api/conversation/${conversationId}`, authInit);
    if (!convoRes.ok) return { error: `ChatGPT API request failed (HTTP ${convoRes.status}).` };
    const data = await convoRes.json();

    const mapping = data?.mapping;
    if (!mapping) return { error: "Unexpected ChatGPT API response — no conversation data." };

    let ordered = [];
    let nodeId = data.current_node;
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      ordered.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    ordered.reverse();

    // --- Shared attachment helpers (copied per exporter: injected functions
    // must be self-contained). Same output contract as exportClaude:
    // `files` = [{ name, base64 }] for the background script to ZIP,
    // `failed` = names left as links/labels. Off by default unless
    // opts.downloadAttachments is set.
    const files = [];
    const failed = [];
    const usedNames = new Set();
    const MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv" };
    const uniqueName = (raw) => {
      const clean = String(raw || "file").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 150) || "file";
      const dot = clean.lastIndexOf(".");
      const stem = dot > 0 ? clean.slice(0, dot) : clean;
      const ext = dot > 0 ? clean.slice(dot) : "";
      let name = clean;
      for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
      usedNames.add(name.toLowerCase());
      return name;
    };
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      // FileReader, not typed-array tricks: in Firefox the fetched data
      // belongs to the page, and touching its ArrayBuffer/Uint8Array from
      // injected extension code throws "Permission denied to access
      // property 'constructor'".
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
      fr.onerror = () => reject(fr.error || new Error("couldn't read file"));
      fr.readAsDataURL(blob);
    });
    const localLink = (name) => "_attachments/" + encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const escAlt = (s) => String(s).replace(/[[\]]/g, "\\$&");
    const formatBytes = (n) => {
      if (n == null || isNaN(n)) return null;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };
    const meta = (...bits) => bits.filter(Boolean).join(" · ");
    // Fetch a file's bytes, refusing responses that are obviously not the
    // file (a JSON or HTML error/redirect page saved as "photo.png").
    const fetchBytes = async (url, init, name) => {
      const r = await fetch(url, init);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (/json|html/.test(type) && !/\.(json|html?)$/i.test(name || "")) throw new Error(`got ${type} instead of the file`);
      const blob = await r.blob();
      if (!blob.size) throw new Error("empty file");
      return { blob, type };
    };
    // getBytes() -> { blob, type }. Returns { link, name }: link is the
    // local _attachments/ path when saved, else `remote` (may be null).
    const fetchLocal = async (rawName, getBytes, remote) => {
      if (!opts.downloadAttachments) return { link: remote || null, name: rawName };
      try {
        const { blob, type } = await getBytes();
        let name = rawName;
        if (!/\.[a-z0-9]{2,5}$/i.test(name) && MIME_EXT[type]) name += MIME_EXT[type];
        name = uniqueName(name);
        files.push({ name, base64: await blobToBase64(blob) });
        return { link: localLink(name), name };
      } catch (e) {
        failed.push(`${rawName} (${e.message || e})`);
        return { link: remote || null, name: rawName };
      }
    };
    const formatTs = (d) => (d && !isNaN(d.getTime())
      ? d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : null);
    const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    // ----------------------------------------------------------------------

    // Names/sizes for every uploaded file, so an image part can use its
    // real filename instead of an ID.
    const fileInfo = new Map();
    for (const node of ordered) {
      for (const a of node.message?.metadata?.attachments || []) {
        if (a?.id) fileInfo.set(a.id, a);
      }
    }

    const downloadFile = async (id, name) => {
      let lastErr = "no download_url";
      for (const path of [
        `/backend-api/files/download/${encodeURIComponent(id)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,
        `/backend-api/files/download/${encodeURIComponent(id)}`,
        `/backend-api/files/${encodeURIComponent(id)}/download`,
      ]) {
        let info;
        try {
          const r = await fetch(path, authInit);
          if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
          info = await r.json();
        } catch (e) {
          lastErr = e.message || String(e);
          continue;
        }
        if (!info?.download_url) { lastErr = info?.error_code || info?.status || "no download_url"; continue; }
        // Got a real link: its result (bytes or error) is the answer.
        const url = new URL(info.download_url, location.origin);
        const same = url.origin === location.origin;
        return await fetchBytes(url.href, same ? authInit : { credentials: "omit" }, name);
      }
      throw new Error(lastErr);
    };

    const renderedIds = new Set();
    const renderImage = async (part, generated) => {
      const m = String(part?.asset_pointer || "").match(/^(?:file-service|sediment):\/\/(.+)$/);
      if (!m) return "";
      const id = m[1];
      if (renderedIds.has(id)) return "";
      renderedIds.add(id);
      const known = fileInfo.get(id);
      const short = id.replace(/^file[-_]/, "").slice(0, 8);
      const baseName = known?.name || `${generated ? "generated-image" : "image"}-${short}`;
      const { link, name } = await fetchLocal(baseName, () => downloadFile(id, baseName), null);
      let out = `**Attachment: ${meta(name, generated ? "generated image" : "image")}**`;
      if (link) out += `\n\n![${escAlt(name)}](${link})`;
      const prompt = part.metadata?.dalle?.prompt;
      if (generated && prompt) out += `\n\n*Prompt: ${prompt.trim()}*`;
      return out;
    };
    const renderFile = async (a) => {
      if (!a?.id || renderedIds.has(a.id)) return "";
      renderedIds.add(a.id);
      const baseName = a.name || `file-${a.id.slice(-8)}`;
      const isImage = /^image\//.test(a.mime_type || "");
      const { link, name } = await fetchLocal(baseName, () => downloadFile(a.id, baseName), null);
      const info = meta(isImage ? "image" : a.mime_type, formatBytes(a.size));
      if (!link) return `**Attachment: ${meta(name, info)}**`;
      return isImage
        ? `**Attachment: ${meta(name, info)}**\n\n![${escAlt(name)}](${link})`
        : `**Attachment: [${escAlt(name)}](${link})${info ? ` · ${info}` : ""}**`;
    };

    // ChatGPT's citation markers (private-use characters wrapping
    // "cite", "turn0search3" etc.) and its interactive-layout markup.
    // Marker handling follows pionxzh/deepseek-exporter (MIT), which shares
    // code with the same author's chatgpt-exporter.
    const LAYOUT_TAG = /^(?:box|row|col|column|stack|grid|card|icon|divider|badge|list|list-item|title|text|checkbox|button|spacer|FileCite|Cite)$/;
    const stripLayout = (input) => {
      if (!/<(?:box|row|list|badge|title|checkbox|FileCite|Cite)\b|\{@body|\{#each/.test(input)) return input;
      const out = [];
      let inFence = false, depth = 0, skipEach = 0;
      for (const line of input.split("\n")) {
        const t = line.trim();
        if (/^(```|~~~)/.test(t)) { inFence = !inFence; out.push(depth ? t : line); continue; }
        if (inFence) { out.push(line); continue; }
        if (/^\{@body\b/.test(t)) continue;
        if (/^\{#each\b/.test(t)) { skipEach++; continue; }
        if (/^\{\/each\}/.test(t)) { skipEach = Math.max(0, skipEach - 1); continue; }
        if (skipEach) continue;
        const wasInside = depth > 0;
        let hadTag = false;
        let s = line.replace(/<\/?([A-Za-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?>/g, (tag, name) => {
          if (!LAYOUT_TAG.test(name)) return tag;
          hadTag = true;
          if (tag.startsWith("</")) { depth = Math.max(0, depth - 1); return ""; }
          if (tag.endsWith("/>")) return "";
          depth++;
          return name === "list-item" ? "- " : "";
        });
        if (!hadTag && !wasInside) { out.push(line); continue; }
        s = s.replace(/\{[^{}]*\}/g, "").trim();
        if (s) out.push(s);
        else if (out.length && out[out.length - 1] !== "") out.push("");
      }
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    };
    const cleanText = (s) => stripLayout(
      String(s)
        .replace(/[ \t]?\uE200[^\uE201]*\uE201/g, "")
        .replace(/[\uE203\uE204]/g, "")
    ).trim();

    const title = (data?.title || "").trim() || "ChatGPT conversation";
    let body = [
      "---",
      `title: ${yamlStr(title)}`,
      `agent: "ChatGPT"`,
      `exported: ${new Date().toISOString().slice(0, 10)}`,
      `source: ${yamlStr(window.location.href)}`,
    ];
    if (data?.model_slug) body.push(`model: ${yamlStr(data.model_slug)}`);
    body.push("---", "");
    body = body.join("\n") + "\n";
    let count = 0;
    let pendingImages = []; // generated images waiting for the next ChatGPT turn
    let pendingTime = null;

    const emit = (who, created, text) => {
      const ts = formatTs(created);
      body += `${ts ? `# ${who} — ${ts}` : `# ${who}`}\n\n${text}\n\n`;
      count++;
    };

    for (const node of ordered) {
      const msg = node.message;
      if (!msg) continue;
      if (msg.metadata?.is_visually_hidden_from_conversation) continue;
      const role = msg.author?.role;
      const contentType = msg.content?.content_type;
      const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
      const created = msg.create_time ? new Date(msg.create_time * 1000) : null;

      if (role === "tool") {
        for (const p of parts) {
          if (p?.content_type === "image_asset_pointer") {
            const img = await renderImage(p, true);
            if (img) { pendingImages.push(img); pendingTime = pendingTime || created; }
          }
        }
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;
      // Assistant messages addressed to a tool (python, web, …) are the
      // behind-the-scenes steps, not the reply.
      if (msg.recipient && msg.recipient !== "all") continue;
      if (contentType !== "text" && contentType !== "multimodal_text") continue;

      const out = [];
      if (role === "user") {
        for (const a of msg.metadata?.attachments || []) {
          // Images also appear as parts below; render those there instead.
          if (parts.some((p) => String(p?.asset_pointer || "").endsWith(a.id))) continue;
          const f = await renderFile(a);
          if (f) out.push(f);
        }
      } else if (pendingImages.length) {
        out.push(...pendingImages);
        pendingImages = [];
        pendingTime = null;
      }
      for (const p of parts) {
        if (typeof p === "string") { const t = cleanText(p); if (t) out.push(t); }
        else if (p?.content_type === "image_asset_pointer") { const img = await renderImage(p, role === "assistant"); if (img) out.push(img); }
        else if (typeof p?.text === "string") { const t = cleanText(p.text); if (t) out.push(t); }
      }
      const text = out.filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      emit(role === "user" ? "Human" : "ChatGPT", created, text);
    }
    if (pendingImages.length) emit("ChatGPT", pendingTime, pendingImages.join("\n\n"));

    if (!count) return { error: "No exportable content found in this conversation." };
    return { title, markdown: body, files, failed };
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

// DeepSeek: internal API first, DOM scraping as a fallback.
//
// v2.2.0 rewrite of the API path. Message structure, token parsing, branch
// ordering and file URLs follow pionxzh/deepseek-exporter (MIT,
// github.com/pionxzh/deepseek-exporter) and AI-Exporter (MIT). The v2.0.0
// version looked for message text in `content`, but DeepSeek stores each
// message as typed `fragments` — REQUEST (your text), RESPONSE (the answer),
// THINK, SEARCH, FILE, … — so it always fell through to the DOM scraper,
// which flattened formatting and mixed in search UI text.
//
// Attachments: listed in a message's `files` and in FILE fragments. Their
// paths (`/file?…`) live on DeepSeek's separate file service, which serves
// them without the login session. Images use the preview variant (`ty=p`)
// like the web app does; whether that's full resolution is unverified.
//
// IMPORTANT: tryApi/tryDom are declared INSIDE this function on purpose —
// scripting.executeScript only ships the one function passed to it, so a
// call to any other top-level function throws a ReferenceError in the page.
async function exportDeepSeek(opts = {}) {
  async function tryApi() {
    try {
      const chatSessionId = window.location.pathname.split("/").filter(Boolean).pop();
      if (!chatSessionId || chatSessionId.length < 8) {
        return { error: "Couldn't read a conversation ID from the URL." };
      }

      // localStorage "userToken" is usually JSON like {"value":"…"}, but
      // older/other builds store the bare string.
      const findToken = (v, d = 0) => {
        if (d > 3) return null;
        if (typeof v === "string") return v.trim() || null;
        if (!v || typeof v !== "object") return null;
        return findToken(v.value, d + 1) ?? findToken(v.token, d + 1) ?? findToken(v.access_token, d + 1) ?? findToken(v.accessToken, d + 1);
      };
      let token = null;
      try {
        const raw = localStorage.getItem("userToken");
        if (raw) { try { token = findToken(JSON.parse(raw)); } catch { token = raw.trim() || null; } }
      } catch { /* token stays null */ }
      if (!token) return { error: "no login token found in localStorage under 'userToken'." };

      const res = await fetch(`/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatSessionId)}`, {
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-platform": "web",
          "x-client-locale": (document.documentElement.lang || navigator.language || "en-US").replace("-", "_"),
        },
      });
      if (!res.ok) return { error: `API request failed (HTTP ${res.status}).` };
      const data = await res.json();
      if (data?.code != null && String(data.code) !== "0") return { error: `API error ${data.code}: ${data.msg || "unknown"}` };
      const biz = data?.data?.biz_data || data?.biz_data || {};
      const all = biz.chat_messages || biz.messages || [];
      if (!Array.isArray(all) || !all.length) {
        console.log("[AIchat2MD] DeepSeek raw API response:", data);
        return { error: "no messages in API response (logged to console)." };
      }

      // --- Shared attachment helpers (copied per exporter: injected functions
      // must be self-contained). Same output contract as exportClaude:
      // `files` = [{ name, base64 }] for the background script to ZIP,
      // `failed` = names left as links/labels. Off by default unless
      // opts.downloadAttachments is set.
      const files = [];
      const failed = [];
      const usedNames = new Set();
      const MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv" };
      const uniqueName = (raw) => {
        const clean = String(raw || "file").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 150) || "file";
        const dot = clean.lastIndexOf(".");
        const stem = dot > 0 ? clean.slice(0, dot) : clean;
        const ext = dot > 0 ? clean.slice(dot) : "";
        let name = clean;
        for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
        usedNames.add(name.toLowerCase());
        return name;
      };
      const blobToBase64 = (blob) => new Promise((resolve, reject) => {
        // FileReader, not typed-array tricks: in Firefox the fetched data
        // belongs to the page, and touching its ArrayBuffer/Uint8Array from
        // injected extension code throws "Permission denied to access
        // property 'constructor'".
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
        fr.onerror = () => reject(fr.error || new Error("couldn't read file"));
        fr.readAsDataURL(blob);
      });
      const localLink = (name) => "_attachments/" + encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
      const escAlt = (s) => String(s).replace(/[[\]]/g, "\\$&");
      const formatBytes = (n) => {
        if (n == null || isNaN(n)) return null;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
      };
      const meta = (...bits) => bits.filter(Boolean).join(" · ");
      // Fetch a file's bytes, refusing responses that are obviously not the
      // file (a JSON or HTML error/redirect page saved as "photo.png").
      const fetchBytes = async (url, init, name) => {
        const r = await fetch(url, init);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (/json|html/.test(type) && !/\.(json|html?)$/i.test(name || "")) throw new Error(`got ${type} instead of the file`);
        const blob = await r.blob();
        if (!blob.size) throw new Error("empty file");
        return { blob, type };
      };
      // getBytes() -> { blob, type }. Returns { link, name }: link is the
      // local _attachments/ path when saved, else `remote` (may be null).
      const fetchLocal = async (rawName, getBytes, remote) => {
        if (!opts.downloadAttachments) return { link: remote || null, name: rawName };
        try {
          const { blob, type } = await getBytes();
          let name = rawName;
          if (!/\.[a-z0-9]{2,5}$/i.test(name) && MIME_EXT[type]) name += MIME_EXT[type];
          name = uniqueName(name);
          files.push({ name, base64: await blobToBase64(blob) });
          return { link: localLink(name), name };
        } catch (e) {
          failed.push(`${rawName} (${e.message || e})`);
          return { link: remote || null, name: rawName };
        }
      };
      const formatTs = (d) => (d && !isNaN(d.getTime())
        ? d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
        : null);
      const yamlStr = (v) => '"' + String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      // ----------------------------------------------------------------------

      // Follow the branch on screen: current_message_id back via parent_id.
      const byId = new Map(all.map((m) => [String(m.message_id), m]));
      const toDate = (v) => {
        if (v == null) return null;
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) return new Date(n > 1e10 ? n : n * 1000);
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
      };
      let currentId = biz.chat_session?.current_message_id != null ? String(biz.chat_session.current_message_id) : "";
      if (!byId.has(currentId)) {
        const parents = new Set(all.map((m) => m.parent_id).filter((x) => x != null).map(String));
        const leaves = all.filter((m) => !parents.has(String(m.message_id)));
        const pick = (leaves.length ? leaves : all).slice().sort((a, b) => (toDate(a.inserted_at) || 0) - (toDate(b.inserted_at) || 0)).pop();
        currentId = pick ? String(pick.message_id) : "";
      }
      const ordered = [];
      const visited = new Set();
      while (currentId && !visited.has(currentId) && byId.has(currentId)) {
        visited.add(currentId);
        const m = byId.get(currentId);
        ordered.push(m);
        currentId = m.parent_id != null ? String(m.parent_id) : "";
      }
      ordered.reverse();

      const ftype = (f) => String(f?.type || "").toUpperCase();
      const visibleText = (m) => {
        const role = String(m.role || "").toUpperCase();
        const accepted = role === "USER" ? ["REQUEST"] : ["RESPONSE", "TEMPLATE_RESPONSE"];
        const frags = Array.isArray(m.fragments) ? m.fragments : [];
        const str = (f) => (typeof f?.content === "string" ? f.content.trim() : "");
        let parts = frags.filter((f) => accepted.includes(ftype(f))).map(str).filter(Boolean);
        if (!parts.length && typeof m.content === "string") parts = [m.content.trim()];
        if (!parts.length) {
          const skip = ["THINK", "TOOL_SEARCH", "TOOL_OPEN", "SEARCH", "TIP", "FILE", "READ_LINK"];
          parts = frags.filter((f) => !skip.includes(ftype(f))).map(str).filter(Boolean);
        }
        // Web-search citation markers like [citation:3] point at a search
        // panel that isn't exported.
        return parts.join("\n\n").replace(/\s?\[citation:\d+\]/g, "").trim();
      };

      const FILE_SERVICE = "https://files.deepseeksvc.com/api";
      const fileUrl = (f) => {
        const v = typeof f.signed_path === "string" ? f.signed_path : typeof f.url === "string" ? f.url : null;
        if (!v) return null;
        try {
          if (/^\/file(?:\?|$)/.test(v)) return new URL(FILE_SERVICE + v);
          return new URL(v, location.origin);
        } catch { return null; }
      };
      const isImage = (f) => f.is_image === true || /^image\//.test(f.mime_type || f.mimetype || "") ||
        /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(f.file_name || f.filename || f.name || "");
      const collectFiles = (m) => {
        const list = [...(Array.isArray(m.files) ? m.files : [])];
        for (const fr of m.fragments || []) {
          if (ftype(fr) !== "FILE") continue;
          if (Array.isArray(fr.files)) list.push(...fr.files);
          if (fr.file && typeof fr.file === "object") list.push(fr.file);
        }
        const seenF = new Set();
        return list.filter((f) => {
          const key = String(f.id ?? f.file_id ?? f.signed_path ?? f.url ?? f.file_name ?? Math.random());
          if (seenF.has(key)) return false;
          seenF.add(key);
          return true;
        });
      };
      const renderFiles = async (m) => {
        const out = [];
        for (const f of collectFiles(m)) {
          const baseName = f.file_name || f.filename || f.name || "attachment";
          const img = isImage(f);
          const url = fileUrl(f);
          if (url && img && url.hostname.includes("deepseeksvc") && !url.searchParams.has("ty")) url.searchParams.set("ty", "p");
          const sameOrigin = url && url.origin === location.origin;
          const init = sameOrigin
            ? { credentials: "include", headers: { Authorization: `Bearer ${token}`, Accept: "*/*" } }
            : { credentials: "omit" };
          const { link, name } = url
            ? await fetchLocal(baseName, () => fetchBytes(url.href, init, baseName), url.href)
            : { link: null, name: baseName };
          if (!url && opts.downloadAttachments) failed.push(`${baseName} (no file URL)`);
          const size = formatBytes(f.size ?? f.file_size);
          if (img) {
            out.push(`**Attachment: ${meta(name, "image", size)}**` + (link ? `\n\n![${escAlt(name)}](${link})` : ""));
          } else {
            out.push(link ? `**Attachment: [${escAlt(name)}](${link})${size ? ` · ${size}` : ""}**` : `**Attachment: ${meta(name, size)}**`);
          }
        }
        return out;
      };

      const rawTitle = (biz.chat_session?.title || "").trim() ||
        document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, "").trim();
      const title = rawTitle && rawTitle.toLowerCase() !== "deepseek" ? rawTitle : "DeepSeek conversation";
      let body = ["---", `title: ${yamlStr(title)}`, `agent: "DeepSeek"`, `exported: ${new Date().toISOString().slice(0, 10)}`, `source: ${yamlStr(window.location.href)}`];
      const model = ordered.find((m) => m.model)?.model;
      if (model) body.push(`model: ${yamlStr(model)}`);
      body.push("---", "");
      body = body.join("\n") + "\n";
      let count = 0;

      for (const m of ordered) {
        const role = String(m.role || "").toUpperCase();
        if (role !== "USER" && role !== "ASSISTANT") continue;
        const parts = [...(await renderFiles(m)), visibleText(m)].filter(Boolean);
        if (!parts.length) continue;
        const who = role === "USER" ? "Human" : "DeepSeek";
        const ts = formatTs(toDate(m.inserted_at));
        body += `${ts ? `# ${who} — ${ts}` : `# ${who}`}\n\n${parts.join("\n\n")}\n\n`;
        count++;
      }
      if (!count) return { error: "parsed API response but found no usable message text." };
      return { title, markdown: body, files, failed };
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

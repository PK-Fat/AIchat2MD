const DEFAULT_MODE = "toolbar";
const radios = document.querySelectorAll('input[name="uiMode"]');

(async () => {
  const { uiMode = DEFAULT_MODE } = await browser.storage.local.get("uiMode");
  for (const r of radios) r.checked = r.value === uiMode;
})();

for (const r of radios) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    await browser.storage.local.set({ uiMode: r.value });
    // The sidebar can stay open on its own (you can toggle it manually via
    // Firefox's sidebar picker, separate from our toolbar button) — so
    // switching to toolbar mode should also close it if it's currently open,
    // rather than leaving a stale panel sitting there.
    if (r.value === "toolbar") {
      const isOpen = await browser.sidebarAction.isOpen({});
      if (isOpen) await browser.sidebarAction.close();
    }
  });
}

// v2.1.0: attachments ZIP toggle. Default must match background.js.
const DEFAULT_DOWNLOAD_ATTACHMENTS = true;
const attachBox = document.getElementById("downloadAttachments");
(async () => {
  const { downloadAttachments = DEFAULT_DOWNLOAD_ATTACHMENTS } = await browser.storage.local.get("downloadAttachments");
  attachBox.checked = downloadAttachments;
})();
attachBox.addEventListener("change", () => browser.storage.local.set({ downloadAttachments: attachBox.checked }));

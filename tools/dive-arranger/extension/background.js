// MV3 service worker: the toolbar action just asks the page's content script
// to open the arranger overlay. All real work happens in the tab (content
// script + main-world wasm client); nothing token-related passes through here.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url || !tab.url.startsWith("https://app.motherduck.com/")) return;
  chrome.tabs.sendMessage(tab.id, { type: "dive-arranger:open" }).catch(() => {
    // No content script in the tab (e.g. extension just reloaded) — ignore.
  });
});

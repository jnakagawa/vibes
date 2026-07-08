(() => {
  // extension/background.js
  chrome.action.onClicked.addListener((tab) => {
    if (!tab.id || !tab.url || !tab.url.startsWith("https://app.motherduck.com/")) return;
    chrome.tabs.sendMessage(tab.id, { type: "dive-arranger:open" }).catch(() => {
    });
  });
})();

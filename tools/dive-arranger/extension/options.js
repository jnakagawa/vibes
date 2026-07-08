const $ = (id) => document.getElementById(id);

chrome.storage.local.get("mdToken").then(({ mdToken }) => {
  if (mdToken) {
    $("status").textContent = `A token is saved (…${mdToken.slice(-6)}).`;
  }
});

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) {
    $("status").textContent = "Nothing to save.";
    return;
  }
  await chrome.storage.local.set({ mdToken: token });
  $("token").value = "";
  $("status").textContent = `Saved (…${token.slice(-6)}).`;
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("mdToken");
  $("status").textContent = "Cleared.";
});

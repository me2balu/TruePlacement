// background.js — MV3 service worker.
//
// Registers a right-click "Check with TruePlacement" context menu item that
// opens the native side panel and auto-analyzes the selection there. Also
// keeps a small badge counter of postings flagged fraudulent today.
//
// chrome.sidePanel.open() must be called synchronously inside a trusted
// user-gesture callback — any `await` before it can silently invalidate the
// gesture and make the call throw. It's called first here, with nothing
// awaited before it.

const CONTEXT_MENU_ID = "trueplacement-check-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Check "%s" with TruePlacement',
    contexts: ["selection"],
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshBadgeForToday();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = info.selectionText || "";
  if (!text.trim() || !tab || tab.windowId == null) return;

  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});

  chrome.storage.session.set({ pendingText: text, pendingAutoAnalyze: true, pendingAt: Date.now() });

  // If the side panel is already open, opening it again just focuses it --
  // it does not reload, so it never re-reads session storage. Push the
  // text directly so an already-open panel updates immediately too.
  chrome.runtime
    .sendMessage({ type: "trueplacement:pending-text", text, autoAnalyze: true })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From the in-page compact card's "Show full report" button. Opening the
  // side panel has to be the first thing this listener does — nothing
  // awaited beforehand — for the same trusted-gesture reason noted above.
  if (message && message.type === "trueplacement:open-full-report") {
    const text = (message.text || "").trim();
    if (text && sender.tab && sender.tab.windowId != null) {
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      chrome.storage.session.set({ pendingText: text, pendingAutoAnalyze: true, pendingAt: Date.now() });

      // Same fix as above: if the panel is already open, this message is
      // what actually delivers the text -- the storage write alone won't
      // be noticed until the panel is closed and reopened.
      chrome.runtime
        .sendMessage({ type: "trueplacement:pending-text", text, autoAnalyze: true })
        .catch(() => {});
    }
    return;
  }

  if (message && message.type === "trueplacement:record-result") {
    recordResult(message.isFraud)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("Error recording result:", err);
        sendResponse({ error: err.message });
      });
    return true;
  }
  return undefined;
});

// ---- messages from the TruePlacement website (see manifest.json's
// "externally_connectable") ----------------------------------------------
// A webpage button can ping this extension and ask it to open its side
// panel. Note: chrome.sidePanel.open() normally requires a trusted user
// gesture in the SAME call stack that received it -- a gesture on a webpage
// does not transfer across the runtime.sendMessage boundary into this
// service worker, so this call can still throw even though the page's
// click was genuine. We report success/failure back to the page either way
// so its UI can fall back to "click the toolbar icon" instead of lying
// about what happened.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  if (message.type === "TP_PING") {
    sendResponse({ installed: true, version: chrome.runtime.getManifest().version });
    return;
  }

  if (message.type === "TP_OPEN_PANEL") {
    if (!sender.tab || sender.tab.windowId == null) {
      sendResponse({ opened: false, error: "no window context" });
      return;
    }
    chrome.sidePanel
      .open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ opened: true }))
      .catch((err) => sendResponse({ opened: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  return undefined;
});

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function recordResult(isFraud) {
  const { badgeDay, badgeCount } = await chrome.storage.local.get(["badgeDay", "badgeCount"]);
  const key = todayKey();
  let count = badgeDay === key ? badgeCount || 0 : 0;
  if (isFraud) count += 1;
  await chrome.storage.local.set({ badgeDay: key, badgeCount: count });
  paintBadge(count);
}

async function refreshBadgeForToday() {
  const { badgeDay, badgeCount } = await chrome.storage.local.get(["badgeDay", "badgeCount"]);
  const key = todayKey();
  paintBadge(badgeDay === key ? badgeCount || 0 : 0);
}

function paintBadge(count) {
  chrome.action.setBadgeBackgroundColor({ color: "#c0384a" });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}
"use strict";

const DEFAULT_GROUPS = ["Công việc", "Dự án GitHub", "Cá nhân", "Khẩn cấp"];
const FLOATING_WIN_WIDTH = 920;
const FLOATING_WIN_HEIGHT = 700;

function applyActionLaunchMode(launchMode) {
  if (!chrome.action || typeof chrome.action.setPopup !== "function") {
    return;
  }
  const useAttachedPopup = launchMode !== "window";
  chrome.action.setPopup(
    { popup: useAttachedPopup ? "popup.html" : "" },
    () => {
      void (chrome.runtime && chrome.runtime.lastError);
    }
  );
  if (typeof chrome.action.setTitle === "function") {
    chrome.action.setTitle(
      {
        title: useAttachedPopup
          ? "GitTask Sync (Popup gắn thanh công cụ)"
          : "GitTask Sync (Nhấn để mở Cửa sổ nổi)"
      },
      () => {
        void (chrome.runtime && chrome.runtime.lastError);
      }
    );
  }
}

function openOrFocusFloatingWindow(sendResponse) {
  const targetUrl = chrome.runtime.getURL("popup.html?mode=window");

  chrome.storage.local.get(["floatingWindowId"], (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      stored = {};
    }
    const savedId =
      stored && typeof stored.floatingWindowId === "number" ? stored.floatingWindowId : null;

    const createFreshWindow = () => {
      chrome.windows.create(
        {
          url: targetUrl,
          type: "popup",
          width: FLOATING_WIN_WIDTH,
          height: FLOATING_WIN_HEIGHT,
          focused: true
        },
        (createdWin) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            if (typeof sendResponse === "function") {
              sendResponse({ ok: false });
            }
            return;
          }
          const winId = createdWin && typeof createdWin.id === "number" ? createdWin.id : null;
          if (winId !== null) {
            chrome.storage.local.set({ floatingWindowId: winId }, () => {
              void (chrome.runtime && chrome.runtime.lastError);
            });
          }
          if (typeof sendResponse === "function") {
            sendResponse({ ok: true, windowId: winId, reused: false });
          }
        }
      );
    };

    if (savedId !== null) {
      chrome.windows.get(savedId, (existingWin) => {
        if ((chrome.runtime && chrome.runtime.lastError) || !existingWin) {
          createFreshWindow();
          return;
        }
        chrome.windows.update(savedId, { focused: true }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            createFreshWindow();
            return;
          }
          if (typeof sendResponse === "function") {
            sendResponse({ ok: true, windowId: savedId, reused: true });
          }
        });
      });
    } else {
      createFreshWindow();
    }
  });
}

function syncLaunchModeFromStorage() {
  chrome.storage.local.get(["uiPrefs"], (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      applyActionLaunchMode("popup");
      return;
    }
    const mode =
      stored && stored.uiPrefs && stored.uiPrefs.launchMode === "window" ? "window" : "popup";
    applyActionLaunchMode(mode);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["tasks", "groups", "syncMeta", "uiPrefs"], (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      return;
    }

    const safeStored = stored || {};
    const updates = {};

    if (!Array.isArray(safeStored.tasks)) {
      updates.tasks = [];
    }

    if (!Array.isArray(safeStored.groups) || safeStored.groups.length === 0) {
      updates.groups = DEFAULT_GROUPS;
    }

    if (!safeStored.syncMeta || typeof safeStored.syncMeta !== "object") {
      updates.syncMeta = {
        base_sha: null,
        lastSyncAt: null,
        syncedRepoKey: null,
        dirty: false
      };
    }

    const currentLaunchMode =
      safeStored.uiPrefs && safeStored.uiPrefs.launchMode === "window" ? "window" : "popup";
    applyActionLaunchMode(currentLaunchMode);

    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates, () => {
        void (chrome.runtime && chrome.runtime.lastError);
      });
    }
  });
});

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    syncLaunchModeFromStorage();
  });
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.uiPrefs && changes.uiPrefs.newValue) {
      const nextMode = changes.uiPrefs.newValue.launchMode === "window" ? "window" : "popup";
      applyActionLaunchMode(nextMode);
    }
  });
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    openOrFocusFloatingWindow();
  });
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.local.get(["floatingWindowId"], (stored) => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      if (stored && stored.floatingWindowId === closedWindowId) {
        chrome.storage.local.remove(["floatingWindowId"], () => {
          void (chrome.runtime && chrome.runtime.lastError);
        });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "OPEN_FLOATING_WINDOW") {
    openOrFocusFloatingWindow(sendResponse);
    return true;
  }
  return false;
});

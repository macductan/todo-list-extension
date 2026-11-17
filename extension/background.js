"use strict";

const DEFAULT_GROUPS = ["Công việc", "Dự án GitHub", "Cá nhân", "Khẩn cấp"];
const FLOATING_WIN_WIDTH = 920;
const FLOATING_WIN_HEIGHT = 700;
const NATIVE_UPDATER_HOST = "com.gittask.updater";

function applyActionLaunchMode(launchMode) {
  if (!chrome.action || typeof chrome.action.setPopup !== "function") {
    return;
  }
  const useAttachedPopup = launchMode === "popup";
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

function clearSavedFloatingWindowId() {
  if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.remove !== "function") {
    return;
  }
  chrome.storage.local.remove(["floatingWindowId"], () => {
    void (chrome.runtime && chrome.runtime.lastError);
  });
}

function openOrFocusFloatingWindow(sendResponse) {
  const targetUrl = chrome.runtime.getURL("popup.html?mode=window");

  chrome.storage.local.get(["floatingWindowId"], (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      stored = {};
    }
    const savedId =
      stored && typeof stored.floatingWindowId === "number" ? stored.floatingWindowId : null;

    const createFreshWindow = (bounds) => {
      const baseOpts = {
        url: targetUrl,
        type: "popup",
        width:
          bounds && typeof bounds.width === "number" && bounds.width >= 320
            ? Math.round(bounds.width)
            : FLOATING_WIN_WIDTH,
        height:
          bounds && typeof bounds.height === "number" && bounds.height >= 240
            ? Math.round(bounds.height)
            : FLOATING_WIN_HEIGHT,
        focused: true
      };
      const createOpts = Object.assign({}, baseOpts);
      let hasExplicitPos = false;
      if (
        bounds &&
        typeof bounds.left === "number" &&
        Number.isFinite(bounds.left) &&
        bounds.left >= 0
      ) {
        createOpts.left = Math.round(bounds.left);
        hasExplicitPos = true;
      }
      if (
        bounds &&
        typeof bounds.top === "number" &&
        Number.isFinite(bounds.top) &&
        bounds.top >= 0
      ) {
        createOpts.top = Math.round(bounds.top);
        hasExplicitPos = true;
      }

      const onWindowCreated = (createdWin) => {
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
      };

      chrome.windows.create(createOpts, (createdWin) => {
        if (chrome.runtime && chrome.runtime.lastError && hasExplicitPos) {
          chrome.windows.create(baseOpts, onWindowCreated);
          return;
        }
        onWindowCreated(createdWin);
      });
    };

    if (savedId !== null) {
      chrome.windows.get(savedId, { populate: true }, (existingWin) => {
        const isMatchingExtPopup =
          !(chrome.runtime && chrome.runtime.lastError) &&
          existingWin &&
          existingWin.type === "popup" &&
          Array.isArray(existingWin.tabs) &&
          existingWin.tabs.some((t) => t && (t.url === targetUrl || t.pendingUrl === targetUrl));

        if (!isMatchingExtPopup) {
          clearSavedFloatingWindowId();
          createFreshWindow();
          return;
        }

        if (existingWin.state === "minimized" || !existingWin.focused) {
          const bounds = {
            width: existingWin.width,
            height: existingWin.height,
            left: existingWin.left,
            top: existingWin.top
          };
          chrome.windows.remove(savedId, () => {
            void (chrome.runtime && chrome.runtime.lastError);
            clearSavedFloatingWindowId();
            createFreshWindow(bounds);
          });
          return;
        }

        chrome.windows.update(savedId, { focused: true }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            clearSavedFloatingWindowId();
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

function resolvePreferredLaunchMode(uiPrefs) {
  return uiPrefs && uiPrefs.preferredLaunchMode === "popup" ? "popup" : "window";
}

function syncLaunchModeFromStorage() {
  chrome.storage.local.get(["uiPrefs"], (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      applyActionLaunchMode("window");
      return;
    }
    applyActionLaunchMode(resolvePreferredLaunchMode(stored && stored.uiPrefs));
  });
}

chrome.runtime.onInstalled.addListener(() => {
  clearSavedFloatingWindowId();
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

    applyActionLaunchMode(resolvePreferredLaunchMode(safeStored.uiPrefs));

    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates, () => {
        void (chrome.runtime && chrome.runtime.lastError);
      });
    }
  });
});

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    clearSavedFloatingWindowId();
    syncLaunchModeFromStorage();
  });
}

syncLaunchModeFromStorage();

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.uiPrefs && changes.uiPrefs.newValue) {
      applyActionLaunchMode(resolvePreferredLaunchMode(changes.uiPrefs.newValue));
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
  if (message && message.type === "NATIVE_UPDATER") {
    const action = message.action === "git_pull" ? "git_pull" : "ping";
    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== "function") {
      sendResponse({
        ok: false,
        nativeHostMissing: true,
        error: "Trình duyệt chưa hỗ trợ Native Messaging hoặc thiếu quyền nativeMessaging."
      });
      return false;
    }
    chrome.runtime.sendNativeMessage(NATIVE_UPDATER_HOST, { action }, (resp) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err || !resp) {
        sendResponse({
          ok: false,
          nativeHostMissing: true,
          error: (err && err.message) || "Không thể kết nối tới Native Messaging Host."
        });
        return;
      }
      if (action === "git_pull" && resp.ok && resp.updated) {
        const notice = {
          fromCommit: String(resp.beforeCommit || ""),
          toCommit: String(resp.afterCommit || ""),
          subject: String(resp.latestSubject || ""),
          at: Date.now()
        };
        chrome.storage.local.set({ lastExtUpdateNotice: notice }, () => {
          void (chrome.runtime && chrome.runtime.lastError);
          sendResponse(resp);
          if (!message.skipAutoReload) {
            setTimeout(() => {
              chrome.runtime.reload();
            }, 700);
          }
        });
        return;
      }
      sendResponse(resp);
    });
    return true;
  }
  if (message && message.type === "RELOAD_EXTENSION") {
    sendResponse({ ok: true });
    setTimeout(() => {
      chrome.runtime.reload();
    }, 100);
    return false;
  }
  return false;
});

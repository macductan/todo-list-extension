(function () {
  "use strict";

  const DEFAULT_GROUPS = ["Công việc", "Dự án GitHub", "Cá nhân", "Khẩn cấp"];
  const VALID_PRIORITIES = ["none", "low", "medium", "high"];
  const PRIORITY_ORDER = ["high", "medium", "low", "none"];
  const PRIO_WEIGHT = { high: 3, medium: 2, low: 1, none: 0 };
  const PRIORITY_META = {
    high: { badgeLabel: "High", sectionLabel: "Ưu tiên Cao (High)", pillLabel: "High" },
    medium: { badgeLabel: "Medium", sectionLabel: "Ưu tiên Trung bình (Medium)", pillLabel: "Medium" },
    low: { badgeLabel: "Low", sectionLabel: "Ưu tiên Thấp (Low)", pillLabel: "Low" },
    none: { badgeLabel: "Không ưu tiên", sectionLabel: "Không ưu tiên", pillLabel: "Không ưu tiên" }
  };
  const MAX_IMAGE_COUNT_PER_TASK = 6;
  const MAX_SAFE_REMOTE_BYTES = 8 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 15000;
  const ALLOWED_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif"
  ]);

  /* ========================================================================
     1. CHROME.STORAGE.LOCAL WRAPPER
     ======================================================================== */
  const ChromeStorage = {
    get(keys) {
      return new Promise((resolve, reject) => {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
          reject(new Error("API chrome.storage.local không khả dụng."));
          return;
        }
        chrome.storage.local.get(keys, (items) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "Lỗi đọc dữ liệu cục bộ."));
            return;
          }
          resolve(items || {});
        });
      });
    },

    set(items) {
      return new Promise((resolve, reject) => {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
          reject(new Error("API chrome.storage.local không khả dụng."));
          return;
        }
        chrome.storage.local.set(items, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(
              new Error(
                "Không thể lưu vào chrome.storage.local (có thể vượt giới hạn dung lượng lưu trữ)."
              )
            );
            return;
          }
          resolve();
        });
      });
    }
  };

  /* ========================================================================
     2. ENCODING, VALIDATION & XSS-SAFE HELPERS
     ======================================================================== */
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(""));
  }

  function base64ToUtf8(base64Str) {
    const clean = String(base64Str || "").replace(/\s+/g, "");
    if (!clean) return "";
    let binary;
    try {
      binary = atob(clean);
    } catch (_) {
      throw new Error("Dữ liệu Base64 trả về từ GitHub không hợp lệ.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function isSafeImageDataUrl(url) {
    if (typeof url !== "string") return false;
    return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url.trim());
  }

  function generateTaskId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "task-" + crypto.randomUUID();
    }
    return "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  function sanitizeTaskRecord(raw, fallbackIndex) {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const rawId = typeof src.id === "string" ? src.id.trim() : "";
    const rawTitle = typeof src.title === "string" ? src.title.trim() : "";
    const rawDesc = typeof src.description === "string" ? src.description : "";
    const rawGroup = typeof src.group === "string" ? src.group.trim() : "";
    const rawPrio = typeof src.priority === "string" ? src.priority.trim().toLowerCase() : "none";
    const rawStatus = typeof src.status === "string" ? src.status.trim().toLowerCase() : "todo";
    const rawUpdated =
      typeof src.updatedAt === "string" && src.updatedAt.trim()
        ? src.updatedAt.trim()
        : new Date().toISOString();

    const cleanTask = {
      id: rawId || `task-imported-${Date.now()}-${fallbackIndex || 0}`,
      title: rawTitle || "Công việc không tiêu đề",
      description: rawDesc,
      group: rawGroup || "Công việc",
      priority: VALID_PRIORITIES.includes(rawPrio) ? rawPrio : "none",
      status: rawStatus === "done" ? "done" : "todo",
      updatedAt: rawUpdated
    };

    if (Array.isArray(src.images)) {
      const validImages = src.images
        .filter((img) => img && typeof img === "object" && isSafeImageDataUrl(img.dataUrl))
        .slice(0, MAX_IMAGE_COUNT_PER_TASK)
        .map((img, i) => ({
          id:
            typeof img.id === "string" && img.id.trim()
              ? img.id.trim()
              : `img-${Date.now()}-${i}`,
          name:
            typeof img.name === "string" && img.name.trim()
              ? img.name.trim()
              : "attachment.jpg",
          dataUrl: img.dataUrl.trim()
        }));
      if (validImages.length > 0) {
        cleanTask.images = validImages;
      }
    }

    return cleanTask;
  }

  function normalizeTaskList(rawList, strictValidation) {
    if (!Array.isArray(rawList)) {
      return [];
    }
    const plainObjects = rawList.filter(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item)
    );
    if (strictValidation && rawList.length > 0 && plainObjects.length === 0) {
      throw new Error("Cấu trúc phần tử công việc trong file JSON trên GitHub không hợp lệ.");
    }

    const seenIds = new Set();
    return plainObjects.map((item, idx) => {
      const sanitized = sanitizeTaskRecord(item, idx);
      let uniqueId = sanitized.id;
      while (seenIds.has(uniqueId)) {
        uniqueId = `${sanitized.id}-dup-${idx}-${Math.random().toString(36).slice(2, 5)}`;
      }
      seenIds.add(uniqueId);
      sanitized.id = uniqueId;
      return sanitized;
    });
  }

  function serializeTaskForExport(task) {
    const base = {
      id: String(task.id),
      title: String(task.title),
      description: String(task.description || ""),
      group: String(task.group || "Công việc"),
      priority: VALID_PRIORITIES.includes(task.priority) ? task.priority : "none",
      status: task.status === "done" ? "done" : "todo",
      updatedAt: String(task.updatedAt || new Date().toISOString())
    };
    if (Array.isArray(task.images) && task.images.length > 0) {
      const validImages = task.images.filter((img) => img && isSafeImageDataUrl(img.dataUrl));
      if (validImages.length > 0) {
        base.images = validImages;
      }
    }
    return base;
  }

  function sanitizeErrorMessage(rawMessage, secretToken) {
    let msg = String(rawMessage || "Đã xảy ra lỗi không xác định.");
    if (secretToken && secretToken.length >= 4) {
      msg = msg.split(secretToken).join("[REDACTED]");
    }
    return msg;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("Yêu cầu tới GitHub API bị quá thời gian chờ (Timeout). Vui lòng thử lại.");
      }
      throw new Error("Không thể kết nối tới GitHub API. Vui lòng kiểm tra kết nối mạng.");
    } finally {
      clearTimeout(timer);
    }
  }

  function compressImageFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Không thể đọc file hình ảnh."));
      reader.onload = (ev) => {
        const rawDataUrl = String(ev.target.result || "").trim();
        const img = new Image();
        img.onerror = () => reject(new Error("Định dạng file hình ảnh không hợp lệ."));
        img.onload = () => {
          const maxDim = 2560;
          const losslessMaxBytes = Math.round(2.5 * 1024 * 1024);
          const origW = img.naturalWidth || img.width || 320;
          const origH = img.naturalHeight || img.height || 240;

          // Giữ nguyên 100% ảnh gốc không nén suy hao nếu kích thước <= 2K (2560px) và dung lượng <= 2.5 MB
          if (
            origW <= maxDim &&
            origH <= maxDim &&
            typeof file.size === "number" &&
            file.size > 0 &&
            file.size <= losslessMaxBytes &&
            isSafeImageDataUrl(rawDataUrl)
          ) {
            resolve({
              id: "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
              name: file.name || "screenshot.png",
              dataUrl: rawDataUrl
            });
            return;
          }

          let w = origW;
          let h = origH;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.max(1, Math.round((h * maxDim) / w));
              w = maxDim;
            } else {
              w = Math.max(1, Math.round((w * maxDim) / h));
              h = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, w, h);

          let dataUrl = canvas.toDataURL("image/png");
          if (dataUrl.length > 2.2 * 1024 * 1024) {
            dataUrl = canvas.toDataURL("image/webp", 0.96);
          }
          if (dataUrl.length > 2.2 * 1024 * 1024) {
            dataUrl = canvas.toDataURL("image/webp", 0.88);
          }
          if (!/^data:image\/(png|webp);base64,/i.test(dataUrl)) {
            dataUrl = canvas.toDataURL("image/jpeg", 0.94);
          }
          if (!isSafeImageDataUrl(dataUrl)) {
            reject(new Error("Không thể mã hóa hình ảnh an toàn."));
            return;
          }
          resolve({
            id: "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            name: file.name || "screenshot.webp",
            dataUrl
          });
        };
        img.src = rawDataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function escapeHtmlText(raw) {
    return String(raw || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildSafeClipboardHtml(descriptionText, validImages) {
    const parts = [];
    const cleanText = typeof descriptionText === "string" ? descriptionText : "";
    if (cleanText.trim().length > 0) {
      const htmlLines = escapeHtmlText(cleanText).replace(/\r?\n/g, "<br>");
      parts.push(`<div style="white-space:pre-wrap;line-height:1.45;">${htmlLines}</div>`);
    }
    if (Array.isArray(validImages) && validImages.length > 0) {
      const imgTags = validImages
        .filter((img) => img && isSafeImageDataUrl(img.dataUrl))
        .map((img, idx) => {
          const safeAlt = escapeHtmlText(img.name || `attachment-${idx + 1}`);
          const topGap = idx > 0 || parts.length > 0 ? "margin-top:8px;" : "";
          return `<img src="${img.dataUrl.trim()}" alt="${safeAlt}" style="max-width:100%;height:auto;display:block;${topGap}" />`;
        });
      if (imgTags.length > 0) {
        parts.push(`<div>${imgTags.join("")}</div>`);
      }
    }
    return `<div>${parts.join("")}</div>`;
  }

  function loadImageElementFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      if (!isSafeImageDataUrl(dataUrl)) {
        reject(new Error("URL hình ảnh không an toàn."));
        return;
      }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Không thể giải mã hình ảnh đính kèm."));
      img.src = dataUrl.trim();
    });
  }

  async function dataUrlToPngBlob(dataUrl) {
    if (!isSafeImageDataUrl(dataUrl)) {
      throw new Error("URL hình ảnh không an toàn.");
    }
    const trimmed = dataUrl.trim();
    if (/^data:image\/png;base64,/i.test(trimmed)) {
      const base64Part = trimmed.split(",")[1] || "";
      const binaryStr = atob(base64Part);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return new Blob([bytes], { type: "image/png" });
    }

    const singleImg = await loadImageElementFromDataUrl(trimmed);
    const w = Math.max(1, singleImg.naturalWidth || singleImg.width || 1);
    const h = Math.max(1, singleImg.naturalHeight || singleImg.height || 1);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(singleImg, 0, 0, w, h);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Không thể xuất định dạng PNG cho Clipboard."));
      }, "image/png");
    });
  }

  async function fallbackCopyPlainText(text) {
    const str = String(text || "");
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(str);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) {
      throw new Error("Trình duyệt không cho phép sao chép vào Clipboard.");
    }
  }

  /* ========================================================================
     3. APPLICATION STATE (ZERO HARDCODED CREDENTIALS)
     ======================================================================== */
  const INSTANCE_ID =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "inst-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  const state = {
    tasks: [],
    groups: DEFAULT_GROUPS.slice(),
    selectedGroupFilter: "ALL",
    selectedPriorityFilters: new Set(),
    statusFilter: "todo",
    searchQuery: "",
    groupByPriority: true,
    groupByCategory: true,
    theme: "dark",
    launchMode: "popup",
    openDescriptions: new Set(),
    expandedDescriptions: new Set(),
    collapsedPriorityGroups: new Set(),
    collapsedCategoryGroups: new Set(),
    editingGroupName: null,
    deletingGroupName: null,
    pendingFormImages: [],
    githubConfig: {
      owner: "",
      repo: "",
      branch: "",
      path: "",
      token: ""
    },
    autoPushConfig: {
      enabled: true,
      debounceValue: 10,
      debounceUnit: "s",
      maxWaitValue: 5,
      maxWaitUnit: "m"
    },
    syncMeta: {
      base_sha: null,
      lastSyncAt: null,
      syncedRepoKey: null,
      dirty: false,
      firstDirtyAt: null,
      lastDirtyAt: null,
      autoPushPausedReason: null,
      autoPushOwnerId: null
    },
    isSyncing: false,
    isSavingStorage: false,
    autoPushTimerId: null,
    treeCountdownIntervalId: null,
    bannerActionHandler: null,
    bannerAutoHideTimerId: null,
    bannerFadeOutTimerId: null,
    bannerHideDeadline: null,
    bannerRemainingMs: null,
    isBannerHovered: false,
    copiedTaskId: null,
    copiedFeedbackTimerId: null,
    activeLightboxDataUrl: null
  };

  /* ========================================================================
     4. GITHUB CONFIG PARSER & URL BUILDER
     ======================================================================== */
  function normalizeFilePath(rawPath) {
    return String(rawPath || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
  }

  function normalizeBranchName(rawBranch) {
    return String(rawBranch || "")
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .join("/");
  }

  function buildRepoKey(cfg) {
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.branch || !cfg.path) return null;
    return JSON.stringify([
      cfg.owner,
      cfg.repo,
      normalizeBranchName(cfg.branch),
      normalizeFilePath(cfg.path)
    ]);
  }

  function parseQuickGitHubPath(rawInput) {
    const cleaned = String(rawInput || "").trim();
    if (!cleaned) return null;

    if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
      try {
        const url = new URL(cleaned);
        const host = url.hostname.toLowerCase();
        const parts = url.pathname.split("/").filter(Boolean);

        if (host === "raw.githubusercontent.com" && parts.length >= 4) {
          const owner = decodeURIComponent(parts[0]);
          const repo = decodeURIComponent(parts[1]);
          if (parts[2] === "refs" && parts[3] === "heads" && parts.length >= 6) {
            return {
              owner,
              repo,
              branch: decodeURIComponent(parts[4]),
              path: parts.slice(5).map(decodeURIComponent).join("/")
            };
          }
          return {
            owner,
            repo,
            branch: decodeURIComponent(parts[2]),
            path: parts.slice(3).map(decodeURIComponent).join("/")
          };
        }

        if ((host === "github.com" || host === "www.github.com") && parts.length >= 2) {
          const owner = decodeURIComponent(parts[0]);
          const repo = decodeURIComponent(parts[1]).replace(/\.git$/i, "");
          if (
            parts.length >= 4 &&
            (parts[2] === "blob" || parts[2] === "tree" || parts[2] === "commits")
          ) {
            const branch = decodeURIComponent(parts[3]);
            const subPath = parts.slice(4).map(decodeURIComponent).join("/");
            return {
              owner,
              repo,
              branch: branch || "main",
              path: subPath || "tasks.json"
            };
          }
          return {
            owner,
            repo,
            branch: "main",
            path: "tasks.json"
          };
        }
      } catch (_) {
        return null;
      }
    }

    const segments = cleaned
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length >= 4) {
      return {
        owner: segments[0],
        repo: segments[1].replace(/\.git$/i, ""),
        branch: segments[2],
        path: segments.slice(3).join("/")
      };
    }
    if (segments.length === 3 && segments[2].toLowerCase().endsWith(".json")) {
      return {
        owner: segments[0],
        repo: segments[1].replace(/\.git$/i, ""),
        branch: "main",
        path: segments[2]
      };
    }
    if (segments.length === 2) {
      return {
        owner: segments[0],
        repo: segments[1].replace(/\.git$/i, ""),
        branch: "main",
        path: "tasks.json"
      };
    }
    return null;
  }

  function validateGitHubConfig(cfg) {
    const owner = String(cfg.owner || "").trim();
    const repo = String(cfg.repo || "").trim();
    const branch = normalizeBranchName(cfg.branch);
    const path = normalizeFilePath(cfg.path);
    const token = String(cfg.token || "").trim();

    if (!owner || !repo || !branch || !path || !token) {
      return {
        valid: false,
        error: "Vui lòng nhập đầy đủ cấu hình GitHub (Owner, Repo, Branch, Đường dẫn file và PAT)."
      };
    }

    const safeOwnerRe = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
    const safeRepoRe = /^[A-Za-z0-9._-]+$/;
    if (
      !safeOwnerRe.test(owner) ||
      owner.includes("..") ||
      !safeRepoRe.test(repo) ||
      repo === "." ||
      repo === ".." ||
      repo.includes("..")
    ) {
      return {
        valid: false,
        error: "Tên Owner hoặc Repository không hợp lệ."
      };
    }

    const pathSegments = path.split("/").filter(Boolean);
    if (
      pathSegments.length === 0 ||
      pathSegments.some((seg) => seg === "." || seg === ".." || /[\x00-\x1F\x7F]/.test(seg))
    ) {
      return {
        valid: false,
        error: "Đường dẫn file JSON không hợp lệ."
      };
    }

    const branchSegments = branch.split("/").filter(Boolean);
    const invalidBranchChars = /[\s~^:?*\[\\\x00-\x1F\x7F]/;
    if (
      branchSegments.length === 0 ||
      branch.includes("..") ||
      invalidBranchChars.test(branch) ||
      branchSegments.some(
        (seg) => seg === "." || seg === ".." || seg.startsWith(".") || seg.endsWith(".lock") || seg.endsWith(".")
      )
    ) {
      return {
        valid: false,
        error: "Tên nhánh (Branch) không hợp lệ theo quy chuẩn Git."
      };
    }

    if (!/^[\x21-\x7E]+$/.test(token)) {
      return {
        valid: false,
        error: "Personal Access Token chứa ký tự khoảng trắng hoặc ký tự không hợp lệ."
      };
    }

    return {
      valid: true,
      normalized: {
        owner,
        repo,
        branch: branchSegments.join("/"),
        path: pathSegments.join("/"),
        token
      }
    };
  }

  function getGitHubEndpoints(cfg) {
    const encodedOwner = encodeURIComponent(cfg.owner);
    const encodedRepo = encodeURIComponent(cfg.repo);
    const encodedBranchPath = cfg.branch
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    const encodedFilePath = cfg.path
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");

    return {
      fileUrl: `https://github.com/${encodedOwner}/${encodedRepo}/blob/${encodedBranchPath}/${encodedFilePath}`,
      commitsUrl: `https://github.com/${encodedOwner}/${encodedRepo}/commits/${encodedBranchPath}/${encodedFilePath}`,
      apiUrl: `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/contents/${encodedFilePath}`,
      blobsBaseUrl: `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/git/blobs`,
      encodedRefQuery: encodeURIComponent(cfg.branch)
    };
  }

  /* ========================================================================
     5. STORAGE PERSISTENCE & UI NOTIFICATIONS
     ======================================================================== */
  async function loadFromStorage() {
    const stored = await ChromeStorage.get([
      "tasks",
      "groups",
      "githubConfig",
      "autoPushConfig",
      "syncMeta",
      "uiPrefs"
    ]);

    if (Array.isArray(stored.tasks)) {
      state.tasks = normalizeTaskList(stored.tasks, false);
    } else {
      state.tasks = [];
    }

    if (Array.isArray(stored.groups) && stored.groups.length > 0) {
      const cleanGroups = stored.groups
        .filter((g) => typeof g === "string" && g.trim().length > 0)
        .map((g) => g.trim());
      state.groups =
        cleanGroups.length > 0 ? Array.from(new Set(cleanGroups)) : DEFAULT_GROUPS.slice();
    } else {
      state.groups = DEFAULT_GROUPS.slice();
    }

    state.tasks.forEach((t) => {
      if (t.group && !state.groups.includes(t.group)) {
        state.groups.push(t.group);
      }
    });

    if (stored.githubConfig && typeof stored.githubConfig === "object") {
      state.githubConfig = {
        owner: typeof stored.githubConfig.owner === "string" ? stored.githubConfig.owner : "",
        repo: typeof stored.githubConfig.repo === "string" ? stored.githubConfig.repo : "",
        branch: typeof stored.githubConfig.branch === "string" ? stored.githubConfig.branch : "",
        path: typeof stored.githubConfig.path === "string" ? stored.githubConfig.path : "",
        token: typeof stored.githubConfig.token === "string" ? stored.githubConfig.token : ""
      };
    }

    if (stored.autoPushConfig && typeof stored.autoPushConfig === "object") {
      const srcAp = stored.autoPushConfig;
      state.autoPushConfig = {
        enabled: typeof srcAp.enabled === "boolean" ? srcAp.enabled : true,
        debounceValue: Math.max(1, Math.floor(Number(srcAp.debounceValue) || 10)),
        debounceUnit: srcAp.debounceUnit === "m" ? "m" : "s",
        maxWaitValue: Math.max(1, Math.floor(Number(srcAp.maxWaitValue) || 5)),
        maxWaitUnit: srcAp.maxWaitUnit === "s" ? "s" : "m"
      };
    }

    if (stored.syncMeta && typeof stored.syncMeta === "object") {
      const isDirty = Boolean(stored.syncMeta.dirty);
      const rawFirst =
        typeof stored.syncMeta.firstDirtyAt === "number" && stored.syncMeta.firstDirtyAt > 0
          ? stored.syncMeta.firstDirtyAt
          : isDirty
            ? Date.now()
            : null;
      const rawLast =
        typeof stored.syncMeta.lastDirtyAt === "number" && stored.syncMeta.lastDirtyAt > 0
          ? stored.syncMeta.lastDirtyAt
          : rawFirst;
      state.syncMeta = {
        base_sha: typeof stored.syncMeta.base_sha === "string" ? stored.syncMeta.base_sha : null,
        lastSyncAt:
          typeof stored.syncMeta.lastSyncAt === "string" ? stored.syncMeta.lastSyncAt : null,
        syncedRepoKey:
          typeof stored.syncMeta.syncedRepoKey === "string" ? stored.syncMeta.syncedRepoKey : null,
        dirty: isDirty,
        firstDirtyAt: isDirty ? rawFirst : null,
        lastDirtyAt: isDirty ? rawLast : null,
        autoPushPausedReason:
          isDirty && typeof stored.syncMeta.autoPushPausedReason === "string"
            ? stored.syncMeta.autoPushPausedReason
            : null,
        autoPushOwnerId:
          isDirty && typeof stored.syncMeta.autoPushOwnerId === "string"
            ? stored.syncMeta.autoPushOwnerId
            : null
      };
    }

    if (stored.uiPrefs && typeof stored.uiPrefs === "object") {
      if (typeof stored.uiPrefs.groupByPriority === "boolean") {
        state.groupByPriority = stored.uiPrefs.groupByPriority;
      }
      if (typeof stored.uiPrefs.groupByCategory === "boolean") {
        state.groupByCategory = stored.uiPrefs.groupByCategory;
      }
      if (stored.uiPrefs.theme === "light" || stored.uiPrefs.theme === "dark") {
        state.theme = stored.uiPrefs.theme;
      }
      if (stored.uiPrefs.launchMode === "popup" || stored.uiPrefs.launchMode === "window") {
        state.launchMode = stored.uiPrefs.launchMode;
      }
    }

    applyThemeToDocument();
  }

  function markWorkingTreeDirty() {
    const now = Date.now();
    if (!state.syncMeta.dirty || !state.syncMeta.firstDirtyAt) {
      state.syncMeta.firstDirtyAt = now;
    }
    state.syncMeta.dirty = true;
    state.syncMeta.lastDirtyAt = now;
    state.syncMeta.autoPushPausedReason = null;
    state.syncMeta.autoPushOwnerId = INSTANCE_ID;
  }

  function getAutoPushDelaysMs(cfg) {
    const src = cfg || state.autoPushConfig;
    const debVal = Math.max(1, Math.floor(Number(src.debounceValue) || 10));
    const debMs = debVal * (src.debounceUnit === "m" ? 60000 : 1000);
    const maxVal = Math.max(1, Math.floor(Number(src.maxWaitValue) || 5));
    const maxMs = maxVal * (src.maxWaitUnit === "m" ? 60000 : 1000);
    return { debounceMs: debMs, maxWaitMs: maxMs };
  }

  function getEffectiveAutoPushDeadline() {
    if (!state.syncMeta || !state.syncMeta.dirty) return null;
    if (!state.autoPushConfig || !state.autoPushConfig.enabled) return null;
    if (state.syncMeta.autoPushPausedReason) return null;
    const cfgCheck = validateGitHubConfig(state.githubConfig);
    if (!cfgCheck.valid) return null;

    const now = Date.now();
    const firstAt =
      typeof state.syncMeta.firstDirtyAt === "number" && state.syncMeta.firstDirtyAt > 0
        ? state.syncMeta.firstDirtyAt
        : now;
    const lastAt =
      typeof state.syncMeta.lastDirtyAt === "number" && state.syncMeta.lastDirtyAt > 0
        ? state.syncMeta.lastDirtyAt
        : firstAt;
    const { debounceMs, maxWaitMs } = getAutoPushDelaysMs(state.autoPushConfig);
    return Math.min(lastAt + debounceMs, firstAt + maxWaitMs);
  }

  function formatRemainingDuration(ms) {
    const sec = Math.max(1, Math.ceil(ms / 1000));
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `${m}p${s}s` : `${m}p`;
    }
    return `${sec}s`;
  }

  async function persistAllToStorage() {
    state.isSavingStorage = true;
    try {
      await ChromeStorage.set({
        tasks: state.tasks.map(serializeTaskForExport),
        groups: state.groups,
        githubConfig: state.githubConfig,
        autoPushConfig: state.autoPushConfig,
        syncMeta: state.syncMeta,
        uiPrefs: {
          groupByPriority: state.groupByPriority,
          groupByCategory: state.groupByCategory,
          theme: state.theme,
          launchMode: state.launchMode
        }
      });
      updateHeaderAndFooterMeta();
      scheduleOrCancelAutoPush();
    } finally {
      state.isSavingStorage = false;
    }
  }

  function applyThemeToDocument() {
    if (state.theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function switchTab(tabName) {
    document.getElementById("tabBtnTasks").classList.toggle("active", tabName === "tasks");
    document.getElementById("tabBtnAddTask").classList.toggle("active", tabName === "add");
    const grpTabBtn = document.getElementById("tabBtnGroups");
    if (grpTabBtn) grpTabBtn.classList.toggle("active", tabName === "groups");
    document.getElementById("tabBtnSettings").classList.toggle("active", tabName === "settings");

    document.getElementById("viewTasks").classList.toggle("active", tabName === "tasks");
    document.getElementById("viewAddTask").classList.toggle("active", tabName === "add");
    const grpView = document.getElementById("viewGroups");
    if (grpView) grpView.classList.toggle("active", tabName === "groups");
    document.getElementById("viewSettings").classList.toggle("active", tabName === "settings");

    if (tabName === "tasks") {
      refreshDescriptionOverflowButtons();
    }
  }

  const TOAST_DEFAULT_MS = 2600;
  const TOAST_EXTENDED_MS = 4000;
  const TOAST_FADE_MS = 170;

  function clearBannerTimers() {
    if (state.bannerAutoHideTimerId !== null) {
      clearTimeout(state.bannerAutoHideTimerId);
      state.bannerAutoHideTimerId = null;
    }
    if (state.bannerFadeOutTimerId !== null) {
      clearTimeout(state.bannerFadeOutTimerId);
      state.bannerFadeOutTimerId = null;
    }
    state.bannerHideDeadline = null;
  }

  function scheduleBannerAutoHide(durationMs) {
    if (state.bannerAutoHideTimerId !== null) {
      clearTimeout(state.bannerAutoHideTimerId);
      state.bannerAutoHideTimerId = null;
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      state.bannerRemainingMs = null;
      state.bannerHideDeadline = null;
      return;
    }
    state.bannerRemainingMs = durationMs;
    if (state.isBannerHovered) {
      state.bannerHideDeadline = null;
      return;
    }
    state.bannerHideDeadline = Date.now() + durationMs;
    state.bannerAutoHideTimerId = setTimeout(() => {
      state.bannerAutoHideTimerId = null;
      hideBanner(false);
    }, durationMs);
  }

  function showBanner(message, type, actionConfig) {
    const banner = document.getElementById("statusBanner");
    const textEl = document.getElementById("statusBannerText");
    const actionBtn = document.getElementById("btnBannerAction");
    const progressEl = document.getElementById("toastProgressBar");
    if (!banner || !textEl || !actionBtn) return;

    clearBannerTimers();

    const resolvedType = type || "info";
    const hasAction = Boolean(
      actionConfig && actionConfig.label && typeof actionConfig.onClick === "function"
    );
    const autoHideMs =
      actionConfig && typeof actionConfig.autoHideMs === "number"
        ? actionConfig.autoHideMs
        : hasAction || resolvedType === "error"
          ? TOAST_EXTENDED_MS
          : TOAST_DEFAULT_MS;

    banner.className = "status-banner";
    if (progressEl) {
      progressEl.classList.remove("running");
    }
    void banner.offsetWidth;

    banner.className = "status-banner show " + resolvedType;
    textEl.textContent = String(message || "");

    if (hasAction) {
      actionBtn.textContent = actionConfig.label;
      actionBtn.classList.remove("hidden");
      state.bannerActionHandler = actionConfig.onClick;
    } else {
      actionBtn.textContent = "";
      actionBtn.classList.add("hidden");
      state.bannerActionHandler = null;
    }

    if (progressEl && autoHideMs > 0) {
      progressEl.style.setProperty("--toast-duration", `${autoHideMs}ms`);
      progressEl.classList.add("running");
    }

    scheduleBannerAutoHide(autoHideMs);
  }

  function hideBanner(immediate) {
    const banner = document.getElementById("statusBanner");
    const progressEl = document.getElementById("toastProgressBar");
    if (!banner) return;

    clearBannerTimers();
    state.bannerRemainingMs = null;

    if (immediate !== false || !banner.classList.contains("show")) {
      banner.className = "status-banner";
      if (progressEl) {
        progressEl.classList.remove("running");
      }
      state.bannerActionHandler = null;
      return;
    }

    banner.classList.add("hiding");
    state.bannerFadeOutTimerId = setTimeout(() => {
      state.bannerFadeOutTimerId = null;
      banner.className = "status-banner";
      if (progressEl) {
        progressEl.classList.remove("running");
      }
      state.bannerActionHandler = null;
    }, TOAST_FADE_MS);
  }

  function updateTreeStatusUI() {
    const treeEl = document.getElementById("treeStatusBadge");
    const pushBtn = document.getElementById("btnPushGitHub");
    if (!treeEl) return;

    const isDirty = Boolean(state.syncMeta && state.syncMeta.dirty);
    if (pushBtn) {
      pushBtn.classList.toggle("needs-commit", isDirty);
      pushBtn.textContent = isDirty ? "⬆ Push GitHub *" : "⬆ Push GitHub";
    }

    if (state.isSyncing && isDirty) {
      treeEl.className = "tree-status-pill syncing";
      treeEl.textContent = "↻ Đang commit & Push...";
      return;
    }

    if (isDirty) {
      if (state.syncMeta.autoPushPausedReason) {
        treeEl.className = "tree-status-pill dirty-conflict";
        treeEl.textContent = `● Chưa sạch • Tạm dừng (${state.syncMeta.autoPushPausedReason})`;
        return;
      }
      const deadline = getEffectiveAutoPushDeadline();
      if (deadline !== null) {
        const rem = Math.max(0, deadline - Date.now());
        treeEl.className = "tree-status-pill dirty";
        treeEl.textContent = `● Chưa sạch • Auto Push sau ${formatRemainingDuration(rem)}`;
        return;
      }
      treeEl.className = "tree-status-pill dirty";
      treeEl.textContent = "● Chưa sạch (Cần commit)";
      return;
    }

    treeEl.className = "tree-status-pill clean";
    treeEl.textContent =
      state.syncMeta && state.syncMeta.base_sha ? "✓ Cây sạch (Đã commit)" : "✓ Cây sạch";
  }

  function scheduleOrCancelAutoPush() {
    if (state.autoPushTimerId !== null) {
      clearTimeout(state.autoPushTimerId);
      state.autoPushTimerId = null;
    }

    const deadline = getEffectiveAutoPushDeadline();
    if (deadline === null || state.isSyncing) {
      if (state.treeCountdownIntervalId !== null) {
        clearInterval(state.treeCountdownIntervalId);
        state.treeCountdownIntervalId = null;
      }
      updateTreeStatusUI();
      return;
    }

    if (state.treeCountdownIntervalId === null) {
      state.treeCountdownIntervalId = setInterval(() => {
        updateTreeStatusUI();
      }, 500);
    }
    updateTreeStatusUI();

    const isOwner =
      !state.syncMeta.autoPushOwnerId || state.syncMeta.autoPushOwnerId === INSTANCE_ID;
    if (!isOwner) {
      return;
    }

    const waitMs = Math.max(25, deadline - Date.now());
    state.autoPushTimerId = setTimeout(async () => {
      state.autoPushTimerId = null;
      if (state.isSyncing || !state.syncMeta.dirty || !state.autoPushConfig.enabled) {
        return;
      }
      const latestDeadline = getEffectiveAutoPushDeadline();
      if (latestDeadline === null) {
        return;
      }
      if (latestDeadline - Date.now() > 80) {
        scheduleOrCancelAutoPush();
        return;
      }
      await handlePushToGitHub(false, { isAutoPush: true });
    }, waitMs);
  }

  function updateHeaderAndFooterMeta() {
    const shaBadge = document.getElementById("headerShaBadge");
    const footerSync = document.getElementById("footerLastSync");
    const footerStorage = document.getElementById("footerStorageStatus");

    if (state.syncMeta && state.syncMeta.base_sha) {
      const suffix = state.syncMeta.dirty ? " • chưa Push" : "";
      shaBadge.textContent = "base_sha: " + state.syncMeta.base_sha.slice(0, 7) + suffix;
      shaBadge.title = "Mã base_sha gần nhất: " + state.syncMeta.base_sha;
    } else {
      shaBadge.textContent =
        state.syncMeta && state.syncMeta.dirty ? "SHA: cục bộ mới" : "SHA: chưa đồng bộ";
      shaBadge.title = "Chưa có mã base_sha từ GitHub";
    }

    updateTreeStatusUI();

    if (state.syncMeta && state.syncMeta.lastSyncAt) {
      const dt = new Date(state.syncMeta.lastSyncAt);
      if (!Number.isNaN(dt.getTime())) {
        footerSync.textContent = "Đồng bộ gần nhất: " + dt.toLocaleTimeString("vi-VN");
      } else {
        footerSync.textContent = "Đã đồng bộ";
      }
    } else {
      footerSync.textContent = "Chưa đồng bộ GitHub";
    }

    footerStorage.textContent = `💾 chrome.storage.local: ${state.tasks.length} công việc • ${state.groups.length} nhóm`;
  }

  function setSyncButtonsDisabled(disabled) {
    state.isSyncing = disabled;
    const ids = [
      "btnPullGitHub",
      "btnPushGitHub",
      "btnForcePull",
      "btnForcePush",
      "btnSaveGitHubConfig",
      "btnClearGitHubConfig",
      "btnSavePreferences",
      "btnCrudAddGroup",
      "btnSubmitTask"
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
    updateTreeStatusUI();
  }

  function showConflictAlert(cfg, localShaLabel, remoteShaLabel, customReason) {
    const box = document.getElementById("conflictAlertBox");
    const descEl = document.getElementById("conflictDescText");
    const localEl = document.getElementById("conflictLocalSha");
    const remoteEl = document.getElementById("conflictRemoteSha");
    const fileLink = document.getElementById("conflictFileLink");
    const commitsLink = document.getElementById("conflictCommitsLink");

    descEl.textContent =
      customReason ||
      "Dữ liệu trên GitHub đã bị thay đổi từ nơi khác (mã SHA từ xa khác với base_sha cục bộ). Hệ thống đã dừng ghi đè để bảo vệ dữ liệu của bạn.";

    localEl.textContent = localShaLabel ? String(localShaLabel).slice(0, 16) : "chưa đồng bộ";
    remoteEl.textContent = remoteShaLabel ? String(remoteShaLabel).slice(0, 16) : "đã thay đổi";

    const urls = getGitHubEndpoints(cfg);
    fileLink.href = urls.fileUrl;
    commitsLink.href = urls.commitsUrl;

    box.classList.add("show");
  }

  function hideConflictAlert() {
    document.getElementById("conflictAlertBox").classList.remove("show");
  }

  /* ========================================================================
     6. RENDERING ENGINE (100% DOM API + textContent ONLY)
     ======================================================================== */
  function parseTimestampSafe(isoStr) {
    const ms = Date.parse(String(isoStr || ""));
    return Number.isNaN(ms) ? 0 : ms;
  }

  function sortTasksDoneAtBottom(taskArray) {
    return taskArray.slice().sort((a, b) => {
      const aDone = a.status === "done" ? 1 : 0;
      const bDone = b.status === "done" ? 1 : 0;
      if (aDone !== bDone) {
        return aDone - bDone;
      }
      const pA = Object.prototype.hasOwnProperty.call(PRIO_WEIGHT, a.priority)
        ? PRIO_WEIGHT[a.priority]
        : 0;
      const pB = Object.prototype.hasOwnProperty.call(PRIO_WEIGHT, b.priority)
        ? PRIO_WEIGHT[b.priority]
        : 0;
      if (pA !== pB) {
        return pB - pA;
      }
      const tDiff = parseTimestampSafe(b.updatedAt) - parseTimestampSafe(a.updatedAt);
      if (tDiff !== 0) {
        return tDiff;
      }
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function createPriorityFlagSvg(prioKey) {
    const safePrio = VALID_PRIORITIES.includes(prioKey) ? prioKey : "none";
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "prio-flag-icon flag-" + safePrio);

    const pole = document.createElementNS(svgNS, "path");
    pole.setAttribute("d", "M3 2v12");
    pole.setAttribute("stroke", "currentColor");
    pole.setAttribute("stroke-width", "1.6");
    pole.setAttribute("stroke-linecap", "round");
    pole.setAttribute("fill", "none");

    const cloth = document.createElementNS(svgNS, "path");
    cloth.setAttribute("d", "M3.2 2.5h8.8l-1.9 3 1.9 3H3.2z");
    if (safePrio === "none") {
      cloth.setAttribute("fill", "none");
      cloth.setAttribute("stroke", "currentColor");
      cloth.setAttribute("stroke-width", "1.3");
      cloth.setAttribute("stroke-linejoin", "round");
    } else {
      cloth.setAttribute("fill", "currentColor");
    }

    svg.appendChild(pole);
    svg.appendChild(cloth);
    return svg;
  }

  function refreshDescriptionOverflowButtons() {
    const container = document.getElementById("taskListContainer");
    if (!container) return;
    const openBoxes = container.querySelectorAll(".task-desc-box.open:not(.expanded)");
    openBoxes.forEach((box) => {
      const textEl = box.querySelector(".task-desc-text");
      const btnEl = box.querySelector(".btn-expand-desc");
      if (!textEl || !btnEl) return;
      if (textEl.clientHeight <= 0) return;
      const isOverflowing = textEl.scrollHeight > textEl.clientHeight + 1;
      btnEl.classList.toggle("hidden-toggle", !isOverflowing);
    });
  }

  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function renderFormImagePreviews() {
    const listEl = document.getElementById("formImagePreviewList");
    const countLbl = document.getElementById("imageCountLabel");
    clearChildren(listEl);
    countLbl.textContent = `${state.pendingFormImages.length}/${MAX_IMAGE_COUNT_PER_TASK} ảnh đính kèm`;

    state.pendingFormImages.forEach((imgObj, index) => {
      if (!isSafeImageDataUrl(imgObj.dataUrl)) return;
      const wrap = document.createElement("div");
      wrap.className = "image-preview-item";

      const imgEl = document.createElement("img");
      imgEl.src = imgObj.dataUrl;
      imgEl.alt = imgObj.name || "Ảnh đính kèm";
      imgEl.title = imgObj.name || "Ảnh đính kèm";

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "image-remove-btn";
      btnDel.textContent = "✕";
      btnDel.title = "Gỡ ảnh đính kèm";
      btnDel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.pendingFormImages.splice(index, 1);
        renderFormImagePreviews();
      });

      wrap.appendChild(imgEl);
      wrap.appendChild(btnDel);
      listEl.appendChild(wrap);
    });
  }

  function openImageLightbox(dataUrl, captionText) {
    if (!isSafeImageDataUrl(dataUrl)) return;
    const modal = document.getElementById("imageLightbox");
    const imgEl = document.getElementById("lightboxImgEl");
    const capEl = document.getElementById("lightboxCaption");
    state.activeLightboxDataUrl = dataUrl.trim();
    imgEl.src = state.activeLightboxDataUrl;
    capEl.textContent = captionText || "Hình ảnh đính kèm";
    modal.classList.add("show");
  }

  function updateCopyButtonDOM(btnEl, isCopied, defaultTitle) {
    if (!btnEl) return;
    btnEl.classList.toggle("copied", Boolean(isCopied));
    btnEl.textContent = isCopied ? "✓ Đã copy" : "📋 Copy";
    btnEl.title = isCopied ? "Đã sao chép vào Clipboard!" : defaultTitle;
  }

  function markTaskCopiedFeedback(taskId) {
    if (state.copiedFeedbackTimerId !== null) {
      clearTimeout(state.copiedFeedbackTimerId);
      state.copiedFeedbackTimerId = null;
    }
    state.copiedTaskId = taskId;
    document.querySelectorAll(".task-card").forEach((cardEl) => {
      const btn = cardEl.querySelector(".btn-copy-desc");
      if (!btn) return;
      const isMatch = cardEl.dataset.taskId === taskId;
      updateCopyButtonDOM(btn, isMatch, btn.dataset.defaultTitle || "Sao chép nhanh mô tả");
    });
    state.copiedFeedbackTimerId = setTimeout(() => {
      state.copiedFeedbackTimerId = null;
      state.copiedTaskId = null;
      document.querySelectorAll(".task-card .btn-copy-desc").forEach((btn) => {
        updateCopyButtonDOM(btn, false, btn.dataset.defaultTitle || "Sao chép nhanh mô tả");
      });
    }, 1800);
  }

  async function copyTaskContentToClipboard(task) {
    if (!task) return false;
    const rawDesc = typeof task.description === "string" ? task.description : "";
    const hasDesc = rawDesc.trim().length > 0;
    const validImages = Array.isArray(task.images)
      ? task.images.filter((img) => img && isSafeImageDataUrl(img.dataUrl))
      : [];

    if (!hasDesc && validImages.length === 0) {
      showBanner("Công việc này chưa có mô tả hoặc hình ảnh để sao chép.", "info");
      return false;
    }

    const canWriteRichClipboard =
      typeof ClipboardItem !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function";

    // Chỉ copy kèm ảnh ở nút Copy tổng khi công việc có đúng 1 ảnh (giữ nguyên 100% độ nét gốc, không ghép nhiều ảnh gây thu nhỏ/vỡ nét)
    if (validImages.length === 1 && canWriteRichClipboard) {
      try {
        const htmlStr = buildSafeClipboardHtml(hasDesc ? rawDesc : "", validImages);
        const itemData = {
          "text/html": Promise.resolve(new Blob([htmlStr], { type: "text/html" })),
          "image/png": dataUrlToPngBlob(validImages[0].dataUrl)
        };
        if (hasDesc) {
          itemData["text/plain"] = Promise.resolve(new Blob([rawDesc], { type: "text/plain" }));
        }
        await navigator.clipboard.write([new ClipboardItem(itemData)]);
        markTaskCopiedFeedback(task.id);
        showBanner(
          hasDesc
            ? "📋 Đã sao chép mô tả kèm 1 ảnh vào Clipboard!"
            : "📋 Đã sao chép ảnh đính kèm vào Clipboard!",
          "success"
        );
        return true;
      } catch (err) {
        if (hasDesc) {
          try {
            await fallbackCopyPlainText(rawDesc);
            markTaskCopiedFeedback(task.id);
            showBanner(
              "📋 Đã sao chép văn bản mô tả (không thể sao chép ảnh đính kèm).",
              "info"
            );
            return true;
          } catch (_) {
            // Chuyển xuống thông báo lỗi bên dưới
          }
        }
        showBanner(err.message || "Không thể sao chép hình ảnh vào Clipboard.", "error");
        return false;
      }
    }

    if (hasDesc) {
      const multiImgNote =
        validImages.length > 1
          ? `📋 Đã sao chép mô tả! (Có ${validImages.length} ảnh — bấm 📋 trên từng ảnh để copy riêng không bị vỡ)`
          : "📋 Đã sao chép mô tả vào Clipboard!";
      try {
        if (canWriteRichClipboard) {
          const htmlStr = buildSafeClipboardHtml(rawDesc, []);
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([rawDesc], { type: "text/plain" }),
              "text/html": new Blob([htmlStr], { type: "text/html" })
            })
          ]);
        } else {
          await fallbackCopyPlainText(rawDesc);
        }
        markTaskCopiedFeedback(task.id);
        showBanner(multiImgNote, "success");
        return true;
      } catch (err) {
        try {
          await fallbackCopyPlainText(rawDesc);
          markTaskCopiedFeedback(task.id);
          showBanner(multiImgNote, "success");
          return true;
        } catch (fallbackErr) {
          showBanner(fallbackErr.message || "Không thể sao chép mô tả vào Clipboard.", "error");
          return false;
        }
      }
    }

    if (validImages.length > 1) {
      showBanner(
        `Task có ${validImages.length} ảnh — hãy bấm nút 📋 trên từng ảnh để copy riêng không bị vỡ nét!`,
        "info"
      );
      return false;
    }

    showBanner("Trình duyệt hiện tại không hỗ trợ sao chép hình ảnh vào Clipboard.", "error");
    return false;
  }

  async function copySingleImageDataUrlToClipboard(dataUrl, captionLabel) {
    if (!isSafeImageDataUrl(dataUrl)) {
      showBanner("Hình ảnh không hợp lệ để sao chép.", "error");
      return false;
    }
    if (
      typeof ClipboardItem === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.write !== "function"
    ) {
      showBanner("Trình duyệt không hỗ trợ sao chép hình ảnh vào Clipboard.", "error");
      return false;
    }

    try {
      const singleImgList = [{ name: captionLabel || "attachment", dataUrl }];
      const htmlStr = buildSafeClipboardHtml("", singleImgList);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": Promise.resolve(new Blob([htmlStr], { type: "text/html" })),
          "image/png": dataUrlToPngBlob(dataUrl)
        })
      ]);
      showBanner("📋 Đã sao chép hình ảnh vào Clipboard!", "success");
      return true;
    } catch (err) {
      showBanner(err.message || "Không thể sao chép hình ảnh vào Clipboard.", "error");
      return false;
    }
  }

  function getNormalizedPriority(task) {
    return VALID_PRIORITIES.includes(task.priority) ? task.priority : "none";
  }

  function taskMatchesBaseFilters(task, normalizedQuery) {
    if (state.statusFilter !== "all" && task.status !== state.statusFilter) {
      return false;
    }
    if (normalizedQuery) {
      const inTitle = (task.title || "").toLowerCase().includes(normalizedQuery);
      const inDesc = (task.description || "").toLowerCase().includes(normalizedQuery);
      const inGroup = (task.group || "").toLowerCase().includes(normalizedQuery);
      if (!inTitle && !inDesc && !inGroup) {
        return false;
      }
    }
    return true;
  }

  function renderFiltersAndCounters() {
    state.tasks.forEach((t) => {
      if (t.group && !state.groups.includes(t.group)) {
        state.groups.push(t.group);
      }
    });

    if (state.selectedGroupFilter !== "ALL" && !state.groups.includes(state.selectedGroupFilter)) {
      state.selectedGroupFilter = "ALL";
    }
    Array.from(state.selectedPriorityFilters).forEach((p) => {
      if (!VALID_PRIORITIES.includes(p)) {
        state.selectedPriorityFilters.delete(p);
      }
    });

    const todoCount = state.tasks.filter((t) => t.status !== "done").length;
    const doneCount = state.tasks.filter((t) => t.status === "done").length;
    const totalCount = state.tasks.length;

    document.getElementById("countTodoBadge").textContent = String(todoCount);
    document.getElementById("countAllBadge").textContent = String(totalCount);
    document.getElementById("countDoneBadge").textContent = String(doneCount);
    document.getElementById("navTaskCount").textContent = String(totalCount);
    const navGrpCountEl = document.getElementById("navGroupCount");
    if (navGrpCountEl) {
      navGrpCountEl.textContent = String(state.groups.length);
    }

    document.querySelectorAll(".status-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-statusfilter") === state.statusFilter);
    });
    document.getElementById("statusFilterSelect").value = state.statusFilter;

    const prioToggleBtn = document.getElementById("btnTogglePriorityGroup");
    if (prioToggleBtn) {
      prioToggleBtn.textContent = state.groupByPriority
        ? "🚩 Nhóm Priority: BẬT"
        : "🚩 Nhóm Priority: TẮT";
      prioToggleBtn.classList.toggle("accent-outline", state.groupByPriority);
    }

    const groupToggleBtn = document.getElementById("btnToggleGroupBy");
    groupToggleBtn.textContent = state.groupByCategory
      ? "🗂 Nhóm Group: BẬT"
      : "🗂 Nhóm Group: TẮT";
    groupToggleBtn.classList.toggle("accent-outline", state.groupByCategory);

    const query = state.searchQuery.trim().toLowerCase();
    const baseMatchedTasks = state.tasks.filter((t) => taskMatchesBaseFilters(t, query));
    const tasksForPriorityCounts =
      state.selectedGroupFilter === "ALL"
        ? baseMatchedTasks
        : baseMatchedTasks.filter((t) => t.group === state.selectedGroupFilter);
    const tasksForGroupCounts =
      state.selectedPriorityFilters.size === 0
        ? baseMatchedTasks
        : baseMatchedTasks.filter((t) =>
            state.selectedPriorityFilters.has(getNormalizedPriority(t))
          );

    const prioBarEl = document.getElementById("priorityFilterBar");
    if (prioBarEl) {
      clearChildren(prioBarEl);

      const isAllPriorities = state.selectedPriorityFilters.size === 0;
      const allPrioPill = document.createElement("button");
      allPrioPill.type = "button";
      allPrioPill.className = "filter-pill" + (isAllPriorities ? " active" : "");
      allPrioPill.dataset.priority = "ALL";
      allPrioPill.setAttribute("aria-pressed", isAllPriorities ? "true" : "false");
      allPrioPill.title = "Hiển thị tất cả cờ ưu tiên (bỏ chọn các cờ đang lọc)";
      allPrioPill.textContent = `Tất cả cờ (${tasksForPriorityCounts.length})`;
      allPrioPill.addEventListener("click", () => {
        state.selectedPriorityFilters.clear();
        renderAll();
      });
      prioBarEl.appendChild(allPrioPill);

      PRIORITY_ORDER.forEach((prioKey) => {
        const count = tasksForPriorityCounts.filter(
          (t) => getNormalizedPriority(t) === prioKey
        ).length;
        const isSelected = state.selectedPriorityFilters.has(prioKey);
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "filter-pill" + (isSelected ? " active" : "");
        pill.dataset.priority = prioKey;
        pill.setAttribute("aria-pressed", isSelected ? "true" : "false");
        pill.title = `Chọn/bỏ chọn cờ ${PRIORITY_META[prioKey].pillLabel} (có thể chọn nhiều cờ cùng lúc)`;
        pill.appendChild(createPriorityFlagSvg(prioKey));
        const lbl = document.createElement("span");
        lbl.textContent = `${PRIORITY_META[prioKey].pillLabel} (${count})`;
        pill.appendChild(lbl);
        pill.addEventListener("click", () => {
          if (state.selectedPriorityFilters.has(prioKey)) {
            state.selectedPriorityFilters.delete(prioKey);
          } else {
            state.selectedPriorityFilters.add(prioKey);
          }
          renderAll();
        });
        prioBarEl.appendChild(pill);
      });
    }

    const selectEl = document.getElementById("taskGroupSelect");
    const prevSelected = selectEl.value;
    clearChildren(selectEl);
    state.groups.forEach((grp) => {
      const opt = document.createElement("option");
      opt.value = grp;
      opt.textContent = "📁 " + grp;
      selectEl.appendChild(opt);
    });
    if (state.groups.includes(prevSelected)) {
      selectEl.value = prevSelected;
    } else if (state.groups.length > 0) {
      selectEl.value = state.groups[0];
    }

    const barEl = document.getElementById("groupFilterBar");
    clearChildren(barEl);

    const allPill = document.createElement("button");
    allPill.type = "button";
    allPill.className = "filter-pill" + (state.selectedGroupFilter === "ALL" ? " active" : "");
    allPill.dataset.group = "ALL";
    allPill.textContent = `Tất cả nhóm (${tasksForGroupCounts.length})`;
    allPill.addEventListener("click", () => {
      state.selectedGroupFilter = "ALL";
      renderAll();
    });
    barEl.appendChild(allPill);

    state.groups.forEach((grp) => {
      const count = tasksForGroupCounts.filter((t) => t.group === grp).length;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "filter-pill" + (state.selectedGroupFilter === grp ? " active" : "");
      pill.dataset.group = grp;
      pill.textContent = `${grp} (${count})`;
      pill.addEventListener("click", () => {
        state.selectedGroupFilter = grp;
        renderAll();
      });
      barEl.appendChild(pill);
    });
  }

  function createTaskCardDOM(task) {
    const card = document.createElement("div");
    card.className = "task-card" + (task.status === "done" ? " done" : "");
    card.dataset.taskId = task.id;
    card.dataset.status = task.status;
    card.dataset.priority = task.priority;
    card.dataset.group = task.group;

    const mainRow = document.createElement("div");
    mainRow.className = "task-main-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-checkbox";
    checkbox.checked = task.status === "done";
    checkbox.setAttribute("aria-label", `Đánh dấu trạng thái công việc: ${task.title}`);
    checkbox.title = task.status === "done" ? "Đổi về Chưa làm" : "Đánh dấu Đã xong";
    checkbox.addEventListener("change", () => {
      toggleTaskStatus(task.id);
    });

    const contentCol = document.createElement("div");
    contentCol.className = "task-content";

    const titleEl = document.createElement("div");
    titleEl.className = "task-title";
    titleEl.textContent = task.title;

    const metaRow = document.createElement("div");
    metaRow.className = "task-meta-row";

    const groupBadge = document.createElement("span");
    groupBadge.className = "badge badge-group";
    groupBadge.textContent = task.group || "Công việc";

    const prioBadge = document.createElement("span");
    const prioKey = VALID_PRIORITIES.includes(task.priority) ? task.priority : "none";
    prioBadge.className = "badge badge-prio-" + prioKey;
    prioBadge.appendChild(createPriorityFlagSvg(prioKey));
    const prioLabelSpan = document.createElement("span");
    prioLabelSpan.textContent = PRIORITY_META[prioKey].badgeLabel;
    prioBadge.appendChild(prioLabelSpan);

    const statusBadge = document.createElement("span");
    statusBadge.className = "badge badge-status";
    statusBadge.textContent = task.status === "done" ? "✓ Đã xong" : "⏳ Chưa làm";

    metaRow.appendChild(groupBadge);
    metaRow.appendChild(prioBadge);
    metaRow.appendChild(statusBadge);

    const validImages = Array.isArray(task.images)
      ? task.images.filter((img) => img && isSafeImageDataUrl(img.dataUrl))
      : [];

    if (validImages.length > 0) {
      const imgBadge = document.createElement("span");
      imgBadge.className = "badge badge-img";
      imgBadge.textContent = `🖼️ ${validImages.length} ảnh`;
      metaRow.appendChild(imgBadge);
    }

    contentCol.appendChild(titleEl);
    contentCol.appendChild(metaRow);

    if (validImages.length > 0) {
      const imgGrid = document.createElement("div");
      imgGrid.className = "task-images-grid";
      validImages.forEach((imgObj, idx) => {
        const thumbWrap = document.createElement("div");
        thumbWrap.className = "task-img-thumb-wrap";

        const thumb = document.createElement("img");
        thumb.className = "task-img-thumb";
        thumb.src = imgObj.dataUrl;
        thumb.alt = imgObj.name || "Ảnh đính kèm";
        thumb.title = "Nhấn để phóng to: " + (imgObj.name || `Ảnh ${idx + 1}`);
        thumb.addEventListener("click", () => {
          openImageLightbox(imgObj.dataUrl, `${task.title} — ${imgObj.name || ""}`);
        });

        const btnCopyThumb = document.createElement("button");
        btnCopyThumb.type = "button";
        btnCopyThumb.className = "thumb-copy-btn";
        btnCopyThumb.textContent = "📋";
        btnCopyThumb.title = `Copy riêng ảnh ${idx + 1}`;
        btnCopyThumb.setAttribute("aria-label", `Copy riêng ảnh ${idx + 1}`);
        btnCopyThumb.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const ok = await copySingleImageDataUrlToClipboard(
            imgObj.dataUrl,
            imgObj.name || `attachment-${idx + 1}`
          );
          if (ok) {
            btnCopyThumb.textContent = "✓";
            btnCopyThumb.classList.add("copied");
            setTimeout(() => {
              btnCopyThumb.textContent = "📋";
              btnCopyThumb.classList.remove("copied");
            }, 1500);
          }
        });

        thumbWrap.appendChild(thumb);
        thumbWrap.appendChild(btnCopyThumb);
        imgGrid.appendChild(thumbWrap);
      });
      contentCol.appendChild(imgGrid);
    }

    const actionsCol = document.createElement("div");
    actionsCol.className = "task-actions";

    const hasDescription =
      typeof task.description === "string" && task.description.trim().length > 0;
    const hasCopyableContent = hasDescription || validImages.length === 1;

    if (hasCopyableContent) {
      const defaultCopyTitle =
        hasDescription && validImages.length === 1
          ? "Sao chép nhanh mô tả kèm 1 ảnh đính kèm"
          : hasDescription && validImages.length > 1
            ? `Sao chép nhanh mô tả (Task có ${validImages.length} ảnh — bấm 📋 trên từng ảnh để copy riêng)`
            : hasDescription
              ? "Sao chép nhanh mô tả chi tiết"
              : "Sao chép nhanh ảnh đính kèm";
      const isCopied = state.copiedTaskId === task.id;
      const btnCopy = document.createElement("button");
      btnCopy.type = "button";
      btnCopy.className = "task-action-btn btn-copy-desc" + (isCopied ? " copied" : "");
      btnCopy.dataset.defaultTitle = defaultCopyTitle;
      btnCopy.setAttribute("aria-label", defaultCopyTitle);
      updateCopyButtonDOM(btnCopy, isCopied, defaultCopyTitle);
      btnCopy.addEventListener("click", () => {
        copyTaskContentToClipboard(task);
      });
      actionsCol.appendChild(btnCopy);
    }

    if (hasDescription) {
      const isOpen = state.openDescriptions.has(task.id);
      const btnDesc = document.createElement("button");
      btnDesc.type = "button";
      btnDesc.className = "task-action-btn btn-toggle-desc";
      btnDesc.title = "Đóng/mở mô tả chi tiết";
      btnDesc.textContent = isOpen ? "🔼 Ẩn mô tả" : "📝 Mô tả";
      btnDesc.addEventListener("click", () => {
        if (state.openDescriptions.has(task.id)) {
          state.openDescriptions.delete(task.id);
          state.expandedDescriptions.delete(task.id);
        } else {
          state.openDescriptions.add(task.id);
        }
        renderTaskList();
      });
      actionsCol.appendChild(btnDesc);
    }

    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "task-action-btn btn-edit-task";
    btnEdit.title = "Chỉnh sửa công việc";
    btnEdit.textContent = "✏️ Sửa";
    btnEdit.addEventListener("click", () => {
      startEditTask(task.id);
    });

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.className = "task-action-btn btn-delete-task";
    btnDelete.title = "Xóa công việc";
    btnDelete.textContent = "🗑️";
    btnDelete.addEventListener("click", () => {
      deleteTask(task.id);
    });

    actionsCol.appendChild(btnEdit);
    actionsCol.appendChild(btnDelete);

    mainRow.appendChild(checkbox);
    mainRow.appendChild(contentCol);
    mainRow.appendChild(actionsCol);
    card.appendChild(mainRow);

    if (hasDescription) {
      const isOpen = state.openDescriptions.has(task.id);
      const isExpanded = state.expandedDescriptions.has(task.id);
      const descBox = document.createElement("div");
      descBox.className =
        "task-desc-box" + (isOpen ? " open" : "") + (isExpanded ? " expanded" : "");

      const descText = document.createElement("div");
      descText.className = "task-desc-text";
      descText.textContent = task.description;

      const likelyMultiline =
        task.description.split(/\r?\n/).length > 2 || task.description.length > 110;
      const btnExpand = document.createElement("button");
      btnExpand.type = "button";
      btnExpand.className =
        "btn-expand-desc" + (!isExpanded && !likelyMultiline ? " hidden-toggle" : "");
      btnExpand.textContent = isExpanded ? "Thu gọn ▴" : "Xem thêm ▾";
      btnExpand.addEventListener("click", () => {
        if (state.expandedDescriptions.has(task.id)) {
          state.expandedDescriptions.delete(task.id);
        } else {
          state.expandedDescriptions.add(task.id);
        }
        renderTaskList();
      });

      descBox.appendChild(descText);
      descBox.appendChild(btnExpand);
      card.appendChild(descBox);
    }

    return card;
  }

  function createPrioritySectionDOM(prioKey, prioTasks, collapseKey) {
    const section = document.createElement("div");
    section.className = "priority-section";
    section.dataset.priorityGroup = prioKey;

    const effectiveKey = collapseKey || prioKey;
    const isCollapsed = state.collapsedPriorityGroups.has(effectiveKey);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "priority-header prio-" + prioKey;
    header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    header.title = isCollapsed
      ? "Nhấn để hiển thị nhóm Priority"
      : "Nhấn để ẩn/thu gọn nhóm Priority";

    const leftWrap = document.createElement("span");
    leftWrap.className = "section-header-left";

    const chevron = document.createElement("span");
    chevron.className = "section-chevron";
    chevron.textContent = isCollapsed ? "▸" : "▾";

    const flagSvg = createPriorityFlagSvg(prioKey);

    const titleSpan = document.createElement("span");
    titleSpan.textContent = PRIORITY_META[prioKey].sectionLabel;

    leftWrap.appendChild(chevron);
    leftWrap.appendChild(flagSvg);
    leftWrap.appendChild(titleSpan);

    const doneInPrio = prioTasks.filter((t) => t.status === "done").length;
    const countSpan = document.createElement("span");
    countSpan.textContent = `${prioTasks.length} công việc • Hoàn thành ${doneInPrio}/${prioTasks.length}`;

    header.appendChild(leftWrap);
    header.appendChild(countSpan);
    header.addEventListener("click", () => {
      if (state.collapsedPriorityGroups.has(effectiveKey)) {
        state.collapsedPriorityGroups.delete(effectiveKey);
      } else {
        state.collapsedPriorityGroups.add(effectiveKey);
      }
      renderTaskList();
    });

    const body = document.createElement("div");
    body.className = "priority-section-body" + (isCollapsed ? " section-collapsed-body" : "");
    sortTasksDoneAtBottom(prioTasks).forEach((t) => {
      body.appendChild(createTaskCardDOM(t));
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  function createCategoryGroupSectionDOM(groupName, groupTasks, collapseKey, nestPriorityInside) {
    const section = document.createElement("div");
    section.className = "group-section";
    section.dataset.groupName = groupName;

    const effectiveKey = collapseKey || groupName;
    const isCollapsed = state.collapsedCategoryGroups.has(effectiveKey);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "group-header";
    header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    header.title = isCollapsed ? "Nhấn để hiển thị nhóm công việc" : "Nhấn để thu gọn nhóm công việc";

    const leftWrap = document.createElement("span");
    leftWrap.className = "section-header-left";

    const chevron = document.createElement("span");
    chevron.className = "section-chevron";
    chevron.textContent = isCollapsed ? "▸" : "▾";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = "📁 " + groupName;

    leftWrap.appendChild(chevron);
    leftWrap.appendChild(titleSpan);

    const allInGroup = state.tasks.filter((t) => (t.group || "Công việc") === groupName);
    const doneInGroup = allInGroup.filter((t) => t.status === "done").length;
    const countSpan = document.createElement("span");
    countSpan.textContent = `${groupTasks.length} hiển thị • Hoàn thành ${doneInGroup}/${allInGroup.length}`;

    header.appendChild(leftWrap);
    header.appendChild(countSpan);
    header.addEventListener("click", () => {
      if (state.collapsedCategoryGroups.has(effectiveKey)) {
        state.collapsedCategoryGroups.delete(effectiveKey);
      } else {
        state.collapsedCategoryGroups.add(effectiveKey);
      }
      renderTaskList();
    });

    const body = document.createElement("div");
    body.className = "group-section-body" + (isCollapsed ? " section-collapsed-body" : "");

    if (nestPriorityInside) {
      PRIORITY_ORDER.forEach((prioKey) => {
        const prioTasks = groupTasks.filter(
          (t) => (VALID_PRIORITIES.includes(t.priority) ? t.priority : "none") === prioKey
        );
        if (prioTasks.length > 0) {
          body.appendChild(
            createPrioritySectionDOM(prioKey, prioTasks, `${groupName}::${prioKey}`)
          );
        }
      });
    } else {
      sortTasksDoneAtBottom(groupTasks).forEach((t) => {
        body.appendChild(createTaskCardDOM(t));
      });
    }

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  function renderTaskList() {
    const container = document.getElementById("taskListContainer");
    clearChildren(container);

    const query = state.searchQuery.trim().toLowerCase();
    const filtered = state.tasks.filter((t) => {
      if (!taskMatchesBaseFilters(t, query)) {
        return false;
      }
      if (
        state.selectedPriorityFilters.size > 0 &&
        !state.selectedPriorityFilters.has(getNormalizedPriority(t))
      ) {
        return false;
      }
      if (state.selectedGroupFilter !== "ALL" && t.group !== state.selectedGroupFilter) {
        return false;
      }
      return true;
    });

    const sortedFiltered = sortTasksDoneAtBottom(filtered);

    if (sortedFiltered.length === 0) {
      const emptyBox = document.createElement("div");
      emptyBox.className = "empty-state-box";
      if (state.tasks.length === 0) {
        emptyBox.textContent =
          "Danh sách công việc đang trống. Nhấn '+ Tạo Task' để thêm công việc mới hoặc 'Pull GitHub' để tải dữ liệu về.";
      } else if (
        state.statusFilter === "todo" &&
        !query &&
        state.selectedGroupFilter === "ALL" &&
        state.selectedPriorityFilters.size === 0
      ) {
        emptyBox.textContent =
          "🎉 Không còn công việc nào ở trạng thái Chưa làm! Chuyển sang mục 'Tất cả' hoặc 'Đã xong' để xem các việc đã hoàn thành.";
      } else {
        emptyBox.textContent = "Không có công việc nào khớp với bộ lọc hiện tại.";
      }
      container.appendChild(emptyBox);
      return;
    }

    if (state.groupByCategory) {
      const orderedGroupNames = state.groups.slice();
      sortedFiltered.forEach((task) => {
        const gName = task.group || "Công việc";
        if (!orderedGroupNames.includes(gName)) {
          orderedGroupNames.push(gName);
        }
      });

      orderedGroupNames.forEach((groupName) => {
        const groupTasks = sortedFiltered.filter((t) => (t.group || "Công việc") === groupName);
        if (groupTasks.length > 0) {
          container.appendChild(
            createCategoryGroupSectionDOM(groupName, groupTasks, groupName, state.groupByPriority)
          );
        }
      });
    } else if (state.groupByPriority) {
      PRIORITY_ORDER.forEach((prioKey) => {
        const prioTasks = sortedFiltered.filter(
          (t) => (VALID_PRIORITIES.includes(t.priority) ? t.priority : "none") === prioKey
        );
        if (prioTasks.length > 0) {
          container.appendChild(createPrioritySectionDOM(prioKey, prioTasks, prioKey));
        }
      });
    } else {
      sortedFiltered.forEach((t) => {
        container.appendChild(createTaskCardDOM(t));
      });
    }

    refreshDescriptionOverflowButtons();
  }

  function renderGroupCrudList() {
    const listEl = document.getElementById("groupCrudList");
    if (!listEl) return;
    clearChildren(listEl);

    state.groups.forEach((grpName, idx) => {
      const item = document.createElement("div");
      item.className = "group-crud-item";
      item.dataset.groupItem = grpName;

      const tasksInGroup = state.tasks.filter((t) => t.group === grpName);
      const doneInGroup = tasksInGroup.filter((t) => t.status === "done").length;

      const mainRow = document.createElement("div");
      mainRow.className = "group-crud-main";

      const infoWrap = document.createElement("div");
      infoWrap.className = "group-crud-info";

      const nameEl = document.createElement("span");
      nameEl.className = "group-crud-name";
      nameEl.textContent = "📁 " + grpName;

      const countBadge = document.createElement("span");
      countBadge.className = "group-crud-count";
      countBadge.textContent = `${tasksInGroup.length} công việc (${doneInGroup} xong)`;

      infoWrap.appendChild(nameEl);
      infoWrap.appendChild(countBadge);

      const actionsWrap = document.createElement("div");
      actionsWrap.className = "group-crud-actions";

      const btnUp = document.createElement("button");
      btnUp.type = "button";
      btnUp.className = "task-action-btn btn-move-group-up";
      btnUp.textContent = "↑";
      btnUp.title = "Đưa nhóm lên trên";
      btnUp.disabled = idx === 0;
      btnUp.addEventListener("click", () => {
        moveGroupOrder(idx, -1);
      });

      const btnDown = document.createElement("button");
      btnDown.type = "button";
      btnDown.className = "task-action-btn btn-move-group-down";
      btnDown.textContent = "↓";
      btnDown.title = "Đưa nhóm xuống dưới";
      btnDown.disabled = idx === state.groups.length - 1;
      btnDown.addEventListener("click", () => {
        moveGroupOrder(idx, 1);
      });

      const btnRename = document.createElement("button");
      btnRename.type = "button";
      btnRename.className = "task-action-btn btn-rename-group";
      btnRename.textContent = "✏️ Đổi tên";
      btnRename.title = "Sửa tên nhóm";
      btnRename.addEventListener("click", () => {
        state.deletingGroupName = null;
        state.editingGroupName = state.editingGroupName === grpName ? null : grpName;
        renderGroupCrudList();
      });

      const btnDelete = document.createElement("button");
      btnDelete.type = "button";
      btnDelete.className = "task-action-btn btn-delete-group";
      btnDelete.textContent = "🗑️ Xóa";
      btnDelete.title = "Xóa nhóm";
      btnDelete.addEventListener("click", () => {
        handleRequestDeleteGroup(grpName);
      });

      actionsWrap.appendChild(btnUp);
      actionsWrap.appendChild(btnDown);
      actionsWrap.appendChild(btnRename);
      actionsWrap.appendChild(btnDelete);

      mainRow.appendChild(infoWrap);
      mainRow.appendChild(actionsWrap);
      item.appendChild(mainRow);

      if (state.editingGroupName === grpName) {
        const renameRow = document.createElement("div");
        renameRow.className = "group-rename-row";

        const renameInput = document.createElement("input");
        renameInput.type = "text";
        renameInput.className = "ext-input group-rename-input";
        renameInput.value = grpName;
        renameInput.style.flex = "1";

        const btnSaveRename = document.createElement("button");
        btnSaveRename.type = "button";
        btnSaveRename.className = "btn-primary btn-save-rename-group";
        btnSaveRename.textContent = "💾 Lưu tên";
        btnSaveRename.addEventListener("click", () => {
          executeRenameGroup(grpName, renameInput.value);
        });

        const btnCancelRename = document.createElement("button");
        btnCancelRename.type = "button";
        btnCancelRename.className = "btn-secondary btn-cancel-rename-group";
        btnCancelRename.textContent = "Hủy";
        btnCancelRename.addEventListener("click", () => {
          state.editingGroupName = null;
          renderGroupCrudList();
        });

        renameInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            executeRenameGroup(grpName, renameInput.value);
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            state.editingGroupName = null;
            renderGroupCrudList();
          }
        });

        renameRow.appendChild(renameInput);
        renameRow.appendChild(btnSaveRename);
        renameRow.appendChild(btnCancelRename);
        item.appendChild(renameRow);
      }

      if (state.deletingGroupName === grpName && tasksInGroup.length > 0) {
        const confirmRow = document.createElement("div");
        confirmRow.className = "group-delete-confirm-row";

        const msgEl = document.createElement("div");
        msgEl.className = "group-delete-confirm-text";
        msgEl.textContent = `⚠️ Nhóm "${grpName}" đang có ${tasksInGroup.length} công việc. Chọn cách xử lý:`;

        const targetSelect = document.createElement("select");
        targetSelect.className = "ext-select group-reassign-select";
        targetSelect.style.flex = "1";
        state.groups
          .filter((g) => g !== grpName)
          .forEach((otherGrp) => {
            const opt = document.createElement("option");
            opt.value = otherGrp;
            opt.textContent = "Chuyển việc sang: 📁 " + otherGrp;
            targetSelect.appendChild(opt);
          });

        const btnReassign = document.createElement("button");
        btnReassign.type = "button";
        btnReassign.className = "btn-primary btn-confirm-reassign-group";
        btnReassign.textContent = "↪ Chuyển việc & Xóa nhóm";
        btnReassign.addEventListener("click", () => {
          executeDeleteGroup(grpName, "reassign", targetSelect.value);
        });

        const btnDeleteAll = document.createElement("button");
        btnDeleteAll.type = "button";
        btnDeleteAll.className = "btn-danger-sm btn-confirm-delete-with-tasks";
        btnDeleteAll.textContent = `🗑️ Xóa nhóm & ${tasksInGroup.length} việc`;
        btnDeleteAll.addEventListener("click", () => {
          executeDeleteGroup(grpName, "delete_tasks", null);
        });

        const btnCancelDel = document.createElement("button");
        btnCancelDel.type = "button";
        btnCancelDel.className = "btn-secondary btn-cancel-delete-group";
        btnCancelDel.textContent = "Hủy";
        btnCancelDel.addEventListener("click", () => {
          state.deletingGroupName = null;
          renderGroupCrudList();
        });

        confirmRow.appendChild(msgEl);
        confirmRow.appendChild(targetSelect);
        confirmRow.appendChild(btnReassign);
        confirmRow.appendChild(btnDeleteAll);
        confirmRow.appendChild(btnCancelDel);
        item.appendChild(confirmRow);
      }

      listEl.appendChild(item);
    });
  }

  function renderAll() {
    renderFiltersAndCounters();
    renderTaskList();
    renderGroupCrudList();
    renderFormImagePreviews();
    updateHeaderAndFooterMeta();
  }

  /* ========================================================================
     7. TASK CRUD & GROUP MANAGEMENT
     ======================================================================== */
  async function handleFilesSelected(fileList) {
    if (!fileList || fileList.length === 0) return;
    const imageFiles = Array.from(fileList).filter(
      (f) => f && typeof f.type === "string" && ALLOWED_IMAGE_MIMES.has(f.type.toLowerCase())
    );
    if (imageFiles.length === 0) {
      showBanner("Vui lòng chỉ chọn file hình ảnh raster hợp lệ (PNG, JPG, WebP, GIF).", "error");
      return;
    }

    const remainingSlots = MAX_IMAGE_COUNT_PER_TASK - state.pendingFormImages.length;
    if (remainingSlots <= 0) {
      showBanner(`Mỗi công việc đính kèm tối đa ${MAX_IMAGE_COUNT_PER_TASK} ảnh.`, "error");
      return;
    }

    const toProcess = imageFiles.slice(0, remainingSlots);
    let added = 0;
    for (const file of toProcess) {
      try {
        const compressed = await compressImageFileToDataUrl(file);
        state.pendingFormImages.push(compressed);
        added++;
      } catch (err) {
        showBanner(err.message || "Không thể xử lý ảnh đính kèm.", "error");
      }
    }

    renderFormImagePreviews();
    if (added > 0) {
      showBanner(`Đã đính kèm ${added} hình ảnh.`, "success");
    }
  }

  async function saveNewGroup() {
    const input = document.getElementById("newGroupInput");
    const groupName = input.value.trim();
    if (!groupName) {
      showBanner("Vui lòng nhập tên nhóm mới.", "error");
      input.focus();
      return;
    }

    const existingMatch = state.groups.find((g) => g.toLowerCase() === groupName.toLowerCase());
    if (existingMatch) {
      input.value = "";
      document.getElementById("newGroupRow").classList.remove("open");
      document.getElementById("taskGroupSelect").value = existingMatch;
      showBanner(`Đã chọn nhóm "${existingMatch}" hiện có.`, "info");
      return;
    }

    const prevGroups = state.groups.slice();
    state.groups.push(groupName);

    try {
      await persistAllToStorage();
      input.value = "";
      document.getElementById("newGroupRow").classList.remove("open");
      renderAll();
      document.getElementById("taskGroupSelect").value = groupName;
      showBanner(`Đã sẵn sàng nhóm "${groupName}".`, "success");
    } catch (err) {
      state.groups = prevGroups;
      showBanner(err.message || "Không thể lưu nhóm mới.", "error");
    }
  }

  async function handleCrudAddGroup(e) {
    if (e) e.preventDefault();
    if (state.isSyncing) return;

    const input = document.getElementById("crudNewGroupInput");
    const groupName = input.value.trim();
    if (!groupName) {
      showBanner("Vui lòng nhập tên nhóm mới cần tạo.", "error");
      input.focus();
      return;
    }

    if (state.groups.some((g) => g.toLowerCase() === groupName.toLowerCase())) {
      showBanner(`Nhóm "${groupName}" đã tồn tại!`, "error");
      input.focus();
      return;
    }

    const prevGroups = state.groups.slice();
    state.groups.push(groupName);

    try {
      await persistAllToStorage();
      input.value = "";
      renderAll();
      showBanner(`Đã thêm nhóm "${groupName}" thành công!`, "success");
    } catch (err) {
      state.groups = prevGroups;
      showBanner(err.message || "Không thể thêm nhóm mới.", "error");
    }
  }

  async function moveGroupOrder(index, delta) {
    if (state.isSyncing) return;
    const targetIdx = index + delta;
    if (index < 0 || index >= state.groups.length || targetIdx < 0 || targetIdx >= state.groups.length) {
      return;
    }

    const prevGroups = state.groups.slice();
    const temp = state.groups[index];
    state.groups[index] = state.groups[targetIdx];
    state.groups[targetIdx] = temp;

    try {
      await persistAllToStorage();
      renderAll();
    } catch (err) {
      state.groups = prevGroups;
      renderAll();
      showBanner(err.message || "Không thể thay đổi thứ tự nhóm.", "error");
    }
  }

  async function executeRenameGroup(oldName, rawNewName) {
    if (state.isSyncing) return;
    const newName = String(rawNewName || "").trim();
    if (!newName) {
      showBanner("Tên nhóm không được để trống!", "error");
      return;
    }

    if (newName === oldName) {
      state.editingGroupName = null;
      renderGroupCrudList();
      return;
    }

    const duplicateOther = state.groups.some(
      (g) => g !== oldName && g.toLowerCase() === newName.toLowerCase()
    );
    if (duplicateOther) {
      showBanner(`Tên nhóm "${newName}" bị trùng với nhóm đã có!`, "error");
      return;
    }

    const prevGroups = state.groups.slice();
    const prevTasks = state.tasks.map((t) => Object.assign({}, t));
    const prevSelectedFilter = state.selectedGroupFilter;
    const prevSyncMeta = Object.assign({}, state.syncMeta);

    state.groups = state.groups.map((g) => (g === oldName ? newName : g));

    let updatedCount = 0;
    const nowIso = new Date().toISOString();
    state.tasks.forEach((t) => {
      if (t.group === oldName) {
        t.group = newName;
        t.updatedAt = nowIso;
        updatedCount++;
      }
    });

    if (state.selectedGroupFilter === oldName) {
      state.selectedGroupFilter = newName;
    }

    if (updatedCount > 0) {
      markWorkingTreeDirty();
    }

    try {
      await persistAllToStorage();
      state.editingGroupName = null;
      renderAll();
      showBanner(
        `Đã đổi tên nhóm "${oldName}" → "${newName}" (cập nhật ${updatedCount} công việc).`,
        "success"
      );
    } catch (err) {
      state.groups = prevGroups;
      state.tasks = prevTasks;
      state.selectedGroupFilter = prevSelectedFilter;
      state.syncMeta = prevSyncMeta;
      renderAll();
      showBanner(err.message || "Không thể đổi tên nhóm.", "error");
    }
  }

  function handleRequestDeleteGroup(grpName) {
    if (state.isSyncing) return;
    if (state.groups.length <= 1) {
      showBanner("Cần giữ lại ít nhất 1 nhóm công việc mặc định!", "error");
      return;
    }

    const tasksInGroup = state.tasks.filter((t) => t.group === grpName);
    if (tasksInGroup.length === 0) {
      executeDeleteGroup(grpName, "empty", null);
      return;
    }

    state.editingGroupName = null;
    state.deletingGroupName = state.deletingGroupName === grpName ? null : grpName;
    renderGroupCrudList();
  }

  async function executeDeleteGroup(grpName, actionMode, reassignTarget) {
    if (state.isSyncing) return;
    if (state.groups.length <= 1) {
      showBanner("Cần giữ lại ít nhất 1 nhóm công việc mặc định!", "error");
      return;
    }

    const prevGroups = state.groups.slice();
    const prevTasks = state.tasks.map((t) => Object.assign({}, t));
    const prevSelectedFilter = state.selectedGroupFilter;
    const prevSyncMeta = Object.assign({}, state.syncMeta);

    state.groups = state.groups.filter((g) => g !== grpName);
    const fallbackGroup = reassignTarget && state.groups.includes(reassignTarget)
      ? reassignTarget
      : state.groups[0];

    let affectedTasks = 0;
    const nowIso = new Date().toISOString();

    if (actionMode === "reassign") {
      state.tasks.forEach((t) => {
        if (t.group === grpName) {
          t.group = fallbackGroup;
          t.updatedAt = nowIso;
          affectedTasks++;
        }
      });
    } else if (actionMode === "delete_tasks") {
      const removedIds = new Set();
      state.tasks = state.tasks.filter((t) => {
        if (t.group === grpName) {
          removedIds.add(t.id);
          affectedTasks++;
          return false;
        }
        return true;
      });
      removedIds.forEach((id) => {
        state.openDescriptions.delete(id);
        state.expandedDescriptions.delete(id);
      });
      const activeEditId = document.getElementById("taskEditId").value.trim();
      if (activeEditId && removedIds.has(activeEditId)) {
        resetTaskForm();
      }
    }

    if (state.selectedGroupFilter === grpName) {
      state.selectedGroupFilter = "ALL";
    }

    if (affectedTasks > 0) {
      markWorkingTreeDirty();
    }

    try {
      await persistAllToStorage();
      state.deletingGroupName = null;
      renderAll();
      if (actionMode === "reassign") {
        showBanner(
          `Đã chuyển ${affectedTasks} công việc sang "${fallbackGroup}" và xóa nhóm "${grpName}".`,
          "info"
        );
      } else if (actionMode === "delete_tasks") {
        showBanner(`Đã xóa nhóm "${grpName}" cùng ${affectedTasks} công việc bên trong.`, "info");
      } else {
        showBanner(`Đã xóa nhóm "${grpName}".`, "info");
      }
    } catch (err) {
      state.groups = prevGroups;
      state.tasks = prevTasks;
      state.selectedGroupFilter = prevSelectedFilter;
      state.syncMeta = prevSyncMeta;
      renderAll();
      showBanner(err.message || "Không thể xóa nhóm.", "error");
    }
  }

  function resetTaskForm() {
    document.getElementById("taskEditId").value = "";
    document.getElementById("taskTitleInput").value = "";
    document.getElementById("taskDescInput").value = "";
    document.getElementById("taskPrioritySelect").value = "none";
    document.getElementById("newGroupInput").value = "";
    document.getElementById("newGroupRow").classList.remove("open");
    document.getElementById("descInputContainer").classList.remove("collapsed");
    state.pendingFormImages = [];
    document.getElementById("formModeTitle").textContent = "➕ Thêm công việc mới";
    document.getElementById("btnSubmitTask").textContent = "➕ Lưu Công Việc";
    renderFormImagePreviews();
  }

  async function handleSaveTaskForm(e) {
    if (e) e.preventDefault();
    if (state.isSyncing) return;

    const editId = document.getElementById("taskEditId").value.trim();
    const title = document.getElementById("taskTitleInput").value.trim();
    const description = document.getElementById("taskDescInput").value.trim();
    const group = document.getElementById("taskGroupSelect").value.trim() || "Công việc";
    const rawPriority = document.getElementById("taskPrioritySelect").value.trim().toLowerCase();
    const priority = VALID_PRIORITIES.includes(rawPriority) ? rawPriority : "none";

    if (!title) {
      showBanner("Tên công việc không được để trống!", "error");
      document.getElementById("taskTitleInput").focus();
      return;
    }

    const prevTasksSnapshot = state.tasks.slice();
    const prevGroupsSnapshot = state.groups.slice();
    const prevSyncMeta = Object.assign({}, state.syncMeta);

    if (!state.groups.includes(group)) {
      state.groups.push(group);
    }

    const nowIso = new Date().toISOString();
    const attachedImages = state.pendingFormImages
      .filter((img) => img && isSafeImageDataUrl(img.dataUrl))
      .slice(0, MAX_IMAGE_COUNT_PER_TASK);

    try {
      let bannerMsg = "Đã thêm công việc mới vào danh sách!";

      if (editId) {
        const idx = state.tasks.findIndex((t) => t.id === editId);
        if (idx !== -1) {
          const updated = {
            id: state.tasks[idx].id,
            title,
            description,
            group,
            priority,
            status: state.tasks[idx].status === "done" ? "done" : "todo",
            updatedAt: nowIso
          };
          if (attachedImages.length > 0) {
            updated.images = attachedImages;
          }
          state.tasks[idx] = updated;
          if (!description) {
            state.openDescriptions.delete(updated.id);
            state.expandedDescriptions.delete(updated.id);
          }
          bannerMsg = "Đã cập nhật công việc thành công!";
        } else {
          const restoredTask = {
            id: editId,
            title,
            description,
            group,
            priority,
            status: "todo",
            updatedAt: nowIso
          };
          if (attachedImages.length > 0) {
            restoredTask.images = attachedImages;
          }
          state.tasks.unshift(restoredTask);
          if (state.statusFilter === "done") {
            state.statusFilter = "todo";
          }
          bannerMsg =
            "Công việc gốc không còn tồn tại nên đã được lưu lại thành công việc mới!";
        }
      } else {
        const newTask = {
          id: generateTaskId(),
          title,
          description,
          group,
          priority,
          status: "todo",
          updatedAt: nowIso
        };
        if (attachedImages.length > 0) {
          newTask.images = attachedImages;
        }
        state.tasks.unshift(newTask);
        if (state.statusFilter === "done") {
          state.statusFilter = "todo";
        }
        if (state.selectedGroupFilter !== "ALL" && state.selectedGroupFilter !== group) {
          state.selectedGroupFilter = "ALL";
        }
        if (state.selectedPriorityFilters.size > 0 && !state.selectedPriorityFilters.has(priority)) {
          state.selectedPriorityFilters.clear();
        }
      }

      state.collapsedCategoryGroups.delete(group);
      state.collapsedPriorityGroups.delete(priority);
      state.collapsedPriorityGroups.delete(`${group}::${priority}`);

      markWorkingTreeDirty();
      await persistAllToStorage();
      resetTaskForm();
      renderAll();
      switchTab("tasks");
      showBanner(bannerMsg, "success");
    } catch (err) {
      state.tasks = prevTasksSnapshot;
      state.groups = prevGroupsSnapshot;
      state.syncMeta = prevSyncMeta;
      showBanner(err.message || "Không thể lưu công việc.", "error");
    }
  }

  function startEditTask(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (task.group && !state.groups.includes(task.group)) {
      state.groups.push(task.group);
      renderFiltersAndCounters();
    }

    document.getElementById("taskEditId").value = task.id;
    document.getElementById("taskTitleInput").value = task.title;
    document.getElementById("taskDescInput").value = task.description || "";
    document.getElementById("taskGroupSelect").value = task.group || state.groups[0];
    document.getElementById("taskPrioritySelect").value = VALID_PRIORITIES.includes(task.priority)
      ? task.priority
      : "none";
    document.getElementById("descInputContainer").classList.remove("collapsed");

    state.pendingFormImages = Array.isArray(task.images)
      ? task.images.map((img) => ({ id: img.id, name: img.name, dataUrl: img.dataUrl }))
      : [];

    document.getElementById("formModeTitle").textContent = "✏️ Chỉnh sửa công việc";
    document.getElementById("btnSubmitTask").textContent = "💾 Cập nhật Công Việc";
    renderFormImagePreviews();

    switchTab("add");
    document.getElementById("taskTitleInput").focus();
  }

  async function toggleTaskStatus(taskId) {
    if (state.isSyncing) return;
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const prevStatus = task.status;
    const prevUpdated = task.updatedAt;
    const prevSyncMeta = Object.assign({}, state.syncMeta);

    task.status = task.status === "done" ? "todo" : "done";
    task.updatedAt = new Date().toISOString();
    markWorkingTreeDirty();

    try {
      await persistAllToStorage();
      renderAll();

      if (task.status === "done") {
        if (state.statusFilter === "todo") {
          showBanner("Đã đánh dấu Đã xong!", "info", {
            label: "Xem Tất cả / Đã xong",
            onClick: () => {
              state.statusFilter = "all";
              renderAll();
              hideBanner();
            }
          });
        } else {
          showBanner("Đã đánh dấu Đã xong (tự động chuyển xuống cuối danh sách).", "info");
        }
      } else {
        showBanner("Đã chuyển công việc về trạng thái Chưa làm.", "info");
      }
    } catch (err) {
      task.status = prevStatus;
      task.updatedAt = prevUpdated;
      state.syncMeta = prevSyncMeta;
      renderAll();
      showBanner(err.message || "Không thể cập nhật trạng thái công việc.", "error");
    }
  }

  async function deleteTask(taskId) {
    if (state.isSyncing) return;
    const prevTasks = state.tasks.slice();
    const prevSyncMeta = Object.assign({}, state.syncMeta);
    const wasOpenDesc = state.openDescriptions.has(taskId);
    const wasExpandedDesc = state.expandedDescriptions.has(taskId);

    state.tasks = state.tasks.filter((t) => t.id !== taskId);
    state.openDescriptions.delete(taskId);
    state.expandedDescriptions.delete(taskId);
    markWorkingTreeDirty();

    try {
      await persistAllToStorage();
      if (document.getElementById("taskEditId").value.trim() === taskId) {
        resetTaskForm();
      }
      renderAll();
      showBanner("Đã xóa công việc.", "info");
    } catch (err) {
      state.tasks = prevTasks;
      state.syncMeta = prevSyncMeta;
      if (wasOpenDesc) {
        state.openDescriptions.add(taskId);
      }
      if (wasExpandedDesc) {
        state.expandedDescriptions.add(taskId);
      }
      renderAll();
      showBanner(err.message || "Không thể xóa công việc.", "error");
    }
  }

  /* ========================================================================
     8. GITHUB CONTENTS API (PULL / PUSH / CONFLICT 409)
     ======================================================================== */
  function buildGitHubHeaders(token, includeJsonBody) {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (includeJsonBody) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  function isRateLimitedResponse(response) {
    if (response.status === 429) return true;
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") return true;
    }
    return false;
  }

  async function readJsonSafe(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async function githubGetFile(cfg) {
    const { apiUrl, blobsBaseUrl, encodedRefQuery } = getGitHubEndpoints(cfg);
    const response = await fetchWithTimeout(
      `${apiUrl}?ref=${encodedRefQuery}`,
      {
        method: "GET",
        cache: "no-store",
        headers: buildGitHubHeaders(cfg.token, false)
      },
      FETCH_TIMEOUT_MS
    );

    if (response.status === 401) {
      throw new Error(
        "Xác thực thất bại (401): Personal Access Token không hợp lệ hoặc đã hết hạn."
      );
    }
    if (isRateLimitedResponse(response)) {
      throw new Error(
        `Vượt giới hạn tần suất gọi GitHub API (${response.status} Rate Limit). Vui lòng thử lại sau ít phút.`
      );
    }
    if (response.status === 403) {
      throw new Error(
        "Từ chối truy cập (403): Token thiếu quyền 'Contents: Read and write' cho repository này."
      );
    }
    if (response.status === 404) {
      const errBody = await readJsonSafe(response);
      const apiMsg = errBody && typeof errBody.message === "string" ? errBody.message : "";
      if (/no commit found for the ref/i.test(apiMsg)) {
        throw new Error(
          `Nhánh (Branch) "${cfg.branch}" không tồn tại trên kho lưu trữ GitHub (404).`
        );
      }
      return { status: 404, data: null };
    }
    if (!response.ok) {
      throw new Error(`GitHub API trả về lỗi (${response.status}) khi kiểm tra file.`);
    }

    const data = await readJsonSafe(response);
    if (!data || typeof data !== "object") {
      throw new Error("Phản hồi từ GitHub API không phải JSON hợp lệ.");
    }

    if (Array.isArray(data)) {
      throw new Error(
        "Đường dẫn cấu hình đang trỏ tới một thư mục trên GitHub thay vì file JSON."
      );
    }

    const fileSize = Number(data.size || 0);
    if (fileSize > MAX_SAFE_REMOTE_BYTES) {
      throw new Error(
        "File dữ liệu trên GitHub vượt quá giới hạn an toàn 8 MB của bộ nhớ cục bộ Extension."
      );
    }

    const hasInlineContent = typeof data.content === "string" && data.content.replace(/\s+/g, "").length > 0;
    if (fileSize > 0 && !hasInlineContent) {
      if (!data.sha) {
        throw new Error("GitHub API không trả về nội dung file lớn (>1 MB). Đã dừng ghi đè cục bộ.");
      }
      const blobResp = await fetchWithTimeout(
        `${blobsBaseUrl}/${encodeURIComponent(data.sha)}`,
        {
          method: "GET",
          cache: "no-store",
          headers: buildGitHubHeaders(cfg.token, false)
        },
        FETCH_TIMEOUT_MS
      );
      if (!blobResp.ok) {
        throw new Error(
          `Không thể tải nội dung file lớn qua Git Blobs API (${blobResp.status}). Đã dừng ghi đè cục bộ.`
        );
      }
      const blobData = await readJsonSafe(blobResp);
      if (!blobData || typeof blobData.content !== "string" || !blobData.content.trim()) {
        throw new Error("Nội dung Git Blob trả về trống cho file có kích thước > 0. Đã dừng ghi đè.");
      }
      data.content = blobData.content;
      data.encoding = "base64";
    }

    return { status: 200, data };
  }

  async function githubPutFile(cfg, tasksArray, shaToSend) {
    const { apiUrl } = getGitHubEndpoints(cfg);
    const serialized = tasksArray.map(serializeTaskForExport);
    const jsonContent = JSON.stringify(serialized, null, 2);
    const contentBase64 = utf8ToBase64(jsonContent);

    const payload = {
      message: `Sync ${serialized.length} tasks via GitTask Sync`,
      content: contentBase64,
      branch: cfg.branch
    };
    if (shaToSend) {
      payload.sha = shaToSend;
    }

    const response = await fetchWithTimeout(
      apiUrl,
      {
        method: "PUT",
        cache: "no-store",
        headers: buildGitHubHeaders(cfg.token, true),
        body: JSON.stringify(payload)
      },
      FETCH_TIMEOUT_MS
    );

    if (response.status === 401) {
      throw new Error(
        "Xác thực thất bại (401): Personal Access Token không hợp lệ hoặc đã hết hạn."
      );
    }
    if (isRateLimitedResponse(response)) {
      throw new Error(
        `Vượt giới hạn tần suất gọi GitHub API (${response.status} Rate Limit). Vui lòng thử lại sau ít phút.`
      );
    }
    if (response.status === 403) {
      throw new Error(
        "Từ chối truy cập (403): Token thiếu quyền 'Contents: Read and write' cho repository này."
      );
    }
    if (response.status === 404) {
      throw new Error(
        "Không tìm thấy Repository hoặc Nhánh trên GitHub (404). Hãy kiểm tra lại Owner/Repo/Branch và quyền Read & Write của Token."
      );
    }
    if (response.status === 409) {
      return { status: 409, conflict: true };
    }
    if (response.status === 422) {
      const errBody = await readJsonSafe(response);
      const apiMsg = errBody && typeof errBody.message === "string" ? errBody.message : "";
      if (/\bsha\b|does not match/i.test(apiMsg)) {
        return { status: 422, conflict: true };
      }
      const detail = apiMsg ? `: ${sanitizeErrorMessage(apiMsg, cfg.token)}` : ".";
      throw new Error(`GitHub từ chối dữ liệu (422 Unprocessable Entity)${detail}`);
    }
    if (!response.ok) {
      throw new Error(`Lỗi khi Push lên GitHub (${response.status}).`);
    }

    const data = await readJsonSafe(response);
    if (!data || typeof data !== "object") {
      throw new Error("Phản hồi sau khi Push từ GitHub không hợp lệ.");
    }

    return { status: response.status, conflict: false, data };
  }

  function requireValidConfigOrRedirect() {
    const check = validateGitHubConfig(state.githubConfig);
    if (!check.valid) {
      switchTab("settings");
      showBanner(check.error, "error");
      return null;
    }
    return check.normalized;
  }

  async function pauseAutoPushOnConflict(reasonText) {
    if (state.syncMeta && state.syncMeta.dirty) {
      state.syncMeta.autoPushPausedReason = reasonText || "Xung đột GitHub";
      try {
        await persistAllToStorage();
      } catch (_) {
        updateTreeStatusUI();
      }
    }
  }

  async function handlePullFromGitHub(isForcePull) {
    if (state.isSyncing) return false;
    const cfg = requireValidConfigOrRedirect();
    if (!cfg) return false;

    setSyncButtonsDisabled(true);
    try {
      showBanner("Đang tải dữ liệu mới nhất từ GitHub...", "info", {
        autoHideMs: FETCH_TIMEOUT_MS + 1000
      });
      const getRes = await githubGetFile(cfg);
      const currentRepoKey = buildRepoKey(cfg);

      if (getRes.status === 404 || !getRes.data) {
        if (isForcePull) {
          const prevTasks = state.tasks.slice();
          const prevMeta = Object.assign({}, state.syncMeta);
          state.tasks = [];
          state.syncMeta = {
            base_sha: null,
            lastSyncAt: new Date().toISOString(),
            syncedRepoKey: currentRepoKey,
            dirty: false,
            firstDirtyAt: null,
            lastDirtyAt: null,
            autoPushPausedReason: null,
            autoPushOwnerId: null
          };
          try {
            await persistAllToStorage();
          } catch (storageErr) {
            state.tasks = prevTasks;
            state.syncMeta = prevMeta;
            throw storageErr;
          }
          if (document.getElementById("taskEditId").value.trim()) {
            resetTaskForm();
          }
          hideConflictAlert();
          renderAll();
          showBanner(
            "Force Pull hoàn tất: File chưa tồn tại hoặc đã bị xóa trên GitHub, đã đồng bộ danh sách trống.",
            "info"
          );
          return true;
        }

        showBanner(
          "File chưa tồn tại trên GitHub (404). Bạn có thể nhấn 'Push GitHub' để khởi tạo file mới.",
          "info"
        );
        return false;
      }

      const remoteSha = String(getRes.data.sha || "");

      if (!isForcePull && state.syncMeta.dirty && state.tasks.length > 0) {
        const localLabel = state.syncMeta.base_sha
          ? `${state.syncMeta.base_sha.slice(0, 7)} (đã sửa)`
          : "cục bộ chưa Push";
        showConflictAlert(
          cfg,
          localLabel,
          remoteSha,
          "Bạn đang có thay đổi công việc cục bộ chưa được Push lên GitHub. Hệ thống tạm dừng Pull để tránh ghi đè mất việc vừa sửa — hãy chọn 'Force Pull' (lấy bản GitHub) hoặc 'Force Push' (ghi đè lên GitHub)."
        );
        showBanner(
          "Tạm dừng Pull để bảo vệ thay đổi cục bộ chưa đồng bộ!",
          "error"
        );
        return false;
      }

      const rawText = base64ToUtf8(getRes.data.content || "").trim();

      let rawTaskArray = [];
      if (rawText.length > 0) {
        let parsedJson;
        try {
          parsedJson = JSON.parse(rawText);
        } catch (_) {
          throw new Error("Nội dung file JSON trên GitHub bị lỗi cú pháp, không thể phân tích.");
        }

        if (Array.isArray(parsedJson)) {
          rawTaskArray = parsedJson;
        } else if (
          parsedJson &&
          typeof parsedJson === "object" &&
          Array.isArray(parsedJson.tasks)
        ) {
          rawTaskArray = parsedJson.tasks;
        } else {
          throw new Error("Cấu trúc dữ liệu trên GitHub không phải mảng danh sách công việc hợp lệ.");
        }
      }

      const nextTasks = normalizeTaskList(rawTaskArray, true);
      const nextGroups = state.groups.slice();
      nextTasks.forEach((t) => {
        if (t.group && !nextGroups.includes(t.group)) {
          nextGroups.push(t.group);
        }
      });

      const prevTasks = state.tasks;
      const prevGroups = state.groups;
      const prevMeta = state.syncMeta;

      state.tasks = nextTasks;
      state.groups = nextGroups;
      state.syncMeta = {
        base_sha: remoteSha,
        lastSyncAt: new Date().toISOString(),
        syncedRepoKey: currentRepoKey,
        dirty: false,
        firstDirtyAt: null,
        lastDirtyAt: null,
        autoPushPausedReason: null,
        autoPushOwnerId: null
      };

      try {
        await persistAllToStorage();
      } catch (storageErr) {
        state.tasks = prevTasks;
        state.groups = prevGroups;
        state.syncMeta = prevMeta;
        throw storageErr;
      }

      if (document.getElementById("taskEditId").value.trim()) {
        resetTaskForm();
      }

      hideConflictAlert();
      renderAll();

      showBanner(
        isForcePull
          ? `Force Pull thành công (${state.tasks.length} công việc) — base_sha: ${remoteSha.slice(0, 7)}`
          : `Pull thành công (${state.tasks.length} công việc) — base_sha: ${remoteSha.slice(0, 7)}`,
        "success"
      );
      return true;
    } catch (err) {
      showBanner(sanitizeErrorMessage(err.message, cfg.token), "error");
      return false;
    } finally {
      setSyncButtonsDisabled(false);
      scheduleOrCancelAutoPush();
    }
  }

  async function handlePushToGitHub(isForcePush, options) {
    if (state.isSyncing) return { ok: false };
    const isAutoPush = Boolean(options && options.isAutoPush);

    const cfg = isAutoPush
      ? (function () {
          const check = validateGitHubConfig(state.githubConfig);
          return check.valid ? check.normalized : null;
        })()
      : requireValidConfigOrRedirect();
    if (!cfg) return { ok: false };

    if (!isAutoPush && state.syncMeta.autoPushPausedReason) {
      state.syncMeta.autoPushPausedReason = null;
    }

    const pushStartedLastDirtyAt = state.syncMeta.lastDirtyAt || 0;
    const tasksSnapshot = state.tasks.slice();

    setSyncButtonsDisabled(true);
    try {
      showBanner(
        isAutoPush
          ? "⚡ Auto Push: Đang tự động commit & đẩy thay đổi lên GitHub..."
          : "Đang kiểm tra phiên bản trên GitHub trước khi Push...",
        "info",
        { autoHideMs: FETCH_TIMEOUT_MS + 1000 }
      );

      const currentRepoKey = buildRepoKey(cfg);
      const localBaseSha =
        state.syncMeta.syncedRepoKey === currentRepoKey || !state.syncMeta.syncedRepoKey
          ? state.syncMeta.base_sha
          : null;

      const remoteCheck = await githubGetFile(cfg);
      const remoteSha =
        remoteCheck.status === 200 && remoteCheck.data ? String(remoteCheck.data.sha || "") : null;

      if (!isForcePush) {
        if (remoteSha && localBaseSha && remoteSha !== localBaseSha) {
          await pauseAutoPushOnConflict("Xung đột GitHub");
          showConflictAlert(
            cfg,
            localBaseSha,
            remoteSha,
            "Dữ liệu trên GitHub đã bị sửa đổi từ nơi khác (Remote SHA khác với base_sha cục bộ). Hệ thống đã dừng ghi đè."
          );
          showBanner("Dừng ghi đè: Phát hiện xung đột dữ liệu (Conflict) trên GitHub!", "error");
          return { ok: false, conflict: true, remoteSha };
        }

        if (remoteSha && !localBaseSha) {
          await pauseAutoPushOnConflict("Xung đột GitHub");
          showConflictAlert(
            cfg,
            "chưa đồng bộ",
            remoteSha,
            "File dữ liệu đã tồn tại sẵn trên GitHub nhưng thiết bị này chưa từng Pull về. Đã dừng ghi đè để tránh mất dữ liệu từ xa."
          );
          showBanner(
            "Dừng ghi đè: File đã tồn tại trên GitHub, hãy kiểm tra hoặc Force Pull/Push!",
            "error"
          );
          return { ok: false, conflict: true, remoteSha };
        }

        if (!remoteSha && localBaseSha) {
          await pauseAutoPushOnConflict("File từ xa bị xóa");
          showConflictAlert(
            cfg,
            localBaseSha,
            "đã bị xóa (404)",
            "File trên GitHub đã bị xóa từ nơi khác so với lần đồng bộ trước. Hãy kiểm tra lịch sử commit hoặc nhấn Force Push để tạo lại."
          );
          showBanner("Dừng ghi đè: Phát hiện file trên GitHub đã bị xóa từ xa!", "error");
          return { ok: false, conflict: true, remoteSha: null };
        }
      }

      const shaToUse = isForcePush ? remoteSha : localBaseSha || remoteSha;
      const putRes = await githubPutFile(cfg, tasksSnapshot, shaToUse);

      if (putRes.conflict) {
        await pauseAutoPushOnConflict("Xung đột 409");
        let latestRemoteSha = "đã thay đổi (409)";
        try {
          const recheck = await githubGetFile(cfg);
          if (recheck.status === 200 && recheck.data && recheck.data.sha) {
            latestRemoteSha = recheck.data.sha;
          }
        } catch (_) {
          // Giữ nhãn mặc định nếu không đọc lại được SHA
        }
        showConflictAlert(
          cfg,
          localBaseSha || "chưa đồng bộ",
          latestRemoteSha,
          `GitHub từ chối ghi đè (${putRes.status} Conflict): Dữ liệu trên kho lưu trữ vừa thay đổi từ nơi khác.`
        );
        showBanner("Dừng ghi đè: GitHub trả về lỗi xung đột phiên bản (Conflict)!", "error");
        return { ok: false, conflict: true };
      }

      const newSha =
        putRes.data && putRes.data.content && putRes.data.content.sha
          ? String(putRes.data.content.sha)
          : "";

      const editedDuringPush = Boolean(
        state.syncMeta.dirty && (state.syncMeta.lastDirtyAt || 0) > pushStartedLastDirtyAt
      );

      if (editedDuringPush) {
        const latestEditTs = state.syncMeta.lastDirtyAt || Date.now();
        state.syncMeta = {
          base_sha: newSha || null,
          lastSyncAt: new Date().toISOString(),
          syncedRepoKey: currentRepoKey,
          dirty: true,
          firstDirtyAt: latestEditTs,
          lastDirtyAt: latestEditTs,
          autoPushPausedReason: null,
          autoPushOwnerId: INSTANCE_ID
        };
      } else {
        state.syncMeta = {
          base_sha: newSha || null,
          lastSyncAt: new Date().toISOString(),
          syncedRepoKey: currentRepoKey,
          dirty: false,
          firstDirtyAt: null,
          lastDirtyAt: null,
          autoPushPausedReason: null,
          autoPushOwnerId: null
        };
      }

      hideConflictAlert();
      await persistAllToStorage();
      renderAll();

      showBanner(
        isForcePush
          ? `Force Push hoàn tất! Đã ghi đè lên GitHub (base_sha mới: ${newSha.slice(0, 7)})`
          : isAutoPush
            ? `⚡ Auto Push thành công lên GitHub! (base_sha mới: ${newSha.slice(0, 7)})`
            : `Push thành công lên GitHub! (base_sha mới: ${newSha.slice(0, 7)})`,
        "success"
      );
      return { ok: true, conflict: false, newSha };
    } catch (err) {
      if (isAutoPush && state.syncMeta.dirty) {
        state.syncMeta.autoPushPausedReason = "Lỗi mạng/API";
        try {
          await persistAllToStorage();
        } catch (_) {
          // Giữ trạng thái tạm dừng trong bộ nhớ nếu lưu thất bại
        }
      }
      const safeErr = sanitizeErrorMessage(err.message, cfg.token);
      showBanner(safeErr, "error");
      return { ok: false, error: safeErr };
    } finally {
      setSyncButtonsDisabled(false);
      scheduleOrCancelAutoPush();
    }
  }

  /* ========================================================================
     9. SETTINGS FORM HANDLERS, FLOATING WINDOW & EVENT BINDING
     ======================================================================== */
  function populateSettingsFormFromState() {
    document.getElementById("ghOwnerInput").value = state.githubConfig.owner || "";
    document.getElementById("ghRepoInput").value = state.githubConfig.repo || "";
    document.getElementById("ghBranchInput").value = state.githubConfig.branch || "";
    document.getElementById("ghFilePathInput").value = state.githubConfig.path || "";
    document.getElementById("ghTokenInput").value = state.githubConfig.token || "";
    document.getElementById("ghTokenInput").type = "password";

    const apEnabledEl = document.getElementById("autoPushEnabledInput");
    const apDebValEl = document.getElementById("autoPushDebounceValue");
    const apDebUnitEl = document.getElementById("autoPushDebounceUnit");
    const apMaxValEl = document.getElementById("autoPushMaxWaitValue");
    const apMaxUnitEl = document.getElementById("autoPushMaxWaitUnit");
    const launchModeEl = document.getElementById("launchModeSelect");

    if (apEnabledEl) apEnabledEl.checked = Boolean(state.autoPushConfig.enabled);
    if (apDebValEl) apDebValEl.value = String(state.autoPushConfig.debounceValue || 10);
    if (apDebUnitEl) apDebUnitEl.value = state.autoPushConfig.debounceUnit === "m" ? "m" : "s";
    if (apMaxValEl) apMaxValEl.value = String(state.autoPushConfig.maxWaitValue || 5);
    if (apMaxUnitEl) apMaxUnitEl.value = state.autoPushConfig.maxWaitUnit === "s" ? "s" : "m";
    if (launchModeEl) launchModeEl.value = state.launchMode === "window" ? "window" : "popup";
  }

  async function handleSavePreferences(e) {
    if (e && typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    if (state.isSyncing) return;

    const apEnabledEl = document.getElementById("autoPushEnabledInput");
    const apDebValEl = document.getElementById("autoPushDebounceValue");
    const apDebUnitEl = document.getElementById("autoPushDebounceUnit");
    const apMaxValEl = document.getElementById("autoPushMaxWaitValue");
    const apMaxUnitEl = document.getElementById("autoPushMaxWaitUnit");
    const launchModeEl = document.getElementById("launchModeSelect");

    const rawDeb = Number(apDebValEl ? apDebValEl.value : 10);
    const rawMax = Number(apMaxValEl ? apMaxValEl.value : 5);

    if (!Number.isFinite(rawDeb) || rawDeb < 1 || !Number.isFinite(rawMax) || rawMax < 1) {
      showBanner("Thời gian Delay Auto Push phải là số dương lớn hơn hoặc bằng 1.", "error");
      return;
    }

    const prevAp = Object.assign({}, state.autoPushConfig);
    const prevLaunch = state.launchMode;
    const prevMeta = Object.assign({}, state.syncMeta);

    state.autoPushConfig = {
      enabled: apEnabledEl ? Boolean(apEnabledEl.checked) : true,
      debounceValue: Math.max(1, Math.min(86400, Math.floor(rawDeb))),
      debounceUnit: apDebUnitEl && apDebUnitEl.value === "m" ? "m" : "s",
      maxWaitValue: Math.max(1, Math.min(86400, Math.floor(rawMax))),
      maxWaitUnit: apMaxUnitEl && apMaxUnitEl.value === "s" ? "s" : "m"
    };
    state.launchMode = launchModeEl && launchModeEl.value === "window" ? "window" : "popup";

    if (state.syncMeta.dirty) {
      const now = Date.now();
      if (!state.syncMeta.firstDirtyAt) state.syncMeta.firstDirtyAt = now;
      if (!state.syncMeta.lastDirtyAt) state.syncMeta.lastDirtyAt = now;
      state.syncMeta.autoPushOwnerId = INSTANCE_ID;
      if (state.autoPushConfig.enabled) {
        state.syncMeta.autoPushPausedReason = null;
      }
    }

    try {
      await persistAllToStorage();
      populateSettingsFormFromState();
      renderAll();
      showBanner("Đã lưu cấu hình Auto Push & Cửa sổ nổi!", "success");
    } catch (err) {
      state.autoPushConfig = prevAp;
      state.launchMode = prevLaunch;
      state.syncMeta = prevMeta;
      populateSettingsFormFromState();
      renderAll();
      showBanner(err.message || "Không thể lưu cấu hình Auto Push.", "error");
    }
  }

  async function handleSaveGitHubSettings(e) {
    if (e) e.preventDefault();
    if (state.isSyncing) return;

    const ownerInput = document.getElementById("ghOwnerInput");
    const repoInput = document.getElementById("ghRepoInput");
    const branchInput = document.getElementById("ghBranchInput");
    const pathInput = document.getElementById("ghFilePathInput");
    const quickInput = document.getElementById("ghQuickPathInput");

    const quickRaw = quickInput.value.trim();
    if (quickRaw && (!ownerInput.value.trim() || !repoInput.value.trim())) {
      const parsed = parseQuickGitHubPath(quickRaw);
      if (parsed) {
        ownerInput.value = parsed.owner;
        repoInput.value = parsed.repo;
        if (!branchInput.value.trim()) branchInput.value = parsed.branch;
        if (!pathInput.value.trim()) pathInput.value = parsed.path;
      }
    }

    const candidate = {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: normalizeBranchName(branchInput.value) || "main",
      path: normalizeFilePath(pathInput.value) || "tasks.json",
      token: document.getElementById("ghTokenInput").value.trim()
    };

    const validation = validateGitHubConfig(candidate);
    if (!validation.valid) {
      showBanner(validation.error, "error");
      return;
    }

    const prevConfig = Object.assign({}, state.githubConfig);
    const prevMeta = Object.assign({}, state.syncMeta);
    const prevRepoKey = buildRepoKey(state.githubConfig);
    const nextRepoKey = buildRepoKey(validation.normalized);

    state.githubConfig = validation.normalized;
    const now = Date.now();
    if (prevRepoKey && prevRepoKey !== nextRepoKey) {
      const hasTasks = state.tasks.length > 0;
      state.syncMeta = {
        base_sha: null,
        lastSyncAt: null,
        syncedRepoKey: nextRepoKey,
        dirty: hasTasks,
        firstDirtyAt: hasTasks ? now : null,
        lastDirtyAt: hasTasks ? now : null,
        autoPushPausedReason: null,
        autoPushOwnerId: hasTasks ? INSTANCE_ID : null
      };
      hideConflictAlert();
    } else {
      if (!state.syncMeta.syncedRepoKey) {
        state.syncMeta.syncedRepoKey = nextRepoKey;
      }
      state.syncMeta.autoPushPausedReason = null;
      if (state.syncMeta.dirty) {
        if (!state.syncMeta.firstDirtyAt) state.syncMeta.firstDirtyAt = now;
        if (!state.syncMeta.lastDirtyAt) state.syncMeta.lastDirtyAt = now;
        state.syncMeta.autoPushOwnerId = INSTANCE_ID;
      }
    }

    try {
      await persistAllToStorage();
      branchInput.value = state.githubConfig.branch;
      pathInput.value = state.githubConfig.path;
      quickInput.value = "";
      renderAll();
      showBanner("Đã lưu cấu hình GitHub an toàn vào chrome.storage.local!", "success");
    } catch (err) {
      state.githubConfig = prevConfig;
      state.syncMeta = prevMeta;
      showBanner(sanitizeErrorMessage(err.message, candidate.token), "error");
    }
  }

  async function handleClearGitHubSettings() {
    if (state.isSyncing) return;
    const prevConfig = Object.assign({}, state.githubConfig);
    const prevMeta = Object.assign({}, state.syncMeta);

    state.githubConfig = {
      owner: "",
      repo: "",
      branch: "",
      path: "",
      token: ""
    };
    state.syncMeta = {
      base_sha: null,
      lastSyncAt: null,
      syncedRepoKey: null,
      dirty: false,
      firstDirtyAt: null,
      lastDirtyAt: null,
      autoPushPausedReason: null,
      autoPushOwnerId: null
    };

    try {
      await persistAllToStorage();
      document.getElementById("ghQuickPathInput").value = "";
      populateSettingsFormFromState();
      hideConflictAlert();
      renderAll();
      showBanner("Đã xóa cấu hình GitHub và mã đồng bộ cục bộ.", "info");
    } catch (err) {
      state.githubConfig = prevConfig;
      state.syncMeta = prevMeta;
      showBanner(err.message || "Không thể xóa cấu hình GitHub.", "error");
    }
  }

  function handleOpenFloatingWindow(isAttachedPopup) {
    const targetUrl =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL("popup.html?mode=window")
        : "popup.html?mode=window";

    const fallbackOpen = () => {
      if (typeof chrome !== "undefined" && chrome.windows && chrome.windows.create) {
        chrome.windows.create(
          {
            url: targetUrl,
            type: "popup",
            width: 920,
            height: 700,
            focused: true
          },
          () => {
            void (chrome.runtime && chrome.runtime.lastError);
            if (isAttachedPopup) {
              window.close();
            }
          }
        );
        return;
      }
      window.open(targetUrl, "GitTaskSyncFloatingWindow", "popup=yes,width=920,height=700");
      if (isAttachedPopup) {
        window.close();
      }
    };

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "OPEN_FLOATING_WINDOW" }, (resp) => {
        if ((chrome.runtime && chrome.runtime.lastError) || !resp || !resp.ok) {
          fallbackOpen();
          return;
        }
        if (isAttachedPopup) {
          window.close();
        }
      });
      return;
    }

    fallbackOpen();
  }

  function bindAllEvents() {
    const params = new URLSearchParams(window.location.search);
    const currentMode = params.get("mode");
    if (currentMode === "tab") {
      document.documentElement.classList.add("fulltab-mode");
      document.body.classList.add("fulltab-mode");
      const btnFull = document.getElementById("btnOpenFullTab");
      if (btnFull) btnFull.classList.add("hidden-control");
    } else if (currentMode === "window") {
      document.documentElement.classList.add("window-mode");
      document.body.classList.add("window-mode");
      const btnFloat = document.getElementById("btnOpenFloatingWindow");
      if (btnFloat) btnFloat.classList.add("hidden-control");
    }

    const btnFloatEl = document.getElementById("btnOpenFloatingWindow");
    if (btnFloatEl) {
      btnFloatEl.addEventListener("click", () => {
        handleOpenFloatingWindow(!currentMode);
      });
    }

    document.getElementById("btnOpenFullTab").addEventListener("click", () => {
      const targetUrl =
        typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
          ? chrome.runtime.getURL("popup.html?mode=tab")
          : "popup.html?mode=tab";
      window.open(targetUrl, "_blank", "noopener");
    });

    document.getElementById("btnToggleTheme").addEventListener("click", async () => {
      const prevTheme = state.theme;
      state.theme = state.theme === "light" ? "dark" : "light";
      applyThemeToDocument();
      try {
        await persistAllToStorage();
      } catch (err) {
        state.theme = prevTheme;
        applyThemeToDocument();
        showBanner(err.message || "Không thể lưu giao diện.", "error");
      }
    });

    document.getElementById("tabBtnTasks").addEventListener("click", () => switchTab("tasks"));
    document.getElementById("tabBtnAddTask").addEventListener("click", () => {
      switchTab("add");
      document.getElementById("taskTitleInput").focus();
    });
    const tabBtnGroups = document.getElementById("tabBtnGroups");
    if (tabBtnGroups) {
      tabBtnGroups.addEventListener("click", () => {
        state.editingGroupName = null;
        state.deletingGroupName = null;
        renderGroupCrudList();
        switchTab("groups");
      });
    }
    document
      .getElementById("tabBtnSettings")
      .addEventListener("click", () => switchTab("settings"));

    document.getElementById("btnQuickGoAdd").addEventListener("click", () => {
      resetTaskForm();
      switchTab("add");
      document.getElementById("taskTitleInput").focus();
    });

    const btnQuickGroups = document.getElementById("btnQuickManageGroups");
    if (btnQuickGroups) {
      btnQuickGroups.addEventListener("click", () => {
        state.editingGroupName = null;
        state.deletingGroupName = null;
        renderGroupCrudList();
        switchTab("groups");
        const crudInput = document.getElementById("crudNewGroupInput");
        if (crudInput) crudInput.focus();
      });
    }

    const groupCrudAddForm = document.getElementById("groupCrudAddForm");
    if (groupCrudAddForm) {
      groupCrudAddForm.addEventListener("submit", handleCrudAddGroup);
    }

    const bannerEl = document.getElementById("statusBanner");
    if (bannerEl) {
      bannerEl.addEventListener("mouseenter", () => {
        state.isBannerHovered = true;
        if (state.bannerFadeOutTimerId !== null) {
          clearTimeout(state.bannerFadeOutTimerId);
          state.bannerFadeOutTimerId = null;
          bannerEl.classList.remove("hiding");
          state.bannerRemainingMs = 1200;
        }
        if (state.bannerAutoHideTimerId !== null) {
          const rem = state.bannerHideDeadline
            ? Math.max(1000, state.bannerHideDeadline - Date.now())
            : 1200;
          clearTimeout(state.bannerAutoHideTimerId);
          state.bannerAutoHideTimerId = null;
          state.bannerRemainingMs = rem;
        }
      });

      bannerEl.addEventListener("mouseleave", () => {
        state.isBannerHovered = false;
        if (bannerEl.classList.contains("show") && state.bannerRemainingMs !== null) {
          scheduleBannerAutoHide(Math.max(1000, state.bannerRemainingMs));
        }
      });
    }

    document.getElementById("btnCloseBanner").addEventListener("click", () => hideBanner(true));
    document.getElementById("btnBannerAction").addEventListener("click", () => {
      if (typeof state.bannerActionHandler === "function") {
        state.bannerActionHandler();
      }
    });
    document.getElementById("btnDismissConflict").addEventListener("click", hideConflictAlert);

    const btnCopyLightbox = document.getElementById("btnCopyLightboxImage");
    if (btnCopyLightbox) {
      btnCopyLightbox.addEventListener("click", async () => {
        if (state.activeLightboxDataUrl) {
          const cap = document.getElementById("lightboxCaption").textContent || "attachment";
          const ok = await copySingleImageDataUrlToClipboard(state.activeLightboxDataUrl, cap);
          if (ok) {
            btnCopyLightbox.textContent = "✓ Đã copy ảnh";
            setTimeout(() => {
              btnCopyLightbox.textContent = "📋 Copy ảnh";
            }, 1800);
          }
        }
      });
    }

    const closeLightboxModal = () => {
      document.getElementById("imageLightbox").classList.remove("show");
      state.activeLightboxDataUrl = null;
    };

    document.getElementById("btnCloseLightbox").addEventListener("click", closeLightboxModal);
    document.getElementById("imageLightbox").addEventListener("click", (ev) => {
      if (ev.target.id === "imageLightbox") {
        closeLightboxModal();
      }
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeLightboxModal();
      }
    });

    const dropZone = document.getElementById("imageDropZone");
    const fileInput = document.getElementById("taskImageInput");

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (ev) => {
      handleFilesSelected(ev.target.files);
      fileInput.value = "";
    });
    dropZone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dropZone.classList.remove("dragover");
      if (ev.dataTransfer && ev.dataTransfer.files) {
        handleFilesSelected(ev.dataTransfer.files);
      }
    });

    window.addEventListener("paste", (ev) => {
      const addViewActive = document.getElementById("viewAddTask").classList.contains("active");
      if (!addViewActive || !ev.clipboardData || !ev.clipboardData.files) return;
      if (ev.clipboardData.files.length > 0) {
        handleFilesSelected(ev.clipboardData.files);
      }
    });

    document.getElementById("btnToggleDescInput").addEventListener("click", () => {
      document.getElementById("descInputContainer").classList.toggle("collapsed");
    });

    document.getElementById("btnNewGroupPrompt").addEventListener("click", () => {
      const row = document.getElementById("newGroupRow");
      row.classList.toggle("open");
      if (row.classList.contains("open")) {
        document.getElementById("newGroupInput").focus();
      }
    });

    document.getElementById("btnSaveNewGroup").addEventListener("click", () => {
      saveNewGroup();
    });

    document.getElementById("newGroupInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        saveNewGroup();
      }
    });

    document.getElementById("taskForm").addEventListener("submit", handleSaveTaskForm);
    document.getElementById("btnCancelEdit").addEventListener("click", () => {
      resetTaskForm();
      switchTab("tasks");
    });

    document.getElementById("searchTaskInput").addEventListener("input", (ev) => {
      state.searchQuery = ev.target.value;
      renderFiltersAndCounters();
      renderTaskList();
    });

    document.querySelectorAll(".status-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.statusFilter = btn.getAttribute("data-statusfilter") || "todo";
        renderAll();
      });
    });

    document.getElementById("statusFilterSelect").addEventListener("change", (ev) => {
      state.statusFilter = ev.target.value || "todo";
      renderAll();
    });

    const btnTogglePrio = document.getElementById("btnTogglePriorityGroup");
    if (btnTogglePrio) {
      btnTogglePrio.addEventListener("click", async () => {
        const prevPrioGroup = state.groupByPriority;
        state.groupByPriority = !state.groupByPriority;
        try {
          await persistAllToStorage();
          renderAll();
        } catch (err) {
          state.groupByPriority = prevPrioGroup;
          renderAll();
          showBanner(err.message || "Không thể lưu tùy chọn nhóm Priority.", "error");
        }
      });
    }

    document.getElementById("btnToggleGroupBy").addEventListener("click", async () => {
      const prevGroupBy = state.groupByCategory;
      state.groupByCategory = !state.groupByCategory;
      try {
        await persistAllToStorage();
        renderAll();
      } catch (err) {
        state.groupByCategory = prevGroupBy;
        renderAll();
        showBanner(err.message || "Không thể lưu tùy chọn gom nhóm.", "error");
      }
    });

    window.addEventListener("resize", () => {
      refreshDescriptionOverflowButtons();
    });

    document.getElementById("ghQuickPathInput").addEventListener("input", (ev) => {
      const parsed = parseQuickGitHubPath(ev.target.value);
      if (parsed) {
        document.getElementById("ghOwnerInput").value = parsed.owner;
        document.getElementById("ghRepoInput").value = parsed.repo;
        document.getElementById("ghBranchInput").value = parsed.branch;
        document.getElementById("ghFilePathInput").value = parsed.path;
      }
    });

    document
      .getElementById("githubConfigForm")
      .addEventListener("submit", handleSaveGitHubSettings);
    document
      .getElementById("btnClearGitHubConfig")
      .addEventListener("click", handleClearGitHubSettings);

    const autoPushForm = document.getElementById("autoPushAndWindowForm");
    if (autoPushForm) {
      autoPushForm.addEventListener("submit", handleSavePreferences);
    }
    const apEnabledCheckbox = document.getElementById("autoPushEnabledInput");
    if (apEnabledCheckbox) {
      apEnabledCheckbox.addEventListener("change", () => {
        handleSavePreferences();
      });
    }
    const launchModeSelect = document.getElementById("launchModeSelect");
    if (launchModeSelect) {
      launchModeSelect.addEventListener("change", () => {
        handleSavePreferences();
      });
    }

    document.getElementById("btnPullGitHub").addEventListener("click", () => {
      handlePullFromGitHub(false);
    });
    document.getElementById("btnPushGitHub").addEventListener("click", () => {
      handlePushToGitHub(false);
    });
    document.getElementById("btnForcePull").addEventListener("click", () => {
      handlePullFromGitHub(true);
    });
    document.getElementById("btnForcePush").addEventListener("click", () => {
      handlePushToGitHub(true);
    });

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName !== "local" || state.isSavingStorage) return;
        if (
          changes.tasks ||
          changes.groups ||
          changes.githubConfig ||
          changes.autoPushConfig ||
          changes.syncMeta ||
          changes.uiPrefs
        ) {
          try {
            await loadFromStorage();
            const activeEditId = document.getElementById("taskEditId").value.trim();
            if (activeEditId && !state.tasks.some((t) => t.id === activeEditId)) {
              resetTaskForm();
            }
            populateSettingsFormFromState();
            renderAll();
            scheduleOrCancelAutoPush();
          } catch (_) {
            // Bỏ qua lỗi đọc đồng bộ nền
          }
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await loadFromStorage();
      populateSettingsFormFromState();
      bindAllEvents();
      renderAll();
      scheduleOrCancelAutoPush();
    } catch (err) {
      showBanner(err.message || "Không thể khởi tạo dữ liệu ứng dụng.", "error");
    }
  });
})();

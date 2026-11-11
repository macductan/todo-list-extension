const { test, expect, chromium } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "../extension");

/**
 * Mã hóa UTF-8 sang Base64 kèm ngắt dòng 60 ký tự giống hệt chuẩn GitHub Contents API thực tế
 */
function encodeGitHubMimeBase64(text) {
  const raw = Buffer.from(text, "utf8").toString("base64");
  return raw.replace(/(.{60})/g, "$1\n") + "\n";
}

function decodeUtf8Base64(b64) {
  return Buffer.from(String(b64 || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

test.describe("GitTask Sync — Chrome Extension Manifest V3 Headless E2E Suite", () => {
  let context;
  let userDataDir;
  let extensionId;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gittask-mv3-e2e-"));

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    }
    extensionId = new URL(serviceWorker.url()).host;
    expect(extensionId).toBeTruthy();
  });

  test.afterEach(async () => {
    if (context) {
      await context.close();
    }
    if (userDataDir && fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  async function openExtensionPopupPage(secretTokenToWatch = "", options = {}) {
    const { allowExpectedHttpFailureLogs = false } = options;
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const leakedSecrets = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (secretTokenToWatch && text.includes(secretTokenToWatch)) {
        leakedSecrets.push(text);
      }
      if (msg.type() === "error") {
        if (allowExpectedHttpFailureLogs && text.startsWith("Failed to load resource:")) {
          return;
        }
        consoleErrors.push(text);
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push(err.message || String(err));
    });

    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator(".ext-name")).toHaveText("GitTask Sync");

    return {
      page,
      assertCleanConsole() {
        expect(pageErrors, "Page runtime errors must be empty").toEqual([]);
        expect(consoleErrors, "Console errors must be empty").toEqual([]);
        expect(leakedSecrets, "PAT token must never be logged to console").toEqual([]);
      }
    };
  }

  test("1. CRUD Task đầy đủ (Tạo, Đọc, Sửa, Xóa, Mô tả ẩn/hiện thực tế, Nhóm mới & Lưu trữ cục bộ)", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    // Đảm bảo kích thước Popup luôn giữ chuẩn rộng 780x600 kể cả khi Chrome khởi tạo khung đo nhỏ ban đầu
    await page.setViewportSize({ width: 320, height: 300 });
    const popupBox = await page.evaluate(() => {
      const rect = document.body.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(popupBox).toEqual({ width: 780, height: 600 });
    await page.setViewportSize({ width: 800, height: 600 });

    await expect(page.locator("#segBtnTodo")).toHaveClass(/active/);
    await expect(page.locator("#btnTogglePriorityGroup")).toContainText("Nhóm Priority: BẬT");
    await expect(page.locator("#btnToggleGroupBy")).toContainText("Nhóm Group: BẬT");
    await expect(page.locator(".empty-state-box")).toBeVisible();

    // Tạo nhóm mới bằng phím Enter trong ô nhập nhóm (không làm submit nhầm form chính)
    await page.click("#tabBtnAddTask");
    await expect(page.locator("#taskPrioritySelect")).toHaveValue("none");
    await page.click("#btnNewGroupPrompt");
    await page.fill("#newGroupInput", "Sprint Alpha");
    await page.press("#newGroupInput", "Enter");
    await expect(page.locator("#taskGroupSelect")).toHaveValue("Sprint Alpha");
    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);

    // Kiểm tra ẩn / hiện thực sự (display: none) vùng nhập mô tả trên form
    await expect(page.locator("#descInputContainer")).toBeVisible();
    await page.click("#btnToggleDescInput");
    await expect(page.locator("#descInputContainer")).toBeHidden();
    await page.click("#btnToggleDescInput");
    await expect(page.locator("#descInputContainer")).toBeVisible();

    // Tạo Task 1 (High priority, nhóm Sprint Alpha, tiếng Việt + Emoji)
    await page.fill("#taskTitleInput", "Thiết kế API đồng bộ GitHub 🚀");
    await page.fill("#taskDescInput", "Kiểm tra base_sha chống ghi đè dữ liệu từ xa.");
    await page.selectOption("#taskPrioritySelect", "high");
    await page.click("#btnSubmitTask");

    await expect(page.locator("#viewTasks")).toHaveClass(/active/);
    const firstCard = page.locator(".task-card").first();
    await expect(firstCard.locator(".task-title")).toHaveText("Thiết kế API đồng bộ GitHub 🚀");
    await expect(firstCard.locator(".badge-group")).toHaveText("Sprint Alpha");
    await expect(firstCard.locator(".badge-prio-high")).toContainText("High");

    // Mặc định mô tả ở danh sách bị ẩn; nhấn nút Mô tả mới mở ra, nhấn lần nữa ẩn lại
    const descBox = firstCard.locator(".task-desc-box");
    await expect(descBox).toBeHidden();
    await firstCard.locator(".btn-toggle-desc").click();
    await expect(descBox).toBeVisible();
    await expect(firstCard.locator(".btn-expand-desc")).toBeHidden();
    await firstCard.locator(".btn-toggle-desc").click();
    await expect(descBox).toBeHidden();

    // Tạo Task 2 & Task 3
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Đọc tài liệu Manifest V3 Security");
    await page.selectOption("#taskGroupSelect", "Cá nhân");
    await page.selectOption("#taskPrioritySelect", "low");
    await page.click("#btnSubmitTask");

    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task tạm thời để kiểm thử Xóa");
    await page.selectOption("#taskGroupSelect", "Sprint Alpha");
    await page.selectOption("#taskPrioritySelect", "medium");
    await page.click("#btnSubmitTask");

    await expect(page.locator("#navTaskCount")).toHaveText("3");

    // Kiểm tra Sửa (Update)
    const editCard = page.locator(".task-card", { hasText: "Đọc tài liệu Manifest V3 Security" });
    await editCard.locator(".btn-edit-task").click();
    await page.fill("#taskTitleInput", "Rà soát Manifest V3 CSP & Permissions");
    await page.click("#btnSubmitTask");
    await expect(
      page.locator(".task-card", { hasText: "Rà soát Manifest V3 CSP & Permissions" })
    ).toBeVisible();

    // Kiểm tra edge-case: Mở Sửa Task 3 -> quay lại Danh sách bấm Xóa Task 3 -> form Sửa tự động reset
    const tempCard = page.locator(".task-card", { hasText: "Task tạm thời để kiểm thử Xóa" });
    await tempCard.locator(".btn-edit-task").click();
    await expect(page.locator("#taskEditId")).not.toHaveValue("");
    await page.click("#tabBtnTasks");
    await tempCard.locator(".btn-delete-task").click();
    await expect(page.locator("#navTaskCount")).toHaveText("2");
    await page.click("#tabBtnAddTask");
    await expect(page.locator("#taskEditId")).toHaveValue("");
    await expect(page.locator("#formModeTitle")).toContainText("Thêm công việc mới");

    // Kiểm tra đúng 7 trường JSON bắt buộc trong chrome.storage.local và bền vững sau reload
    const storedTasks = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["tasks"], (res) => resolve(res.tasks));
      });
    });
    expect(storedTasks).toHaveLength(2);
    for (const t of storedTasks) {
      expect(Object.keys(t).sort()).toEqual([
        "description",
        "group",
        "id",
        "priority",
        "status",
        "title",
        "updatedAt"
      ]);
    }

    await page.reload();
    await expect(page.locator("#navTaskCount")).toHaveText("2");
    assertCleanConsole();
  });

  test("2. Đổi trạng thái Chưa làm <-> Đã xong, Sắp xếp Done xuống cuối, Gom nhóm, Tìm kiếm & Theme", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    const seedTasks = [
      { title: "Task Nhóm A - Ưu tiên Cao", group: "Công việc", priority: "high" },
      { title: "Task Nhóm A - Ưu tiên Thấp", group: "Công việc", priority: "low" },
      { title: "Task Nhóm B - Dự án GitHub", group: "Dự án GitHub", priority: "medium" }
    ];

    for (const item of seedTasks) {
      await page.click("#btnQuickGoAdd");
      await page.fill("#taskTitleInput", item.title);
      await page.selectOption("#taskGroupSelect", item.group);
      await page.selectOption("#taskPrioritySelect", item.priority);
      await page.click("#btnSubmitTask");
    }

    // Kiểm tra mặc định cả Nhóm Group: BẬT & Nhóm Priority: BẬT theo phân cấp Nhóm -> Priority
    await expect(page.locator(".group-section")).toHaveCount(2);
    await expect(page.locator(".priority-section")).toHaveCount(3);
    await expect(
      page.locator('.group-section[data-group-name="Công việc"] .priority-section')
    ).toHaveCount(2);

    // Tắt Nhóm Priority để kiểm tra gom thuần theo Group
    await page.click("#btnTogglePriorityGroup");
    await expect(page.locator(".priority-section")).toHaveCount(0);
    await expect(page.locator(".group-section")).toHaveCount(2);
    await expect(
      page.locator('.group-section[data-group-name="Công việc"] .task-card')
    ).toHaveCount(2);

    // Kiểm tra tìm kiếm từ khóa
    await page.fill("#searchTaskInput", "Dự án GitHub");
    await expect(page.locator(".task-card")).toHaveCount(1);
    await page.fill("#searchTaskInput", "");
    await expect(page.locator(".task-card")).toHaveCount(3);

    // Kiểm tra lọc theo nhóm rồi quay lại Tất cả nhóm
    await page.locator('#groupFilterBar .filter-pill[data-group="Công việc"]').click();
    await expect(page.locator(".task-card")).toHaveCount(2);
    await page.locator('#groupFilterBar .filter-pill[data-group="ALL"]').click();

    // Chuyển sang xem "Tất cả" để kiểm chứng Done tự động chuyển xuống cuối nhóm
    await page.click("#segBtnAll");
    const highTaskCard = page.locator(".task-card", { hasText: "Task Nhóm A - Ưu tiên Cao" });
    await highTaskCard.locator(".task-checkbox").check();

    await expect(page.locator("#countTodoBadge")).toHaveText("2");
    await expect(page.locator("#countDoneBadge")).toHaveText("1");
    const groupACards = page.locator('.group-section[data-group-name="Công việc"] .task-card');
    await expect(groupACards.first().locator(".task-title")).toHaveText("Task Nhóm A - Ưu tiên Thấp");
    await expect(groupACards.last()).toHaveClass(/done/);

    // Tắt cả Nhóm Group -> danh sách phẳng hoàn toàn, Done xếp cuối
    await page.click("#btnToggleGroupBy");
    await expect(page.locator(".group-section")).toHaveCount(0);
    await expect(page.locator(".task-card").last()).toHaveClass(/done/);

    // Bật lại cả Nhóm Priority & Nhóm Group, đổi ngược từ Đã xong -> Chưa làm
    await page.click("#btnTogglePriorityGroup");
    await page.click("#btnToggleGroupBy");
    await page.click("#segBtnDone");
    await expect(page.locator(".task-card")).toHaveCount(1);
    await page.locator(".task-card .task-checkbox").click();
    await expect(page.locator("#countDoneBadge")).toHaveText("0");
    await expect(page.locator("#countTodoBadge")).toHaveText("3");

    // Kiểm tra đổi giao diện Sáng / Tối bền vững sau reload
    await page.click("#btnToggleTheme");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    assertCleanConsole();
  });

  test("3. Đồng bộ GitHub (Branch có dấu /, Pull, Push, Bảo vệ Dirty Local, Conflict 409 & Link GitHub)", async () => {
    const testSecretPat = "pat_secret_never_log_987654321";
    const { page, assertCleanConsole } = await openExtensionPopupPage(testSecretPat, {
      allowExpectedHttpFailureLogs: true
    });

    const mockRemote = {
      exists: true,
      sha: "1111111aaaaaaaabbbbbbbbccccccccdddddddd",
      tasks: [
        {
          id: "gh-task-1",
          title: "Task Tiếng Việt từ GitHub 🚀",
          description: "Nội dung mã hóa Base64 nhiều dòng",
          group: "Dự án GitHub",
          priority: "high",
          status: "todo",
          updatedAt: "2026-11-04T08:00:00.000Z"
        }
      ],
      forceNextPut409: false
    };

    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const authHeader = req.headers()["authorization"] || "";

      if (authHeader !== `Bearer ${testSecretPat}`) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ message: "Bad credentials" })
        });
        return;
      }

      if (
        url.pathname === "/repos/octo-org/team-tasks/contents/data/tasks.json" &&
        req.method() === "GET"
      ) {
        expect(url.searchParams.get("ref")).toBe("feature/sync-v2");
        const jsonStr = JSON.stringify(mockRemote.tasks, null, 2);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            name: "tasks.json",
            path: "data/tasks.json",
            size: Buffer.byteLength(jsonStr, "utf8"),
            sha: mockRemote.sha,
            encoding: "base64",
            content: encodeGitHubMimeBase64(jsonStr)
          })
        });
        return;
      }

      if (
        url.pathname === "/repos/octo-org/team-tasks/contents/data/tasks.json" &&
        req.method() === "PUT"
      ) {
        const body = JSON.parse(req.postData() || "{}");
        expect(body.branch).toBe("feature/sync-v2");

        if (mockRemote.forceNextPut409 || (mockRemote.exists && body.sha !== mockRemote.sha)) {
          mockRemote.forceNextPut409 = false;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ message: "Conflict sha mismatch" })
          });
          return;
        }

        mockRemote.tasks = JSON.parse(decodeUtf8Base64(body.content));
        mockRemote.sha = "2222222eeeeeeeeffffffff0000000011111111";

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            content: { sha: mockRemote.sha }
          })
        });
        return;
      }

      await route.fulfill({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
    });

    // Dán Quick Path rồi chỉnh tay Branch thành "feature/sync-v2" -> Lưu không bị ghi đè ngược
    await page.click("#tabBtnSettings");
    await expect(page.locator("#ghTokenInput")).toHaveAttribute("type", "password");
    await page.fill(
      "#ghQuickPathInput",
      "https://github.com/octo-org/team-tasks/blob/main/data/tasks.json"
    );
    await page.fill("#ghBranchInput", "feature/sync-v2");
    await page.fill("#ghFilePathInput", "data/tasks.json");
    await page.fill("#ghTokenInput", testSecretPat);
    await page.click("#btnSaveGitHubConfig");
    await expect(page.locator("#ghBranchInput")).toHaveValue("feature/sync-v2");

    // Pull thành công & lưu base_sha
    await page.click("#tabBtnTasks");
    await page.click("#btnPullGitHub");
    await expect(page.locator(".task-title").first()).toHaveText("Task Tiếng Việt từ GitHub 🚀");
    await expect(page.locator("#headerShaBadge")).toContainText("base_sha: 1111111");

    // Thêm task mới ở Local (dirty = true) -> bấm nhầm Pull thường phải chặn lại bảo vệ dữ liệu Local
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task mới tại Local chưa Push");
    await page.click("#btnSubmitTask");

    await page.click("#btnPullGitHub");
    const conflictBox = page.locator("#conflictAlertBox");
    await expect(conflictBox).toHaveClass(/show/);
    await expect(page.locator(".task-card")).toHaveCount(2);
    await page.click("#btnDismissConflict");

    // Push hợp lệ lên GitHub -> cập nhật base_sha mới và xóa cờ dirty
    await page.click("#btnPushGitHub");
    await expect(page.locator("#headerShaBadge")).toHaveText("base_sha: 2222222");
    expect(mockRemote.tasks).toHaveLength(2);

    // Giả lập thiết bị khác sửa dữ liệu trên GitHub -> Push phát hiện Conflict & hiển thị đúng URL có branch chứa dấu /
    mockRemote.sha = "9999999conflictsha888888877777776666666";
    mockRemote.tasks.unshift({
      id: "gh-remote-hotfix",
      title: "Task mới từ thiết bị khác",
      description: "Gây xung đột phiên bản",
      group: "Khẩn cấp",
      priority: "high",
      status: "todo",
      updatedAt: "2026-11-04T09:30:00.000Z"
    });

    await page.click("#btnPushGitHub");
    await expect(conflictBox).toHaveClass(/show/);
    await expect(page.locator("#conflictFileLink")).toHaveAttribute(
      "href",
      "https://github.com/octo-org/team-tasks/blob/feature/sync-v2/data/tasks.json"
    );
    await expect(page.locator("#conflictCommitsLink")).toHaveAttribute(
      "href",
      "https://github.com/octo-org/team-tasks/commits/feature/sync-v2/data/tasks.json"
    );
    expect(mockRemote.tasks).toHaveLength(3);

    // Giải quyết bằng Force Pull
    await page.click("#btnForcePull");
    await expect(conflictBox).not.toHaveClass(/show/);
    await expect(page.locator("#headerShaBadge")).toHaveText("base_sha: 9999999");

    // Kiểm tra race-condition PUT trả 409 trực tiếp & giải quyết bằng Force Push
    mockRemote.forceNextPut409 = true;
    await page.click("#btnPushGitHub");
    await expect(conflictBox).toHaveClass(/show/);
    await page.click("#btnForcePush");
    await expect(conflictBox).not.toHaveClass(/show/);
    await expect(page.locator("#headerShaBadge")).toHaveText("base_sha: 2222222");

    assertCleanConsole();
  });

  test("4. Bảo mật Chống XSS, Chặn Path Traversal (..), Lọc SVG & Redact Token trong thông báo lỗi", async () => {
    const secretPat = "pat_guard_redaction_test_55555";
    const { page, assertCleanConsole } = await openExtensionPopupPage(secretPat, {
      allowExpectedHttpFailureLogs: true
    });

    await page.evaluate(() => {
      window.__xssExecuted = false;
    });

    // Kiểm tra chặn dot-segment ".." trên owner/repo và PAT chứa ký tự Unicode không hợp lệ
    await page.click("#tabBtnSettings");
    await page.fill("#ghOwnerInput", "..");
    await page.fill("#ghRepoInput", "settings");
    await page.fill("#ghBranchInput", "main");
    await page.fill("#ghFilePathInput", "tasks.json");
    await page.fill("#ghTokenInput", secretPat);
    await page.click("#btnSaveGitHubConfig");
    await expect(page.locator("#statusBanner")).toContainText("không hợp lệ");

    await page.fill("#ghOwnerInput", "sec-team");
    await page.fill("#ghRepoInput", "xss-vault");
    await page.fill("#ghTokenInput", "token_co_khoang_trang\u200B");
    await page.click("#btnSaveGitHubConfig");
    await expect(page.locator("#statusBanner")).toContainText("Personal Access Token");

    // Lưu cấu hình hợp lệ
    await page.fill("#ghTokenInput", secretPat);
    await page.click("#btnSaveGitHubConfig");
    await expect(page.locator("#statusBanner")).toContainText("Đã lưu cấu hình");

    const xssTitle = '<img src="x" onerror="window.__xssExecuted=true"><script>window.__xssExecuted=true</script>';
    const xssDesc = '<svg onload="window.__xssExecuted=true">Mô tả an toàn</svg>';

    let return422WithReflectedToken = false;
    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      if (req.method() === "PUT" && return422WithReflectedToken) {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            message: `Invalid request using credential ${secretPat} on protected branch`
          })
        });
        return;
      }

      const payloadTasks = [
        {
          id: "dup-id",
          title: xssTitle,
          description: xssDesc,
          group: "<b>Nhóm XSS</b>",
          priority: "HIGH",
          status: "todo",
          images: [
            { id: "js-img", name: "x.png", dataUrl: "javascript:window.__xssExecuted=true" },
            { id: "svg-img", name: "x.svg", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }
          ],
          updatedAt: "2026-11-04T10:00:00.000Z"
        },
        {
          id: "dup-id",
          title: "Task trùng ID được tự động khử trùng",
          description: "",
          group: "Công việc",
          priority: "low",
          status: "todo",
          updatedAt: "2026-11-04T10:05:00.000Z"
        }
      ];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          size: 512,
          encoding: "base64",
          content: encodeGitHubMimeBase64(JSON.stringify(payloadTasks))
        })
      });
    });

    await page.click("#tabBtnTasks");
    await page.click("#btnPullGitHub");
    await expect(page.locator(".task-card")).toHaveCount(2);
    await expect(page.locator(".task-title").last()).toHaveText(xssTitle);
    await expect(page.locator(".group-section").last().locator(".group-header")).toContainText("<b>Nhóm XSS</b>");
    await expect(page.locator(".task-img-thumb")).toHaveCount(0);

    // Xóa 1 trong 2 task từng bị trùng ID -> chỉ xóa đúng 1 task nhờ deduplicate ID
    await page.locator(".task-card", { hasText: "Task trùng ID" }).locator(".btn-delete-task").click();
    await expect(page.locator(".task-card")).toHaveCount(1);

    const xssRan = await page.evaluate(() => window.__xssExecuted);
    expect(xssRan).toBe(false);

    // Kiểm tra lỗi 422 không phải conflict SHA: không hiện hộp Conflict & tự che [REDACTED] nếu lỗi phản chiếu PAT
    return422WithReflectedToken = true;
    await page.click("#btnPushGitHub");
    await expect(page.locator("#conflictAlertBox")).not.toHaveClass(/show/);
    await expect(page.locator("#statusBanner")).toContainText("422");
    await expect(page.locator("#statusBanner")).toContainText("[REDACTED]");
    await expect(page.locator("#statusBanner")).not.toContainText(secretPat);

    assertCleanConsole();
  });

  test("5. Edge Cases toàn diện: Khởi tạo file 404 mới, Đồng bộ mảng rỗng [], File >1MB qua Blobs API, Mất mạng ở PUT & 403 Rate Limit", async () => {
    const pat = "pat_edge_cases_999999";
    const { page, assertCleanConsole } = await openExtensionPopupPage(pat, {
      allowExpectedHttpFailureLogs: true
    });

    let mode = "not_found_404";
    let storedRemoteTasks = [];
    let storedRemoteSha = "";

    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());

      if (mode === "rate_limit_403") {
        await route.fulfill({
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
          contentType: "application/json",
          body: JSON.stringify({ message: "API rate limit exceeded" })
        });
        return;
      }

      if (url.pathname.includes("/git/blobs/")) {
        const blobJson = JSON.stringify([
          {
            id: "large-blob-1",
            title: "Task tải thành công qua Git Blobs API (>1MB)",
            description: "Không bị mất trắng dữ liệu khi content rỗng",
            group: "Dự án GitHub",
            priority: "high",
            status: "todo",
            updatedAt: "2026-11-04T11:00:00.000Z"
          }
        ]);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha: storedRemoteSha,
            encoding: "base64",
            content: encodeGitHubMimeBase64(blobJson)
          })
        });
        return;
      }

      if (req.method() === "GET") {
        if (mode === "not_found_404") {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ message: "Not Found" })
          });
          return;
        }
        if (mode === "large_file_empty_content") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sha: storedRemoteSha,
              size: 1500000,
              encoding: "none",
              content: ""
            })
          });
          return;
        }
        const jsonStr = JSON.stringify(storedRemoteTasks);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha: storedRemoteSha,
            size: Buffer.byteLength(jsonStr, "utf8"),
            encoding: "base64",
            content: encodeGitHubMimeBase64(jsonStr)
          })
        });
        return;
      }

      if (req.method() === "PUT") {
        if (mode === "offline_on_put") {
          await route.abort("failed");
          return;
        }
        const body = JSON.parse(req.postData() || "{}");
        storedRemoteTasks = JSON.parse(decodeUtf8Base64(body.content));
        storedRemoteSha = "3333333createdsha4444444555555566666666";
        mode = "normal";
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ content: { sha: storedRemoteSha } })
        });
      }
    });

    await page.click("#tabBtnSettings");
    await page.fill("#ghQuickPathInput", "https://raw.githubusercontent.com/edge-org/vault/refs/heads/main/tasks.json");
    await expect(page.locator("#ghBranchInput")).toHaveValue("main");
    await expect(page.locator("#ghFilePathInput")).toHaveValue("tasks.json");
    await page.fill("#ghTokenInput", pat);
    await page.click("#btnSaveGitHubConfig");

    // 5.1: Pull khi file chưa tồn tại (404) -> báo thông tin, sau đó Push mảng rỗng [] tạo file mới (201)
    await page.click("#tabBtnTasks");
    await page.click("#btnPullGitHub");
    await expect(page.locator("#statusBanner")).toContainText("404");

    await page.click("#btnPushGitHub");
    await expect(page.locator("#headerShaBadge")).toHaveText("base_sha: 3333333");
    expect(storedRemoteTasks).toEqual([]);

    // 5.2: Mất mạng đúng vào bước PUT (sau khi GET thành công)
    mode = "offline_on_put";
    await page.click("#btnPushGitHub");
    await expect(page.locator("#statusBanner")).toContainText("kết nối mạng");

    // 5.3: File > 1MB (GET contents trả size > 0 & content rỗng -> tự động tải qua Git Blobs API)
    storedRemoteSha = "7777777largeblobsha888888899999990000000";
    mode = "large_file_empty_content";
    await page.click("#btnPullGitHub");
    await expect(page.locator(".task-title").first()).toHaveText(
      "Task tải thành công qua Git Blobs API (>1MB)"
    );

    // 5.4: File bị xóa từ xa (404 khi đã có base_sha) -> Push hiện Conflict -> Force Pull dọn sạch trạng thái kẹt
    mode = "not_found_404";
    await page.click("#btnPushGitHub");
    await expect(page.locator("#conflictAlertBox")).toHaveClass(/show/);
    await page.click("#btnForcePull");
    await expect(page.locator("#conflictAlertBox")).not.toHaveClass(/show/);
    await expect(page.locator("#navTaskCount")).toHaveText("0");

    // 5.5: Rate limit 403 (x-ratelimit-remaining: 0)
    mode = "rate_limit_403";
    await page.click("#btnPullGitHub");
    await expect(page.locator("#statusBanner")).toContainText("Rate Limit");

    assertCleanConsole();
  });

  test("6. Kiểm thử chuyên sâu 5 yêu cầu mới: Mặc định Không ưu tiên & 4 màu cờ, Ẩn mô tả mặc định, Rút gọn mô tả dài, Chia nhóm & Ẩn/Hiện Priority/Group", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.setViewportSize({ width: 800, height: 600 });

    const longMultilineDesc = [
      "Dòng 1: Kiểm tra luồng xác thực Fine-grained PAT với GitHub REST Contents API.",
      "Dòng 2: Đảm bảo lưu base_sha vào chrome.storage.local sau mỗi lần Pull hoặc Push.",
      "Dòng 3: Phần nội dung dài từ dòng thứ 3 trở đi bắt buộc phải được rút gọn tự động.",
      "Dòng 4: Người dùng nhấn Xem thêm mới mở rộng toàn bộ và nhấn Thu gọn để đóng bớt lại.",
      "Dòng 5: Mặc định khi mới tạo hoặc tải danh sách thì vùng mô tả luôn ở trạng thái ẩn."
    ].join("\n");

    // 1) Tạo task KHÔNG chọn cờ ưu tiên -> mặc định phải là "none" (Không ưu tiên) + mô tả dài mặc định ẩn
    await page.click("#btnQuickGoAdd");
    await expect(page.locator("#taskPrioritySelect")).toHaveValue("none");
    await page.fill("#taskTitleInput", "Task Mặc Định Không Ưu Tiên");
    await page.fill("#taskDescInput", longMultilineDesc);
    await page.click("#btnSubmitTask");

    const defaultCard = page.locator(".task-card", { hasText: "Task Mặc Định Không Ưu Tiên" });
    await expect(defaultCard).toHaveAttribute("data-priority", "none");
    await expect(defaultCard.locator(".badge-prio-none")).toContainText("Không ưu tiên");

    // Yêu cầu 5: Mặc định là ẩn mô tả ở danh sách list
    const descBox = defaultCard.locator(".task-desc-box");
    await expect(descBox).toBeHidden();

    // Yêu cầu 1: Mở mô tả dài -> bị rút gọn 2 dòng (scrollHeight > clientHeight) kèm nút "Xem thêm ▾"
    await defaultCard.locator(".btn-toggle-desc").click();
    await expect(descBox).toBeVisible();
    const expandBtn = defaultCard.locator(".btn-expand-desc");
    await expect(expandBtn).toBeVisible();
    await expect(expandBtn).toHaveText("Xem thêm ▾");

    const clampedMetrics = await defaultCard.locator(".task-desc-text").evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight
    }));
    expect(clampedMetrics.scrollHeight).toBeGreaterThan(clampedMetrics.clientHeight + 5);

    // Nhấn "Xem thêm ▾" -> hiển thị đầy đủ nội dung & đổi thành "Thu gọn ▴"
    await expandBtn.click();
    await expect(expandBtn).toHaveText("Thu gọn ▴");
    const expandedMetrics = await defaultCard.locator(".task-desc-text").evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight
    }));
    expect(expandedMetrics.clientHeight).toBeGreaterThan(clampedMetrics.clientHeight);
    expect(expandedMetrics.scrollHeight).toBeLessThanOrEqual(expandedMetrics.clientHeight + 2);

    // Nhấn "Thu gọn ▴" -> rút gọn lại 2 dòng; nhấn "Ẩn mô tả" -> ẩn hẳn vùng mô tả
    await expandBtn.click();
    await expect(expandBtn).toHaveText("Xem thêm ▾");
    await defaultCard.locator(".btn-toggle-desc").click();
    await expect(descBox).toBeHidden();

    // 2) Tạo thêm các task đủ 4 mức cờ ưu tiên bên trong cùng nhóm "Công việc" + 1 task ở nhóm "Dự án GitHub"
    const extraTasks = [
      { title: "Task Cờ Thấp", group: "Công việc", priority: "low" },
      { title: "Task Cờ Trung Bình", group: "Công việc", priority: "medium" },
      { title: "Task Cờ Cao", group: "Công việc", priority: "high" },
      { title: "Task Dự Án GitHub - Cao", group: "Dự án GitHub", priority: "high" }
    ];
    for (const item of extraTasks) {
      await page.click("#btnQuickGoAdd");
      await page.fill("#taskTitleInput", item.title);
      await page.selectOption("#taskGroupSelect", item.group);
      await page.selectOption("#taskPrioritySelect", item.priority);
      await page.click("#btnSubmitTask");
    }

    const badgeColors = await page.evaluate(() => {
      const selectors = [
        ".badge-prio-high",
        ".badge-prio-medium",
        ".badge-prio-low",
        ".badge-prio-none"
      ];
      return selectors.map((sel) => {
        const el = document.querySelector(sel);
        const flag = el ? el.querySelector("svg.prio-flag-icon") : null;
        const style = el ? window.getComputedStyle(el) : null;
        const flagStyle = flag ? window.getComputedStyle(flag) : null;
        return {
          hasSvgFlag: Boolean(flag),
          textColor: style ? style.color : "",
          flagColor: flagStyle ? flagStyle.color : ""
        };
      });
    });

    expect(badgeColors.every((b) => b.hasSvgFlag)).toBe(true);
    expect(new Set(badgeColors.map((b) => b.textColor)).size).toBe(4);
    expect(new Set(badgeColors.map((b) => b.flagColor)).size).toBe(4);

    // 3) Yêu cầu 3 & Yêu cầu 6: Phân cấp bắt buộc phải là Nhóm (Group) ngoài -> Priority bên trong (High -> Medium -> Low -> None)
    await expect(page.locator("#taskListContainer > .group-section")).toHaveCount(2);
    await expect(page.locator(".priority-section .group-section")).toHaveCount(0);
    await expect(page.locator(".group-section > .group-section-body > .priority-section")).toHaveCount(5);

    const renderedGroupOrder = await page
      .locator("#taskListContainer > .group-section")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-group-name")));
    expect(renderedGroupOrder).toEqual(["Công việc", "Dự án GitHub"]);

    const workGroupSection = page.locator('.group-section[data-group-name="Công việc"]');
    const renderedPrioInsideWorkGroup = await workGroupSection
      .locator(".priority-section")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-priority-group")));
    expect(renderedPrioInsideWorkGroup).toEqual(["high", "medium", "low", "none"]);

    // 4) Yêu cầu 4: Cho phép ẩn / hiển thị từng nhóm Group bên ngoài và từng nhóm Priority bên trong
    await expect(workGroupSection.locator(".group-section-body")).toBeVisible();
    await workGroupSection.locator(".group-header").click();
    await expect(workGroupSection.locator(".group-section-body")).toBeHidden();
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await workGroupSection.locator(".group-header").click();
    await expect(workGroupSection.locator(".group-section-body")).toBeVisible();
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "true");

    const highSectionInWork = workGroupSection.locator('.priority-section[data-priority-group="high"]');
    await expect(highSectionInWork.locator(".priority-section-body")).toBeVisible();
    await highSectionInWork.locator(".priority-header").click();
    await expect(highSectionInWork.locator(".priority-section-body")).toBeHidden();
    await expect(highSectionInWork.locator(".priority-header")).toHaveAttribute("aria-expanded", "false");
    // Nhóm Priority "high" ở nhóm "Dự án GitHub" không bị ảnh hưởng khi đóng "high" ở nhóm "Công việc"
    await expect(
      page
        .locator('.group-section[data-group-name="Dự án GitHub"] .priority-section[data-priority-group="high"] .priority-section-body')
    ).toBeVisible();
    await highSectionInWork.locator(".priority-header").click();
    await expect(highSectionInWork.locator(".priority-section-body")).toBeVisible();

    // Lọc nhanh theo cờ trên thanh Priority Filter Bar
    await page.locator('#priorityFilterBar .filter-pill[data-priority="none"]').click();
    await expect(page.locator(".task-card")).toHaveCount(1);
    await expect(page.locator(".task-card .task-title")).toHaveText("Task Mặc Định Không Ưu Tiên");
    await page.locator('#priorityFilterBar .filter-pill[data-priority="ALL"]').click();
    await expect(page.locator(".task-card")).toHaveCount(5);

    // Bật / tắt nút Nhóm Group và Nhóm Priority trên thanh công cụ & kiểm tra lưu bền vững sau reload
    await page.click("#btnToggleGroupBy");
    await expect(page.locator("#btnToggleGroupBy")).toContainText("Nhóm Group: TẮT");
    await expect(page.locator(".group-section")).toHaveCount(0);
    await expect(page.locator(".priority-section")).toHaveCount(4);

    await page.click("#btnTogglePriorityGroup");
    await expect(page.locator("#btnTogglePriorityGroup")).toContainText("Nhóm Priority: TẮT");
    await expect(page.locator(".priority-section")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#btnTogglePriorityGroup")).toContainText("Nhóm Priority: TẮT");
    await expect(page.locator("#btnToggleGroupBy")).toContainText("Nhóm Group: TẮT");

    assertCleanConsole();
  });

  test("7. Quản lý CRUD Nhóm (Req 7), Cửa sổ nổi Popup Window (Req 8) & Auto Push 2 bộ đếm + Trạng thái Cây sạch/Chưa sạch (Req 9)", async () => {
    const autoPushPat = "pat_autopush_window_groups_777777";
    const { page, assertCleanConsole } = await openExtensionPopupPage(autoPushPat, {
      allowExpectedHttpFailureLogs: true
    });
    await page.goto(`chrome-extension://${extensionId}/popup.html?mode=tab`);
    await expect(page.locator("body")).toHaveClass(/fulltab-mode/);

    // Bảo toàn nghiêm ngặt quyền tối thiểu trong manifest.json (không thêm quyền thừa cho cửa sổ nổi)
    const manifestJson = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, "manifest.json"), "utf8")
    );
    expect(manifestJson.permissions).toEqual(["storage"]);
    expect(manifestJson.host_permissions).toEqual(["https://api.github.com/*"]);
    expect(manifestJson.action.default_popup).toBe("popup.html");

    // ==================== A. KIỂM THỬ TRẠNG THÁI BAN ĐẦU CÂY SẠCH & MẶC ĐỊNH AUTO PUSH + POPUP DEFAULT ====================
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch");
    await expect(page.locator("#treeStatusBadge")).toHaveClass(/clean/);

    await page.click("#tabBtnSettings");
    await expect(page.locator("#autoPushEnabledInput")).toBeChecked();
    await expect(page.locator("#autoPushDebounceValue")).toHaveValue("10");
    await expect(page.locator("#autoPushDebounceUnit")).toHaveValue("s");
    await expect(page.locator("#autoPushMaxWaitValue")).toHaveValue("5");
    await expect(page.locator("#autoPushMaxWaitUnit")).toHaveValue("m");
    await expect(page.locator("#launchModeSelect")).toHaveValue("popup");

    // ==================== B. KIỂM THỬ QUẢN LÝ CRUD NHÓM (REQ 7) ====================
    await page.click("#tabBtnTasks");
    await page.click("#btnQuickManageGroups");
    await expect(page.locator("#viewGroups")).toHaveClass(/active/);
    await expect(page.locator("#navGroupCount")).toHaveText("4");

    // 1. Create Group + chống trùng tên
    await page.fill("#crudNewGroupInput", "Backend API");
    await page.click("#btnCrudAddGroup");
    await expect(page.locator("#navGroupCount")).toHaveText("5");
    await expect(page.locator('.group-crud-item[data-group-item="Backend API"]')).toBeVisible();

    await page.fill("#crudNewGroupInput", "backend api");
    await page.click("#btnCrudAddGroup");
    await expect(page.locator("#statusBanner")).toContainText("đã tồn tại");
    await expect(page.locator("#navGroupCount")).toHaveText("5");

    // Tạo 1 task thuộc nhóm "Backend API" -> kiểm tra cây dữ liệu lập tức chuyển sang "Chưa sạch"
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Xây dựng endpoint đồng bộ SHA");
    await page.selectOption("#taskGroupSelect", "Backend API");
    await page.selectOption("#taskPrioritySelect", "high");
    await page.click("#btnSubmitTask");

    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");
    await expect(page.locator("#treeStatusBadge")).toHaveClass(/dirty/);
    await expect(page.locator("#btnPushGitHub")).toHaveClass(/needs-commit/);

    // 2. Update (Đổi tên nhóm) -> tự động cập nhật dây chuyền sang toàn bộ công việc thuộc nhóm đó
    await page.click("#tabBtnGroups");
    const backendItem = page.locator('.group-crud-item[data-group-item="Backend API"]');
    await backendItem.locator(".btn-rename-group").click();
    await backendItem.locator(".group-rename-input").fill("Core Backend");
    await backendItem.locator(".btn-save-rename-group").click();

    await expect(page.locator('.group-crud-item[data-group-item="Core Backend"]')).toBeVisible();
    await page.click("#tabBtnTasks");
    await expect(
      page.locator(".task-card", { hasText: "Xây dựng endpoint đồng bộ SHA" }).locator(".badge-group")
    ).toHaveText("Core Backend");

    // 3. Reorder (Đưa nhóm "Core Backend" lên đầu danh sách bằng nút ↑)
    await page.click("#tabBtnGroups");
    for (let i = 0; i < 4; i++) {
      await page
        .locator('.group-crud-item[data-group-item="Core Backend"] .btn-move-group-up')
        .click();
    }
    const firstCrudGroup = await page
      .locator(".group-crud-item")
      .first()
      .getAttribute("data-group-item");
    expect(firstCrudGroup).toBe("Core Backend");

    // 4. Delete nhóm trống ("Khẩn cấp") xóa ngay lập tức + Delete nhóm đang chứa việc ("Core Backend") có chuyển việc an toàn
    await page.locator('.group-crud-item[data-group-item="Khẩn cấp"] .btn-delete-group').click();
    await expect(page.locator("#navGroupCount")).toHaveText("4");

    const coreItem = page.locator('.group-crud-item[data-group-item="Core Backend"]');
    await coreItem.locator(".btn-delete-group").click();
    await expect(coreItem.locator(".group-delete-confirm-row")).toBeVisible();
    await coreItem.locator(".group-reassign-select").selectOption("Dự án GitHub");
    await coreItem.locator(".btn-confirm-reassign-group").click();

    await expect(page.locator("#navGroupCount")).toHaveText("3");
    await page.click("#tabBtnTasks");
    await expect(
      page.locator(".task-card", { hasText: "Xây dựng endpoint đồng bộ SHA" }).locator(".badge-group")
    ).toHaveText("Dự án GitHub");

    // ==================== C. KIỂM THỬ CỬA SỔ NỔI FLOATING POPUP WINDOW (REQ 8) ====================
    const floatingPagePromise = context.waitForEvent("page");
    await page.click("#btnOpenFloatingWindow");
    const floatingPage = await floatingPagePromise;
    await floatingPage.waitForLoadState("domcontentloaded");

    expect(floatingPage.url()).toBe(`chrome-extension://${extensionId}/popup.html?mode=window`);
    await expect(floatingPage.locator("body")).toHaveClass(/window-mode/);
    await expect(floatingPage.locator("#btnOpenFloatingWindow")).toBeHidden();

    // Cửa sổ nổi co giãn tự do theo kích thước cửa sổ thực (không bị bó cứng ở 780x600 như attached popup)
    await floatingPage.setViewportSize({ width: 960, height: 720 });
    const winRect = await floatingPage.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    });
    expect(winRect).toEqual({ width: 960, height: 720 });
    await floatingPage.close();

    // ==================== D. KIỂM THỬ AUTO PUSH (DEBOUNCE + FIRST-CHANGE MAXWAIT) & CÂY SẠCH/CHƯA SẠCH (REQ 9) ====================
    let putCount = 0;
    let remoteSha = "";
    let remoteTasks = [];

    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        if (!remoteSha) {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ message: "Not Found" })
          });
          return;
        }
        const jsonStr = JSON.stringify(remoteTasks);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha: remoteSha,
            size: Buffer.byteLength(jsonStr, "utf8"),
            encoding: "base64",
            content: encodeGitHubMimeBase64(jsonStr)
          })
        });
        return;
      }

      if (req.method() === "PUT") {
        putCount += 1;
        const body = JSON.parse(req.postData() || "{}");
        remoteTasks = JSON.parse(decodeUtf8Base64(body.content));
        remoteSha = `autopushsha000${putCount}aaaaaaaabbbbbbbbcccccccc`;
        await route.fulfill({
          status: putCount === 1 ? 201 : 200,
          contentType: "application/json",
          body: JSON.stringify({ content: { sha: remoteSha } })
        });
      }
    });

    // Cấu hình GitHub & thiết lập Auto Push ngắn (Debounce = 2s, MaxWait từ thay đổi đầu tiên = 3s) để kiểm chứng chính xác
    await page.click("#tabBtnSettings");
    await page.fill("#ghOwnerInput", "auto-org");
    await page.fill("#ghRepoInput", "auto-sync-tasks");
    await page.fill("#ghBranchInput", "main");
    await page.fill("#ghFilePathInput", "tasks.json");
    await page.fill("#ghTokenInput", autoPushPat);
    await page.click("#btnSaveGitHubConfig");

    await page.fill("#autoPushDebounceValue", "2");
    await page.selectOption("#autoPushDebounceUnit", "s");
    await page.fill("#autoPushMaxWaitValue", "3");
    await page.selectOption("#autoPushMaxWaitUnit", "s");
    await page.click("#btnSavePreferences");

    // 1) Trường hợp Debounce sau thay đổi cuối cùng: Cây đang dirty -> hiện đếm ngược Auto Push -> tự Push sau ~2s -> Cây sạch (Đã commit)
    await expect(page.locator("#treeStatusBadge")).toContainText("Auto Push sau");
    await expect.poll(() => putCount, { timeout: 5000 }).toBe(1);
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch (Đã commit)");
    await expect(page.locator("#treeStatusBadge")).toHaveClass(/clean/);
    await expect(page.locator("#btnPushGitHub")).not.toHaveClass(/needs-commit/);
    expect(remoteTasks).toHaveLength(1);

    // 2) Trường hợp MaxWait tính từ thay đổi đầu tiên:
    // Đặt Debounce = 4s nhưng MaxWait = 2s (hoặc sửa liên tục mỗi 700ms làm Debounce liên tục bị đẩy lùi)
    // để chứng minh dù thay đổi liên tục không nghỉ, đúng hạn từ thay đổi đầu tiên hệ thống vẫn tự động commit & Push!
    await page.click("#tabBtnSettings");
    await page.fill("#autoPushDebounceValue", "3");
    await page.selectOption("#autoPushDebounceUnit", "s");
    await page.fill("#autoPushMaxWaitValue", "2");
    await page.selectOption("#autoPushMaxWaitUnit", "s");
    await page.click("#btnSavePreferences");

    await page.click("#tabBtnTasks");
    await page.click("#segBtnAll");

    const checkbox = page.locator(".task-card .task-checkbox").first();
    const firstChangeStartedAt = Date.now();
    await checkbox.click(); // t ~ 0ms (thay đổi đầu tiên: dirty = true)
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Tiếp tục thao tác liên tục mỗi 650ms (nếu chỉ có Debounce 3s thì sẽ không bao giờ Push ở mốc ~2s)
    await page.waitForTimeout(650);
    await checkbox.click();
    await page.waitForTimeout(650);
    await checkbox.click();

    await expect.poll(() => putCount, { timeout: 3500 }).toBe(2);
    const elapsedMs = Date.now() - firstChangeStartedAt;
    // Phải hoàn tất trước mốc Debounce 3s tính từ thay đổi cuối (1300ms + 3000ms = 4300ms) nhờ trần MaxWait 2s!
    expect(elapsedMs).toBeLessThan(3600);
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch (Đã commit)");

    assertCleanConsole();
  });

  test("8. Bộ đếm Cờ/Nhóm theo bộ lọc trạng thái (tích xong giảm số lượng cờ) & Chọn nhiều cờ cùng lúc (Multi-select Priority)", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    const seed = [
      { title: "High Task 1", group: "Công việc", priority: "high" },
      { title: "High Task 2", group: "Dự án GitHub", priority: "high" },
      { title: "Medium Task 1", group: "Công việc", priority: "medium" },
      { title: "Low Task 1", group: "Công việc", priority: "low" },
      { title: "None Task 1", group: "Cá nhân", priority: "none" }
    ];

    for (const item of seed) {
      await page.click("#btnQuickGoAdd");
      await page.fill("#taskTitleInput", item.title);
      await page.selectOption("#taskGroupSelect", item.group);
      await page.selectOption("#taskPrioritySelect", item.priority);
      await page.click("#btnSubmitTask");
    }

    const allPrioPill = page.locator('#priorityFilterBar .filter-pill[data-priority="ALL"]');
    const highPill = page.locator('#priorityFilterBar .filter-pill[data-priority="high"]');
    const medPill = page.locator('#priorityFilterBar .filter-pill[data-priority="medium"]');
    const lowPill = page.locator('#priorityFilterBar .filter-pill[data-priority="low"]');
    const nonePill = page.locator('#priorityFilterBar .filter-pill[data-priority="none"]');

    // Ban đầu ở "Chưa làm": Tất cả cờ (5), High (2), Medium (1), Low (1), Không ưu tiên (1)
    await expect(allPrioPill).toHaveClass(/active/);
    await expect(allPrioPill).toContainText("Tất cả cờ (5)");
    await expect(highPill).toContainText("High (2)");
    await expect(medPill).toContainText("Medium (1)");
    await expect(lowPill).toContainText("Low (1)");
    await expect(nonePill).toContainText("Không ưu tiên (1)");

    // Tích hoàn thành 2 task High -> ở mục "Chưa làm", số lượng High giảm về 1 rồi về 0
    await page.locator(".task-card", { hasText: "High Task 1" }).locator(".task-checkbox").click();
    await expect(highPill).toContainText("High (1)");
    await expect(allPrioPill).toContainText("Tất cả cờ (4)");
    await expect(page.locator('#groupFilterBar .filter-pill[data-group="Công việc"]')).toContainText(
      "Công việc (2)"
    );

    await page.locator(".task-card", { hasText: "High Task 2" }).locator(".task-checkbox").click();
    await expect(highPill).toContainText("High (0)");
    await expect(allPrioPill).toContainText("Tất cả cờ (3)");
    await expect(
      page.locator('#groupFilterBar .filter-pill[data-group="Dự án GitHub"]')
    ).toContainText("Dự án GitHub (0)");

    // Chuyển sang "Đã xong" -> High hiện (2), các cờ khác hiện (0)
    await page.click("#segBtnDone");
    await expect(allPrioPill).toContainText("Tất cả cờ (2)");
    await expect(highPill).toContainText("High (2)");
    await expect(medPill).toContainText("Medium (0)");

    // Chuyển sang "Tất cả" -> High hiện (2), Tất cả cờ (5)
    await page.click("#segBtnAll");
    await expect(allPrioPill).toContainText("Tất cả cờ (5)");
    await expect(highPill).toContainText("High (2)");

    // Bỏ tích High Task 1 để quay lại Chưa làm kiểm thử chọn nhiều cờ cùng lúc
    await page.locator(".task-card", { hasText: "High Task 1" }).locator(".task-checkbox").click();
    await page.click("#segBtnTodo");
    await expect(highPill).toContainText("High (1)");
    await expect(allPrioPill).toContainText("Tất cả cờ (4)");

    // Chọn cờ High -> High active, Tất cả cờ bỏ active (1 task)
    await highPill.click();
    await expect(allPrioPill).not.toHaveClass(/active/);
    await expect(highPill).toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(1);

    // Chọn thêm cờ Low -> cả High & Low cùng active (2 tasks)
    await lowPill.click();
    await expect(highPill).toHaveClass(/active/);
    await expect(lowPill).toHaveClass(/active/);
    await expect(allPrioPill).not.toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(2);

    // Chọn thêm cờ Không ưu tiên -> 3 cờ cùng active (3 tasks)
    await nonePill.click();
    await expect(nonePill).toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(3);

    // Bấm lại cờ Low để bỏ chọn riêng cờ Low -> còn High & Không ưu tiên (2 tasks)
    await lowPill.click();
    await expect(lowPill).not.toHaveClass(/active/);
    await expect(highPill).toHaveClass(/active/);
    await expect(nonePill).toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(2);

    // Ấn "Tất cả cờ" -> bỏ chọn toàn bộ cờ lẻ, hiển thị đủ 4 task Chưa làm
    await allPrioPill.click();
    await expect(allPrioPill).toHaveClass(/active/);
    await expect(highPill).not.toHaveClass(/active/);
    await expect(medPill).not.toHaveClass(/active/);
    await expect(lowPill).not.toHaveClass(/active/);
    await expect(nonePill).not.toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(4);

    // Chọn 1 cờ rồi bấm lại chính cờ đó -> tự động quay về "Tất cả cờ"
    await medPill.click();
    await expect(medPill).toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(1);
    await medPill.click();
    await expect(medPill).not.toHaveClass(/active/);
    await expect(allPrioPill).toHaveClass(/active/);
    await expect(page.locator(".task-card")).toHaveCount(4);

    assertCleanConsole();
  });

  test("9. Nút Copy mô tả nhanh (cả Text + nhiều Hình ảnh đính kèm, an toàn XSS) & Toast Notification tự động ẩn", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.setViewportSize({ width: 800, height: 600 });

    const bodyTopBeforeToast = await page.locator("main.ext-body").evaluate((el) => {
      return el.getBoundingClientRect().top;
    });

    // 1. Tạo Task A: Không có mô tả và không có ảnh -> Không hiện nút Copy thừa, Toast hiện kiểu nổi không đẩy layout & tự ẩn
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Chỉ Có Tiêu Đề");
    await page.click("#btnSubmitTask");

    const banner = page.locator("#statusBanner");
    await expect(banner).toBeVisible();
    const bodyTopDuringToast = await page.locator("main.ext-body").evaluate((el) => {
      return el.getBoundingClientRect().top;
    });
    expect(bodyTopDuringToast).toBe(bodyTopBeforeToast);

    const titleOnlyCard = page.locator(".task-card", { hasText: "Task Chỉ Có Tiêu Đề" });
    await expect(titleOnlyCard.locator(".btn-copy-desc")).toHaveCount(0);

    // Kiểm tra Toast tự động ẩn sau ~2.8s mà KHÔNG cần nhấn nút ✕
    await expect(banner).toBeHidden({ timeout: 4500 });

    // 2. Tạo 2 file ảnh PNG trong bộ nhớ để đính kèm vào Task B (Có cả mô tả nhiều dòng + ký tự HTML + 2 ảnh)
    const samplePngBuffers = await page.evaluate(async () => {
      async function makePngBytes(w, h, color) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const buf = await blob.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      }
      return {
        img1: await makePngBytes(452, 399, "#ef4444"),
        img2: await makePngBytes(1400, 600, "#22c55e")
      };
    });

    const richDesc = 'Bước 1: Kiểm tra lỗi đăng nhập\nBước 2: <img src="x" onerror="window.__pasteXss=true"> an toàn';
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Có Mô Tả Và 1 Ảnh");
    await page.fill("#taskDescInput", richDesc);
    await page.setInputFiles("#taskImageInput", [
      { name: "bug-step1.png", mimeType: "image/png", buffer: Buffer.from(samplePngBuffers.img1) }
    ]);
    await expect(page.locator("#imageCountLabel")).toContainText("1/6 ảnh đính kèm");
    await page.click("#btnSubmitTask");

    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Có Mô Tả Và 2 Ảnh");
    await page.fill("#taskDescInput", richDesc);
    await page.setInputFiles("#taskImageInput", [
      { name: "bug-step1.png", mimeType: "image/png", buffer: Buffer.from(samplePngBuffers.img1) },
      { name: "bug-step2.png", mimeType: "image/png", buffer: Buffer.from(samplePngBuffers.img2) }
    ]);
    await expect(page.locator("#imageCountLabel")).toContainText("2/6 ảnh đính kèm");
    await page.click("#btnSubmitTask");

    // 3. Tạo vùng thử nghiệm Paste (cả Rich ContentEditable lẫn Plain Textarea) để kiểm tra dữ liệu thực trong Clipboard
    await page.evaluate(() => {
      window.__pasteXss = false;
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "-9999px";
      host.style.top = "0";

      const rich = document.createElement("div");
      rich.id = "e2ePasteRichTarget";
      rich.contentEditable = "true";
      rich.addEventListener("paste", (ev) => {
        const file = ev.clipboardData.files[0];
        window.__e2eLastPasteMeta = {
          types: Array.from(ev.clipboardData.types),
          filesCount: ev.clipboardData.files.length,
          fileType: file ? file.type : null,
          plain: ev.clipboardData.getData("text/plain")
        };
        if (file) {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => {
            window.__e2eLastPastePngDim = { w: im.naturalWidth, h: im.naturalHeight };
            URL.revokeObjectURL(url);
          };
          im.src = url;
        }
      });

      const plain = document.createElement("textarea");
      plain.id = "e2ePastePlainTarget";

      host.appendChild(rich);
      host.appendChild(plain);
      document.body.appendChild(host);
    });

    // 3a. Task có đúng 1 ảnh: bấm "📋 Copy" -> copy cả Text + 1 Ảnh nguyên bản (452x399) không bị vỡ
    const oneImgCard = page.locator(".task-card", { hasText: "Task Có Mô Tả Và 1 Ảnh" });
    await expect(oneImgCard.locator(".task-desc-box")).toBeHidden();
    const oneImgCopyBtn = oneImgCard.locator(".btn-copy-desc");
    await expect(oneImgCopyBtn).toBeVisible();
    await expect(oneImgCopyBtn).toHaveText("📋 Copy");

    await oneImgCopyBtn.click();
    await expect(oneImgCopyBtn).toHaveText("✓ Đã copy");
    await expect(oneImgCopyBtn).toHaveClass(/copied/);
    await expect(banner).toContainText("Đã sao chép mô tả kèm 1 ảnh");

    // Kiểm tra tạm dừng Toast khi rê chuột vào (hover) và tự ẩn khi rời chuột ra
    await banner.hover();
    await page.waitForTimeout(3000);
    await expect(banner).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(banner).toBeHidden({ timeout: 3500 });

    // Paste vào Rich Editor -> nhận đầy đủ văn bản mô tả + 1 thẻ <img> + 1 file image/png nguyên gốc (452x399) + không chạy XSS
    await page.focus("#e2ePasteRichTarget");
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => window.__e2eLastPastePngDim !== undefined);

    const pastedOneImgCheck = await page.evaluate(() => ({
      meta: window.__e2eLastPasteMeta,
      pngDim: window.__e2eLastPastePngDim,
      imgCount: document.querySelectorAll("#e2ePasteRichTarget img").length,
      text: document.getElementById("e2ePasteRichTarget").innerText,
      xssExecuted: window.__pasteXss
    }));

    expect(pastedOneImgCheck.xssExecuted).toBe(false);
    expect(pastedOneImgCheck.meta.types).toEqual(["text/plain", "text/html", "Files"]);
    expect(pastedOneImgCheck.meta.filesCount).toBe(1);
    expect(pastedOneImgCheck.meta.fileType).toBe("image/png");
    expect(pastedOneImgCheck.meta.plain).toBe(richDesc);
    expect(pastedOneImgCheck.imgCount).toBe(1);
    expect(pastedOneImgCheck.text).toContain("Bước 1: Kiểm tra lỗi đăng nhập");
    expect(pastedOneImgCheck.pngDim).toEqual({ w: 452, h: 399 });

    // Paste vào Plain Textarea -> nhận đúng nội dung văn bản gốc
    await page.focus("#e2ePastePlainTarget");
    await page.keyboard.press("Control+V");
    await expect(page.locator("#e2ePastePlainTarget")).toHaveValue(richDesc);

    // 3b. Task có từ 2 ảnh trở lên: bấm "📋 Copy" -> chỉ copy Text mô tả (không ghép ảnh để tránh vỡ nét)
    await page.evaluate(() => {
      document.getElementById("e2ePasteRichTarget").innerHTML = "";
      window.__e2eLastPasteMeta = undefined;
      window.__e2eLastPastePngDim = undefined;
    });
    const richCard = page.locator(".task-card", { hasText: "Task Có Mô Tả Và 2 Ảnh" });
    const copyBtn = richCard.locator(".btn-copy-desc");
    await copyBtn.click();
    await expect(banner).toContainText("bấm 📋 trên từng ảnh để copy riêng không bị vỡ");

    await page.focus("#e2ePasteRichTarget");
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => window.__e2eLastPasteMeta !== undefined);
    const pastedMultiImgTaskCheck = await page.evaluate(() => ({
      meta: window.__e2eLastPasteMeta,
      imgCount: document.querySelectorAll("#e2ePasteRichTarget img").length
    }));
    expect(pastedMultiImgTaskCheck.meta.types).toEqual(["text/plain", "text/html"]);
    expect(pastedMultiImgTaskCheck.meta.filesCount).toBe(0);
    expect(pastedMultiImgTaskCheck.meta.plain).toBe(richDesc);
    expect(pastedMultiImgTaskCheck.imgCount).toBe(0);

    // 4. Mở Lightbox xem ảnh lẻ -> nhấn nút "📋 Copy ảnh" -> sao chép riêng bức ảnh đó
    await page.evaluate(() => {
      document.getElementById("e2ePasteRichTarget").innerHTML = "";
      window.__e2eLastPasteMeta = undefined;
      window.__e2eLastPastePngDim = undefined;
    });
    await richCard.locator(".task-img-thumb").first().click();
    await expect(page.locator("#imageLightbox")).toHaveClass(/show/);
    await page.click("#btnCopyLightboxImage");
    await expect(page.locator("#btnCopyLightboxImage")).toHaveText("✓ Đã copy ảnh");
    await page.click("#btnCloseLightbox");

    await page.focus("#e2ePasteRichTarget");
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => window.__e2eLastPastePngDim !== undefined);
    const singleImgCheck = await page.evaluate(() => ({
      meta: window.__e2eLastPasteMeta,
      imgCount: document.querySelectorAll("#e2ePasteRichTarget img").length
    }));
    expect(singleImgCheck.meta.types).toEqual(["text/html", "Files"]);
    expect(singleImgCheck.imgCount).toBe(1);

    // 5. Hover lên từng ảnh nhỏ trên card -> bấm nút "📋" góc phải ảnh để copy lẻ 1 click (không mở Lightbox)
    await page.evaluate(() => {
      document.getElementById("e2ePasteRichTarget").innerHTML = "";
      window.__e2eLastPasteMeta = undefined;
      window.__e2eLastPastePngDim = undefined;
    });
    const secondThumbWrap = richCard.locator(".task-img-thumb-wrap").nth(1);
    await secondThumbWrap.hover();
    await secondThumbWrap.locator(".thumb-copy-btn").click();
    await expect(page.locator("#imageLightbox")).not.toHaveClass(/show/);
    await expect(secondThumbWrap.locator(".thumb-copy-btn")).toHaveText("✓");

    await page.focus("#e2ePasteRichTarget");
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => window.__e2eLastPastePngDim !== undefined);
    const secondThumbDim = await page.evaluate(() => window.__e2eLastPastePngDim);
    expect(secondThumbDim).toEqual({ w: 1400, h: 600 });

    assertCleanConsole();
  });

  test("10. Cây thư mục đa cấp (Subfolders) & Đồng bộ Git Trees API (<folder>/tasks.json cho từng thư mục)", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    // 1. Mở tab Quản lý Nhóm -> Tạo thư mục con qua dropdown Nhóm cha & nút ➕ Nhóm con trực tiếp
    await page.click("#tabBtnGroups");
    await expect(page.locator("#viewGroups")).toHaveClass(/active/);

    // Chọn nhóm cha "Công việc" từ dropdown #crudParentGroupSelect rồi tạo "Dự án A"
    await page.selectOption("#crudParentGroupSelect", "Công việc");
    await page.fill("#crudNewGroupInput", "Dự án A");
    await page.click("#btnCrudAddGroup");

    const subGroupRow = page.locator('.group-crud-item[data-group-item="Công việc/Dự án A"]');
    await expect(subGroupRow).toBeVisible();
    await expect(subGroupRow).toHaveClass(/is-subfolder/);

    // Ngay cả khi chưa có task nào, thao tác thêm thư mục phải đánh dấu Working Tree là "Chưa sạch" (dirty)
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Dùng nút "➕ Nhóm con" ngay trên dòng "Công việc/Dự án A" để tạo thư mục cháu "Sprint 1"
    await subGroupRow.locator(".btn-add-subfolder").click();
    const inlineSubInput = subGroupRow.locator(".group-subfolder-input");
    await expect(inlineSubInput).toBeVisible();
    await inlineSubInput.fill("Sprint 1");
    await subGroupRow.locator(".btn-save-subfolder").click();

    const grandChildRow = page.locator(
      '.group-crud-item[data-group-item="Công việc/Dự án A/Sprint 1"]'
    );
    await expect(grandChildRow).toBeVisible();

    // Tạo thêm 1 thư mục gốc rỗng "Lưu trữ"
    await page.selectOption("#crudParentGroupSelect", "");
    await page.fill("#crudNewGroupInput", "Lưu trữ");
    await page.click("#btnCrudAddGroup");
    await expect(page.locator('.group-crud-item[data-group-item="Lưu trữ"]')).toBeVisible();

    // 2. Tạo công việc ở thư mục gốc "Công việc" và thư mục cháu "Công việc/Dự án A/Sprint 1"
    await page.click("#tabBtnAddTask");
    await page.fill("#taskTitleInput", "Họp định kỳ đầu tuần");
    await page.selectOption("#taskGroupSelect", "Công việc");
    await page.click("#btnSubmitTask");

    await page.click("#tabBtnAddTask");
    await page.fill("#taskTitleInput", "Thiết kế kiến trúc Git Tree");
    await page.selectOption("#taskGroupSelect", "Công việc/Dự án A/Sprint 1");
    await page.click("#btnSubmitTask");

    // Kiểm tra giao diện cây thư mục lồng nhau trong tab Danh sách và bộ lọc theo cây
    const rootSection = page.locator('.group-section[data-group-name="Công việc"]');
    const nestedSection = rootSection.locator(
      '.group-section-nested[data-group-name="Công việc/Dự án A/Sprint 1"]'
    );
    await expect(rootSection).toBeVisible();
    await expect(nestedSection).toBeVisible();
    await expect(nestedSection).toContainText("Thiết kế kiến trúc Git Tree");

    // Khi lọc theo nhóm cha "Công việc", phải hiển thị cả công việc của nhóm con/cháu
    await page.click('#groupFilterBar .filter-pill[data-group="Công việc"]');
    await expect(page.locator(".task-card")).toHaveCount(2);

    // Khi lọc riêng nhóm cháu "Công việc/Dự án A/Sprint 1", chỉ hiển thị 1 công việc
    await page.click('#groupFilterBar .filter-pill[data-group="Công việc/Dự án A/Sprint 1"]');
    await expect(page.locator(".task-card")).toHaveCount(1);
    await expect(page.locator(".task-card").first()).toContainText("Thiết kế kiến trúc Git Tree");
    await page.click('#groupFilterBar .filter-pill[data-group="ALL"]');

    // 3. Mock GitHub Git Trees API để kiểm tra Push/Pull từng thư mục thành <folder>/tasks.json
    let headCommitSha = "commit_initial_001";
    let headTreeSha = "tree_initial_001";
    const blobStore = new Map();
    let currentTreeEntries = []; // [{ path, mode, type, sha }]
    const pushedTreePayloads = [];

    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      const method = req.method();
      const url = new URL(req.url());
      const pathname = decodeURIComponent(url.pathname);

      // GET /repos/:owner/:repo/git/refs/heads/:branch
      if (method === "GET" && pathname.includes("/git/refs/heads/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: headCommitSha, type: "commit" }
          })
        });
        return;
      }

      // GET /repos/:owner/:repo/git/commits/:sha
      if (method === "GET" && pathname.includes("/git/commits/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha: headCommitSha,
            tree: { sha: headTreeSha }
          })
        });
        return;
      }

      // GET /repos/:owner/:repo/git/trees/:sha
      if (method === "GET" && pathname.includes("/git/trees/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha: headTreeSha,
            truncated: false,
            tree: currentTreeEntries
          })
        });
        return;
      }

      // POST /repos/:owner/:repo/git/trees
      if (method === "POST" && pathname.endsWith("/git/trees")) {
        const body = JSON.parse(req.postData() || "{}");
        pushedTreePayloads.push(body);

        const nextMap = new Map(currentTreeEntries.map((item) => [item.path, item]));
        for (const entry of body.tree || []) {
          if (entry.sha === null) {
            nextMap.delete(entry.path);
          } else {
            const blobSha = `blob_${ nextMap.size + 1 }_${ Date.now() }_${ Math.random().toString(16).slice(2, 6) }`;
            blobStore.set(blobSha, entry.content || "");
            nextMap.set(entry.path, {
              path: entry.path,
              mode: entry.mode || "100644",
              type: "blob",
              sha: blobSha
            });
          }
        }
        currentTreeEntries = Array.from(nextMap.values());
        headTreeSha = `tree_pushed_${ pushedTreePayloads.length }`;

        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ sha: headTreeSha, tree: currentTreeEntries })
        });
        return;
      }

      // POST /repos/:owner/:repo/git/commits
      if (method === "POST" && pathname.endsWith("/git/commits")) {
        const nextCommit = `commit_pushed_${ pushedTreePayloads.length }_abcdef`;
        headCommitSha = nextCommit;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ sha: nextCommit })
        });
        return;
      }

      // PATCH /repos/:owner/:repo/git/refs/heads/:branch
      if (method === "PATCH" && pathname.includes("/git/refs/heads/")) {
        const body = JSON.parse(req.postData() || "{}");
        headCommitSha = body.sha || headCommitSha;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ object: { sha: headCommitSha } })
        });
        return;
      }

      // GET /repos/:owner/:repo/git/blobs/:sha
      if (method === "GET" && pathname.includes("/git/blobs/")) {
        const sha = pathname.split("/git/blobs/")[1];
        const text = blobStore.get(sha) || "[]";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sha,
            encoding: "base64",
            content: Buffer.from(text, "utf8").toString("base64")
          })
        });
        return;
      }

      await route.fulfill({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
    });

    // Lưu cấu hình GitHub với đường dẫn trong thư mục "data/todo-tree.json"
    await page.click("#tabBtnSettings");
    await page.fill("#ghOwnerInput", "dev-org");
    await page.fill("#ghRepoInput", "todo-folder-repo");
    await page.fill("#ghBranchInput", "main");
    await page.fill("#ghFilePathInput", "data/todo-tree.json");
    await page.fill("#ghTokenInput", "ghp_FolderTreeToken1234567890");
    await page.click("#btnSaveGitHubConfig");

    // 4. Thực hiện Push GitHub -> kiểm tra cấu trúc file theo từng thư mục trong Git Tree
    await page.click("#btnPushGitHub");
    await expect(page.locator("#statusBanner")).toContainText("Push thành công");
    await expect(page.locator("#treeStatusBadge")).toContainText("Cây sạch");

    expect(pushedTreePayloads.length).toBe(1);
    const firstTree = pushedTreePayloads[0].tree;
    const pushedPaths = firstTree.map((e) => e.path);

    expect(pushedPaths).toContain("data/todo-tree.json");
    expect(pushedPaths).toContain("data/Công việc/tasks.json");
    expect(pushedPaths).toContain("data/Công việc/Dự án A/tasks.json");
    expect(pushedPaths).toContain("data/Công việc/Dự án A/Sprint 1/tasks.json");
    expect(pushedPaths).toContain("data/Lưu trữ/tasks.json");

    const workTasksEntry = firstTree.find((e) => e.path === "data/Công việc/tasks.json");
    const sprintTasksEntry = firstTree.find(
      (e) => e.path === "data/Công việc/Dự án A/Sprint 1/tasks.json"
    );
    const emptyFolderEntry = firstTree.find((e) => e.path === "data/Lưu trữ/tasks.json");

    expect(JSON.parse(workTasksEntry.content)).toHaveLength(1);
    expect(JSON.parse(workTasksEntry.content)[0].title).toBe("Họp định kỳ đầu tuần");
    expect(JSON.parse(sprintTasksEntry.content)).toHaveLength(1);
    expect(JSON.parse(sprintTasksEntry.content)[0].title).toBe("Thiết kế kiến trúc Git Tree");
    expect(JSON.parse(emptyFolderEntry.content)).toEqual([]);

    // 5. Đổi tên thư mục gốc "Công việc" -> "Work" -> kiểm tra cập nhật dây chuyền xuống nhóm con & xóa thư mục cũ trên Git
    await page.click("#tabBtnGroups");
    const rootGroupRow = page.locator('.group-crud-item[data-group-item="Công việc"]');
    await rootGroupRow.locator(".btn-rename-group").click();
    await rootGroupRow.locator(".group-rename-input").fill("Work");
    await rootGroupRow.locator(".btn-save-rename-group").click();

    await expect(page.locator('.group-crud-item[data-group-item="Work"]')).toBeVisible();
    await expect(page.locator('.group-crud-item[data-group-item="Work/Dự án A"]')).toBeVisible();
    await expect(
      page.locator('.group-crud-item[data-group-item="Work/Dự án A/Sprint 1"]')
    ).toBeVisible();
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Push lần 2 sau khi đổi tên thư mục cha
    await page.click("#btnPushGitHub");
    await expect(page.locator("#statusBanner")).toContainText("Push thành công");
    await expect(page.locator("#treeStatusBadge")).toContainText("Cây sạch");

    expect(pushedTreePayloads.length).toBe(2);
    const secondTree = pushedTreePayloads[1].tree;
    const deletedEntries = secondTree.filter((e) => e.sha === null).map((e) => e.path);
    expect(deletedEntries).toContain("data/Công việc/tasks.json");
    expect(deletedEntries).toContain("data/Công việc/Dự án A/tasks.json");
    expect(deletedEntries).toContain("data/Công việc/Dự án A/Sprint 1/tasks.json");

    const createdWorkPaths = secondTree.filter((e) => e.sha !== null).map((e) => e.path);
    expect(createdWorkPaths).toContain("data/Work/tasks.json");
    expect(createdWorkPaths).toContain("data/Work/Dự án A/tasks.json");
    expect(createdWorkPaths).toContain("data/Work/Dự án A/Sprint 1/tasks.json");

    // 6. Kiểm tra Pull GitHub từ cây thư mục trên Git Tree về lại máy
    await page.click("#btnPullGitHub");
    await expect(page.locator("#statusBanner")).toContainText(
      "Pull thành công (2 công việc • 7 thư mục)"
    );
    await expect(
      page.locator('.group-crud-item[data-group-item="Work/Dự án A/Sprint 1"]')
    ).toBeVisible();
    await expect(page.locator('.group-crud-item[data-group-item="Lưu trữ"]')).toBeVisible();

    await context.unroute("https://api.github.com/**");
    assertCleanConsole();
  });
});

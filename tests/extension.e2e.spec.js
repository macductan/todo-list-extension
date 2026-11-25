const { test, expect, chromium } = require("@playwright/test");
const { execFileSync } = require("child_process");
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
    await expect(page.locator("#segBtnAll")).toHaveCount(0);
    await expect(page.locator("#btnTogglePriorityGroup")).toHaveCount(0);
    await expect(page.locator("#btnToggleGroupBy")).toHaveCount(0);
    await expect(page.locator("#priorityFilterBar")).toHaveCount(0);
    await expect(page.locator("#groupFilterBar")).toHaveCount(0);

    // Mặc định các folder đều hiển thị và thu gọn (collapsed) trên màn danh sách
    await expect(page.locator(".group-section")).toHaveCount(4);
    await expect(page.locator('.group-section[data-group-name="Công việc"] .group-header')).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await expect(page.locator('.group-section[data-group-name="Công việc"] .group-task-count')).toHaveText(
      "0 công việc"
    );

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
    const sprintSection = page.locator('.group-section[data-group-name="Sprint Alpha"]');
    await expect(sprintSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await expect(sprintSection.locator(".group-task-count")).toHaveText("1 công việc");
    await sprintSection.locator(".group-header").click();
    await expect(sprintSection.locator(".group-header")).toHaveAttribute("aria-expanded", "true");

    const firstCard = sprintSection.locator(".task-card").first();
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

    // Mở rộng nhóm "Cá nhân" để sửa Task 2
    const personalSection = page.locator('.group-section[data-group-name="Cá nhân"]');
    await personalSection.locator(".group-header").click();
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
    await expect(
      page.locator('.group-section[data-group-name="Sprint Alpha"] .group-header')
    ).toHaveAttribute("aria-expanded", "false");
    assertCleanConsole();
  });

  test("2. Đổi trạng thái Chưa làm <-> Đã xong, Sắp xếp theo Priority trong Folder, Tìm kiếm & Theme", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    const seedTasks = [
      { title: "Task Nhóm A - Ưu tiên Thấp", group: "Công việc", priority: "low" },
      { title: "Task Nhóm A - Ưu tiên Cao", group: "Công việc", priority: "high" },
      { title: "Task Nhóm B - Dự án GitHub", group: "Dự án GitHub", priority: "medium" }
    ];

    for (const item of seedTasks) {
      await page.click("#btnQuickGoAdd");
      await page.fill("#taskTitleInput", item.title);
      await page.selectOption("#taskGroupSelect", item.group);
      await page.selectOption("#taskPrioritySelect", item.priority);
      await page.click("#btnSubmitTask");
    }

    // Chỉ gom theo Folder (không còn priority-section bên trong), mặc định thu gọn
    await expect(page.locator(".group-section")).toHaveCount(4);
    await expect(page.locator(".priority-section")).toHaveCount(0);

    const workSection = page.locator('.group-section[data-group-name="Công việc"]');
    await workSection.locator(".group-header").click();
    const workTitles = await workSection
      .locator(".task-card .task-title")
      .allTextContents();
    expect(workTitles).toEqual(["Task Nhóm A - Ưu tiên Cao", "Task Nhóm A - Ưu tiên Thấp"]);

    // Kiểm tra tìm kiếm từ khóa
    await page.fill("#searchTaskInput", "Dự án GitHub");
    await expect(page.locator(".group-section")).toHaveCount(1);
    await expect(page.locator(".task-card")).toHaveCount(1);
    await page.fill("#searchTaskInput", "");
    await expect(page.locator(".group-section")).toHaveCount(4);
    await expect(page.locator(".task-card")).toHaveCount(3);

    // Đánh dấu hoàn thành -> chuyển sang tab Đã xong -> bỏ đánh dấu quay lại Chưa làm
    const highTaskCard = page.locator(".task-card", { hasText: "Task Nhóm A - Ưu tiên Cao" });
    await highTaskCard.locator(".task-checkbox").click();

    await expect(page.locator("#countTodoBadge")).toHaveText("2");
    await expect(page.locator("#countDoneBadge")).toHaveText("1");

    await page.click("#segBtnDone");
    await expect(page.locator(".group-section")).toHaveCount(1);
    await expect(page.locator(".task-card")).toHaveCount(1);
    await expect(workSection.locator(".group-header")).toHaveAttribute("aria-expanded", "true");
    await expect(workSection.locator(".task-card")).toHaveClass(/done/);
    await workSection.locator(".task-card .task-checkbox").click();
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

    // Mở rộng nhóm "Công việc" rồi xóa 1 trong 2 task từng bị trùng ID -> chỉ xóa đúng 1 task nhờ deduplicate ID
    await page.locator('.group-section[data-group-name="Công việc"] .group-header').click();
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

  test("6. Kiểm thử các yêu cầu giao diện & nút thêm ở Folder, mặc định thu gọn Folder, bỏ filter/group thừa, rút gọn mô tả & 4 màu cờ", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.setViewportSize({ width: 800, height: 600 });

    // Kiểm tra đã bỏ hoàn toàn filter theo folder, option group theo nhóm/priority, filter priority và tab Tất cả
    await expect(page.locator("#segBtnAll")).toHaveCount(0);
    await expect(page.locator("#segBtnTodo")).toBeVisible();
    await expect(page.locator("#segBtnDone")).toBeVisible();
    await expect(page.locator("#groupFilterBar")).toHaveCount(0);
    await expect(page.locator("#priorityFilterBar")).toHaveCount(0);
    await expect(page.locator("#btnToggleGroupBy")).toHaveCount(0);
    await expect(page.locator("#btnTogglePriorityGroup")).toHaveCount(0);
    await expect(page.locator("#btnQuickManageGroups")).toHaveCount(0);

    // Kiểm tra nút "➕ Thêm" trực tiếp trên từng Folder (kể cả Folder trống) và mặc định thu gọn Folder
    const urgentSection = page.locator('.group-section[data-group-name="Khẩn cấp"]');
    await expect(urgentSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await expect(urgentSection.locator(".group-task-count")).toHaveText("0 công việc");
    await expect(urgentSection.locator(".group-header")).not.toContainText("Hoàn thành");
    await urgentSection.locator(".btn-folder-add-task").click();
    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);
    await expect(page.locator("#taskGroupSelect")).toHaveValue("Khẩn cấp");
    // Bấm nút Thêm trong Folder không làm mở Folder đó ở màn list
    await page.click("#btnCancelEdit");
    await expect(urgentSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");

    const longMultilineDesc = [
      "Dòng 1: Kiểm tra luồng xác thực Fine-grained PAT với GitHub REST Contents API.",
      "Dòng 2: Đảm bảo lưu base_sha vào chrome.storage.local sau mỗi lần Pull hoặc Push.",
      "Dòng 3: Phần nội dung dài từ dòng thứ 3 trở đi bắt buộc phải được rút gọn tự động.",
      "Dòng 4: Người dùng nhấn Xem thêm mới mở rộng toàn bộ và nhấn Thu gọn để đóng bớt lại.",
      "Dòng 5: Mặc định khi mới tạo hoặc tải danh sách thì vùng mô tả luôn ở trạng thái ẩn."
    ].join("\n");

    // 1) Dùng nút "➕ Thêm" trên folder "Công việc" -> tạo task KHÔNG chọn cờ ưu tiên (mặc định "none") + mô tả dài mặc định ẩn
    const workGroupSection = page.locator('.group-section[data-group-name="Công việc"]');
    await workGroupSection.locator(".btn-folder-add-task").click();
    await expect(page.locator("#taskGroupSelect")).toHaveValue("Công việc");
    await expect(page.locator("#taskPrioritySelect")).toHaveValue("none");
    await page.fill("#taskTitleInput", "Task Mặc Định Không Ưu Tiên");
    await page.fill("#taskDescInput", longMultilineDesc);
    await page.click("#btnSubmitTask");

    // Mặc định folder vẫn thu gọn -> click mở rộng "Công việc"
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await expect(workGroupSection.locator(".group-task-count")).toHaveText("1 công việc");
    await workGroupSection.locator(".group-header").click();
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "true");

    const defaultCard = page.locator(".task-card", { hasText: "Task Mặc Định Không Ưu Tiên" });
    await expect(defaultCard).toHaveAttribute("data-priority", "none");
    await expect(defaultCard.locator(".badge-prio-none")).toContainText("Không ưu tiên");

    // Mặc định là ẩn mô tả ở danh sách list
    const descBox = defaultCard.locator(".task-desc-box");
    await expect(descBox).toBeHidden();

    // Mở mô tả dài -> bị rút gọn 2 dòng (scrollHeight > clientHeight) kèm nút "Xem thêm ▾"
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
      await page.locator(`.group-section[data-group-name="${item.group}"] .btn-folder-add-task`).click();
      await expect(page.locator("#taskGroupSelect")).toHaveValue(item.group);
      await page.fill("#taskTitleInput", item.title);
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

    // 3) Không còn thanh chia nhóm Priority con bên trong Folder; các task bên trong vẫn xếp theo High -> Medium -> Low -> None
    await expect(page.locator(".priority-section")).toHaveCount(0);
    await expect(workGroupSection.locator(".group-task-count")).toHaveText("4 công việc");
    await expect(workGroupSection.locator(".group-header")).not.toContainText("Hoàn thành");

    const renderedTitlesInWorkGroup = await workGroupSection
      .locator(".task-card .task-title")
      .allTextContents();
    expect(renderedTitlesInWorkGroup).toEqual([
      "Task Cờ Cao",
      "Task Cờ Trung Bình",
      "Task Cờ Thấp",
      "Task Mặc Định Không Ưu Tiên"
    ]);

    // 4) Đóng / mở từng Folder độc lập & mặc định thu gọn lại sau reload
    const githubGroupSection = page.locator('.group-section[data-group-name="Dự án GitHub"]');
    await expect(githubGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await expect(githubGroupSection.locator(".group-section-body")).toBeHidden();
    await githubGroupSection.locator(".group-header").click();
    await expect(githubGroupSection.locator(".group-section-body")).toBeVisible();

    await workGroupSection.locator(".group-header").click();
    await expect(workGroupSection.locator(".group-section-body")).toBeHidden();
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");

    await page.reload();
    await expect(workGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");
    await expect(githubGroupSection.locator(".group-header")).toHaveAttribute("aria-expanded", "false");

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
    expect(manifestJson.permissions).toEqual(["storage", "nativeMessaging"]);
    expect(manifestJson.host_permissions).toEqual(["https://api.github.com/*"]);
    expect(manifestJson.action.default_popup).toBeUndefined();

    // ==================== A. KIỂM THỬ TRẠNG THÁI BAN ĐẦU CÂY SẠCH & MẶC ĐỊNH AUTO PUSH + WINDOW DEFAULT ====================
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch");
    await expect(page.locator("#treeStatusBadge")).toHaveClass(/clean/);

    await page.click("#tabBtnSettings");
    await expect(page.locator("#autoPushEnabledInput")).toBeChecked();
    await expect(page.locator("#autoPushDebounceValue")).toHaveValue("10");
    await expect(page.locator("#autoPushDebounceUnit")).toHaveValue("s");
    await expect(page.locator("#autoPushMaxWaitValue")).toHaveValue("5");
    await expect(page.locator("#autoPushMaxWaitUnit")).toHaveValue("m");
    await expect(page.locator("#launchModeSelect")).toHaveValue("window");

    // ==================== B. KIỂM THỬ QUẢN LÝ CRUD NHÓM (REQ 7) ====================
    await page.click("#tabBtnGroups");
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
    await expect(
      page.locator('.group-crud-item[data-group-item="Core Backend"] .group-crud-count')
    ).toHaveText("1 công việc");
    await page.click("#tabBtnTasks");
    await page.locator('.group-section[data-group-name="Core Backend"] .group-header').click();
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
    await page.locator('.group-section[data-group-name="Dự án GitHub"] .group-header').click();
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
    // Đặt Debounce = 3s nhưng MaxWait = 2s (thao tác liên tục mỗi 650ms làm Debounce liên tục bị đẩy lùi)
    // để chứng minh dù thay đổi liên tục không nghỉ, đúng hạn từ thay đổi đầu tiên hệ thống vẫn tự động commit & Push!
    await page.click("#tabBtnSettings");
    await page.fill("#autoPushDebounceValue", "3");
    await page.selectOption("#autoPushDebounceUnit", "s");
    await page.fill("#autoPushMaxWaitValue", "2");
    await page.selectOption("#autoPushMaxWaitUnit", "s");
    await page.click("#btnSavePreferences");

    await page.click("#tabBtnTasks");

    const firstChangeStartedAt = Date.now();
    await page.locator(".task-card .task-checkbox").first().click(); // t ~ 0ms (chuyển sang Đã xong)
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Tiếp tục thao tác liên tục mỗi 650ms qua tab Đã xong / Chưa làm (giữ folder Dự án GitHub đang mở)
    await page.waitForTimeout(650);
    await page.click("#segBtnDone");
    await page.locator(".task-card .task-checkbox").first().click(); // t ~ 650ms (chuyển về Chưa làm)
    await page.waitForTimeout(650);
    await page.click("#segBtnTodo");
    await page.locator(".task-card .task-checkbox").first().click(); // t ~ 1300ms (chuyển sang Đã xong)

    await expect.poll(() => putCount, { timeout: 3500 }).toBe(2);
    const elapsedMs = Date.now() - firstChangeStartedAt;
    // Phải hoàn tất trước mốc Debounce 3s tính từ thay đổi cuối (1300ms + 3000ms = 4300ms) nhờ trần MaxWait 2s!
    expect(elapsedMs).toBeLessThan(3600);
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch (Đã commit)");

    assertCleanConsole();
  });

  test("8. Tab Đã xong: Mặc định nút Xóa task quá 30 ngày & Xóa theo mốc ngày tùy chọn", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    const formatLocalYMD = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const now = new Date();
    const daysAgoIso = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const expectedDefaultCutoff = (() => {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return formatLocalYMD(d);
    })();
    const threeDaysAgoDateStr = (() => {
      const d = new Date(now);
      d.setDate(d.getDate() - 3);
      return formatLocalYMD(d);
    })();

    const seededTasks = [
      {
        id: "done-35d",
        title: "Việc xong 35 ngày trước",
        description: "",
        group: "Công việc",
        priority: "medium",
        status: "done",
        updatedAt: daysAgoIso(35)
      },
      {
        id: "done-31d",
        title: "Việc xong 31 ngày trước",
        description: "",
        group: "Dự án GitHub",
        priority: "low",
        status: "done",
        updatedAt: daysAgoIso(31)
      },
      {
        id: "done-5d",
        title: "Việc xong 5 ngày trước",
        description: "",
        group: "Công việc",
        priority: "high",
        status: "done",
        updatedAt: daysAgoIso(5)
      },
      {
        id: "done-today",
        title: "Việc vừa xong hôm nay",
        description: "",
        group: "Cá nhân",
        priority: "none",
        status: "done",
        updatedAt: daysAgoIso(0)
      },
      {
        id: "todo-40d",
        title: "Việc chưa làm 40 ngày trước",
        description: "",
        group: "Công việc",
        priority: "high",
        status: "todo",
        updatedAt: daysAgoIso(40)
      }
    ];

    await page.evaluate((tasks) => {
      return new Promise((resolve) => {
        chrome.storage.local.set({ tasks }, resolve);
      });
    }, seededTasks);

    await page.reload();

    // Ở tab Chưa làm: thanh dọn dẹp Đã xong bị ẩn, số lượng bộ đếm đúng
    await expect(page.locator("#doneClearBar")).toBeHidden();
    await expect(page.locator("#countTodoBadge")).toHaveText("1");
    await expect(page.locator("#countDoneBadge")).toHaveText("4");

    // Chuyển sang tab Đã xong: mặc định chọn ngày cách hôm nay 30 ngày & nút Xóa task quá 30 ngày (2)
    await page.click("#segBtnDone");
    await expect(page.locator("#doneClearBar")).toBeVisible();
    await expect(page.locator("#clearDoneDateInput")).toHaveValue(expectedDefaultCutoff);
    await expect(page.locator("#btnClearDoneTasks")).toHaveText("🗑️ Xóa task quá 30 ngày (2)");
    await expect(page.locator("#btnClearDoneTasks")).toBeEnabled();

    // Bấm Xóa task quá 30 ngày -> xóa 2 task (35 ngày & 31 ngày), giữ lại 2 task mới xong + 1 task chưa làm
    await page.click("#btnClearDoneTasks");
    await expect(page.locator("#countDoneBadge")).toHaveText("2");
    await expect(page.locator("#countTodoBadge")).toHaveText("1");
    await expect(page.locator("#btnClearDoneTasks")).toHaveText("🗑️ Xóa task quá 30 ngày (0)");
    await expect(page.locator("#btnClearDoneTasks")).toBeDisabled();
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Đổi mốc ngày sang 3 ngày trước -> hiển thị nút Xóa task từ <ngày> trở về trước (1) cho task 5 ngày trước
    await page.fill("#clearDoneDateInput", threeDaysAgoDateStr);
    await expect(page.locator("#btnClearDoneTasks")).toHaveText(
      `🗑️ Xóa task từ ${threeDaysAgoDateStr} trở về trước (1)`
    );
    await expect(page.locator("#btnClearDoneTasks")).toBeEnabled();

    await page.click("#btnClearDoneTasks");
    await expect(page.locator("#countDoneBadge")).toHaveText("1");
    await expect(page.locator("#countTodoBadge")).toHaveText("1");

    // Mở folder "Cá nhân" kiểm chứng task hôm nay vẫn còn, và kiểm tra bền vững sau reload
    await page.locator('.group-section[data-group-name="Cá nhân"] .group-header').click();
    await expect(page.locator(".task-card .task-title")).toHaveText("Việc vừa xong hôm nay");

    await page.reload();
    await expect(page.locator("#countDoneBadge")).toHaveText("1");
    await expect(page.locator("#countTodoBadge")).toHaveText("1");

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
    await expect(page.locator("#imageCountLabel")).toContainText("1/6 tệp đính kèm");
    await page.click("#btnSubmitTask");

    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Có Mô Tả Và 2 Ảnh");
    await page.fill("#taskDescInput", richDesc);
    await page.setInputFiles("#taskImageInput", [
      { name: "bug-step1.png", mimeType: "image/png", buffer: Buffer.from(samplePngBuffers.img1) },
      { name: "bug-step2.png", mimeType: "image/png", buffer: Buffer.from(samplePngBuffers.img2) }
    ]);
    await expect(page.locator("#imageCountLabel")).toContainText("2/6 tệp đính kèm");
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

    // Mở rộng folder "Công việc" trước khi kiểm tra nút Copy và Paste trên thẻ công việc
    await page.locator('.group-section[data-group-name="Công việc"] .group-header').click();

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

    // Kiểm tra giao diện cây thư mục lồng nhau trong tab Danh sách (mặc định thu gọn -> mở rộng từng cấp & kiểm tra nút ➕ Thêm ở subfolder)
    const rootSection = page.locator('.group-section[data-group-name="Công việc"]');
    const midSection = rootSection.locator(
      '.group-section-nested[data-group-name="Công việc/Dự án A"]'
    );
    const nestedSection = rootSection.locator(
      '.group-section-nested[data-group-name="Công việc/Dự án A/Sprint 1"]'
    );
    await expect(rootSection).toBeVisible();
    await expect(rootSection.locator(".group-header").first()).toHaveAttribute("aria-expanded", "false");
    await rootSection.locator("> .group-header").click();
    await expect(midSection).toBeVisible();
    await midSection.locator("> .group-header").click();
    await expect(nestedSection).toBeVisible();
    await nestedSection.locator("> .group-header").click();
    await expect(nestedSection).toContainText("Thiết kế kiến trúc Git Tree");

    // Kiểm tra nút ➕ Thêm trên thư mục cháu chọn sẵn đúng đường dẫn thư mục cháu
    await nestedSection.locator("> .group-header .btn-folder-add-task").click();
    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);
    await expect(page.locator("#taskGroupSelect")).toHaveValue("Công việc/Dự án A/Sprint 1");
    await page.click("#btnCancelEdit");

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

  test("11. Tự động cập nhật Extension qua Native Messaging (Hướng dẫn cài 1 lần, git pull & tự reload)", async () => {
    // A. Khi chưa cài Native Messaging Host: bấm 🔄 chuyển sang tab Cài đặt và hiển thị lệnh chuẩn kèm Extension ID
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.click("#btnUpdateExtension");

    await expect(page.locator("#viewSettings")).toHaveClass(/active/);
    await expect(page.locator("#updaterHostStatusBadge")).toContainText("Chưa cài Native Host");
    const expectedCmd = `./scripts/install-updater.sh ${extensionId}`;
    await expect(page.locator("#updaterInstallCmdText")).toHaveText(expectedCmd);

    // Kiểm tra nút Copy lệnh sao chép chính xác lệnh vào Clipboard
    await page.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.id = "e2ePasteUpdaterCmd";
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
    });
    await page.click("#btnCopyUpdaterCmd");
    await expect(page.locator("#btnCopyUpdaterCmd")).toHaveText("✓ Đã copy");
    await page.focus("#e2ePasteUpdaterCmd");
    await page.keyboard.press("Control+V");
    await expect(page.locator("#e2ePasteUpdaterCmd")).toHaveValue(expectedCmd);
    assertCleanConsole();
    await page.close();

    // B. Kiểm thử luồng Native Messaging thật với Git bare repo tạm + Chromium profile cô lập
    const crypto = require("crypto");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gittask-updater-e2e-"));
    const bareRepoDir = path.join(tmpRoot, "remote.git");
    const workRepoDir = path.join(tmpRoot, "work-repo");
    const localRepoDir = path.join(tmpRoot, "local-repo");
    const isolatedUserDataDir = path.join(tmpRoot, "chrome-user-data");
    const isolatedConfigDir = path.join(tmpRoot, "xdg-config");

    let ctx2;
    try {
      const runGit = (cwd, args) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test Bot",
            GIT_AUTHOR_EMAIL: "bot@example.com",
            GIT_COMMITTER_NAME: "Test Bot",
            GIT_COMMITTER_EMAIL: "bot@example.com"
          }
        }).trim();

      fs.mkdirSync(bareRepoDir, { recursive: true });
      runGit(bareRepoDir, ["init", "--bare", "-b", "main"]);

      fs.mkdirSync(workRepoDir, { recursive: true });
      runGit(workRepoDir, ["init", "-b", "main"]);
      fs.cpSync(EXTENSION_PATH, path.join(workRepoDir, "extension"), { recursive: true });
      fs.mkdirSync(path.join(workRepoDir, "scripts"), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, "../scripts/native-updater.py"),
        path.join(workRepoDir, "scripts/native-updater.py")
      );
      fs.chmodSync(path.join(workRepoDir, "scripts/native-updater.py"), 0o755);

      runGit(workRepoDir, ["add", "."]);
      runGit(workRepoDir, ["commit", "-m", "init extension repo"]);
      runGit(workRepoDir, ["remote", "add", "origin", bareRepoDir]);
      runGit(workRepoDir, ["push", "-u", "origin", "main"]);

      runGit(tmpRoot, ["clone", bareRepoDir, localRepoDir]);
      fs.chmodSync(path.join(localRepoDir, "scripts/native-updater.py"), 0o755);

      const localExtDir = path.join(localRepoDir, "extension");
      const beforeCommit = runGit(localRepoDir, ["rev-parse", "--short", "HEAD"]);

      const digest = crypto.createHash("sha256").update(localExtDir, "utf8").digest("hex").slice(0, 32);
      const expectedExtId2 = digest
        .split("")
        .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
        .join("");

      const nativeHostPayload = JSON.stringify(
        {
          name: "com.gittask.updater",
          description: "GitTask Sync Native Git Pull Updater",
          path: path.join(localRepoDir, "scripts/native-updater.py"),
          type: "stdio",
          allowed_origins: [`chrome-extension://${expectedExtId2}/`]
        },
        null,
        2
      );

      for (const hostParent of [
        isolatedUserDataDir,
        path.join(isolatedConfigDir, "chromium"),
        path.join(isolatedConfigDir, "google-chrome")
      ]) {
        const hostsDir = path.join(hostParent, "NativeMessagingHosts");
        fs.mkdirSync(hostsDir, { recursive: true });
        fs.writeFileSync(path.join(hostsDir, "com.gittask.updater.json"), nativeHostPayload, "utf8");
      }

      const launchIsolatedContext = async () => {
        const ctx = await chromium.launchPersistentContext(isolatedUserDataDir, {
          channel: "chromium",
          headless: true,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: isolatedConfigDir
          },
          args: [
            `--disable-extensions-except=${localExtDir}`,
            `--load-extension=${localExtDir}`,
            "--no-first-run",
            "--no-default-browser-check"
          ]
        });
        let [sw] = ctx.serviceWorkers();
        if (!sw) {
          sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
        }
        return { ctx, sw };
      };

      const launched = await launchIsolatedContext();
      ctx2 = launched.ctx;
      const actualExtId2 = new URL(launched.sw.url()).host;
      expect(actualExtId2).toBe(expectedExtId2);

      const page2 = await ctx2.newPage();
      const page2Errors = [];
      page2.on("pageerror", (e) => page2Errors.push(e.message));
      await page2.goto(`chrome-extension://${actualExtId2}/popup.html`);

      // Kiểm tra kết nối Native Host thành công
      await page2.click("#tabBtnSettings");
      await expect(page2.locator("#updaterHostStatusBadge")).toContainText(
        `✓ Đã kết nối (main @ ${beforeCommit})`
      );

      // Tạo commit mới đẩy lên bare repo từ workRepoDir
      fs.writeFileSync(path.join(workRepoDir, "extension/UPDATED_MARKER.txt"), "v1.0.1\n", "utf8");
      runGit(workRepoDir, ["add", "."]);
      runGit(workRepoDir, ["commit", "-m", "feat: new extension update"]);
      runGit(workRepoDir, ["push", "origin", "main"]);
      const afterCommit = runGit(workRepoDir, ["rev-parse", "--short", "HEAD"]);
      expect(afterCommit).not.toBe(beforeCommit);

      // Bấm 🔄 Cập nhật ngay trên Extension -> git pull & gọi chrome.runtime.reload() (tự đóng page2)
      const page2ClosedPromise = page2.waitForEvent("close", { timeout: 10000 });
      await page2.click("#btnUpdateExtension");

      // Xác minh repo cục bộ đã pull lên đúng commit mới và chrome.runtime.reload() đã kích hoạt
      await expect
        .poll(() => runGit(localRepoDir, ["rev-parse", "--short", "HEAD"]), { timeout: 10000 })
        .toBe(afterCommit);
      expect(fs.existsSync(path.join(localRepoDir, "extension/UPDATED_MARKER.txt"))).toBe(true);
      await page2ClosedPromise;

      // Khởi tạo lại persistent context trên cùng userDataDir (giữ nguyên chrome.storage.local) để mô phỏng sau khi nạp lại Extension
      await ctx2.close();
      ctx2 = null;
      const relaunched = await launchIsolatedContext();
      ctx2 = relaunched.ctx;

      const page3 = await ctx2.newPage();
      await page3.goto(`chrome-extension://${actualExtId2}/popup.html`);
      await expect(page3.locator("#statusBanner")).toContainText(
        `Đã cập nhật Extension thành công (${beforeCommit} → ${afterCommit})`
      );

      // Bấm 🔄 lần nữa khi đã ở commit mới nhất -> báo đang ở bản mới nhất
      await page3.click("#btnUpdateExtension");
      await expect(page3.locator("#statusBanner")).toContainText(
        `Extension đang ở bản mới nhất (main @ ${afterCommit})`
      );
      expect(page2Errors).toEqual([]);
    } finally {
      if (ctx2) {
        await ctx2.close();
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("12. Auto-save (Debounce) khi sửa công việc & Auto Pull tự động khi mở Extension", async () => {
    const autoPullPat = "pat_autosave_autopull_123456";
    const { page, assertCleanConsole } = await openExtensionPopupPage(autoPullPat, {
      allowExpectedHttpFailureLogs: true
    });

    // ==================== A. AUTO-SAVE (DEBOUNCE) KHI SỬA CÔNG VIỆC ====================
    // Khi tạo task mới: badge Auto-save ẩn và gõ không tự tạo task
    await page.click("#btnQuickGoAdd");
    await expect(page.locator("#autoSaveStatusBadge")).toBeHidden();
    await page.fill("#taskTitleInput", "Task Ban Đầu Cho Auto-save");
    await page.fill("#taskDescInput", "Mô tả gốc");
    await page.waitForTimeout(550);
    await expect(page.locator("#navTaskCount")).toHaveText("0");
    await page.click("#btnSubmitTask");
    await expect(page.locator("#navTaskCount")).toHaveText("1");

    // Mở sửa task -> badge Auto-save hiện sẵn sàng
    const workSection = page.locator('.group-section[data-group-name="Công việc"]');
    await workSection.locator(".group-header").click();
    await workSection.locator(".task-card .btn-edit-task").click();

    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);
    await expect(page.locator("#autoSaveStatusBadge")).toBeVisible();
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("⚡ Tự động lưu");

    // Gõ tiêu đề & mô tả liên tiếp -> giữ focus, hiện "⏳ Đang lưu...", sau debounce 400ms tự lưu thành "✓ Đã tự động lưu"
    const titleInput = page.locator("#taskTitleInput");
    const descInput = page.locator("#taskDescInput");

    await titleInput.fill("Task Đã Auto-save");
    await titleInput.focus();
    await titleInput.pressSequentially(" Tiêu Đề Mới", { delay: 30 });
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("⏳ Đang lưu...");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe(
      "taskTitleInput"
    );

    await descInput.focus();
    await descInput.fill("Mô tả đã gõ tự động lưu");
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("⏳ Đang lưu...");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe(
      "taskDescInput"
    );

    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("✓ Đã tự động lưu", {
      timeout: 2000
    });
    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");

    // Xác minh chrome.storage.local đã nhận dữ liệu mới ngay cả khi chưa ấn nút Lưu
    const storedAfterDebounce = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["tasks"], (res) => resolve(res.tasks));
      });
    });
    expect(storedAfterDebounce).toHaveLength(1);
    expect(storedAfterDebounce[0].title).toBe("Task Đã Auto-save Tiêu Đề Mới");
    expect(storedAfterDebounce[0].description).toBe("Mô tả đã gõ tự động lưu");

    // Kiểm tra xóa trắng tiêu đề -> cảnh báo và không ghi đè tiêu đề rỗng
    await titleInput.fill("   ");
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText(
      "⚠️ Tên công việc không được trống"
    );
    await page.waitForTimeout(500);
    const storedAfterEmptyTitle = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["tasks"], (res) => resolve(res.tasks));
      });
    });
    expect(storedAfterEmptyTitle[0].title).toBe("Task Đã Auto-save Tiêu Đề Mới");

    // Gõ sửa tiêu đề mới rồi lập tức bấm "← Quay lại Danh sách" trước khi hết debounce -> flush lưu ngay
    await titleInput.fill("Task Flush Khi Quay Lại");
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("⏳ Đang lưu...");
    await page.click("#btnCancelEdit");
    await expect(page.locator("#viewTasks")).toHaveClass(/active/);
    await expect(workSection.locator(".task-card .task-title")).toHaveText(
      "Task Flush Khi Quay Lại"
    );

    // Gõ sửa mô tả rồi lập tức bấm chuyển tab #tabBtnTasks trước khi hết debounce -> flush lưu ngay
    await workSection.locator(".task-card .btn-edit-task").click();
    await descInput.fill("Mô tả được flush khi chuyển tab");
    await expect(page.locator("#autoSaveStatusBadge")).toHaveText("⏳ Đang lưu...");
    await page.click("#tabBtnTasks");
    await expect(page.locator("#viewTasks")).toHaveClass(/active/);
    await workSection.locator(".task-card .btn-toggle-desc").click();
    await expect(workSection.locator(".task-card .task-desc-text")).toHaveText(
      "Mô tả được flush khi chuyển tab"
    );

    // ==================== B. AUTO PULL KHI MỞ EXTENSION ====================
    let remotePullCount = 0;
    let remoteSha = "";
    let remoteTasks = [];

    await context.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (
        url.pathname === "/repos/auto-pull-org/auto-pull-repo/contents/tasks.json" &&
        req.method() === "GET"
      ) {
        remotePullCount += 1;
        if (!remoteSha) {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ message: "Not Found" })
          });
          return;
        }
        const jsonStr = JSON.stringify(remoteTasks, null, 2);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            name: "tasks.json",
            path: "tasks.json",
            size: Buffer.byteLength(jsonStr, "utf8"),
            sha: remoteSha,
            encoding: "base64",
            content: encodeGitHubMimeBase64(jsonStr)
          })
        });
        return;
      }
      if (
        url.pathname === "/repos/auto-pull-org/auto-pull-repo/contents/tasks.json" &&
        req.method() === "PUT"
      ) {
        const body = JSON.parse(req.postData() || "{}");
        remoteTasks = JSON.parse(decodeUtf8Base64(body.content));
        remoteSha = "bbbb2222cccc3333dddd4444eeee5555ffff6666";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ content: { sha: remoteSha } })
        });
        return;
      }
      await route.fulfill({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
    });

    // Lưu cấu hình GitHub (mặc định "Bật Auto Pull khi mở" đang bật và chu kỳ mặc định là 5 phút)
    await page.click("#tabBtnSettings");
    await expect(page.locator("#autoPullEnabledInput")).toBeChecked();
    await expect(page.locator("#autoPullIntervalValue")).toHaveValue("5");
    await expect(page.locator("#autoPullIntervalUnit")).toHaveValue("m");
    await page.fill("#ghOwnerInput", "auto-pull-org");
    await page.fill("#ghRepoInput", "auto-pull-repo");
    await page.fill("#ghBranchInput", "main");
    await page.fill("#ghFilePathInput", "tasks.json");
    await page.fill("#ghTokenInput", autoPullPat);
    await page.click("#btnSaveGitHubConfig");

    // Bấm Push để đưa cây cục bộ về trạng thái sạch (dirty: false) & ghi nhận mốc vừa đồng bộ
    await page.click("#btnPushGitHub");
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch (Đã commit)");

    // Giả lập thiết bị khác cập nhật thêm task mới lên GitHub
    remoteSha = "cccc3333dddd4444eeee5555ffff666677778888";
    remoteTasks = [
      ...remoteTasks,
      {
        id: "remote-new-2",
        title: "Task Mới Tự Động Pull Khi Mở",
        description: "Được tải tự động ngay khi mở Extension",
        group: "Dự án GitHub",
        priority: "high",
        status: "todo",
        updatedAt: "2026-11-18T03:00:00.000Z"
      }
    ];

    // Vừa đồng bộ chưa quá 5 phút -> mở lại ngay KHÔNG gọi Auto Pull để tránh lag
    const pullsBeforeFreshReload = remotePullCount;
    await page.reload();
    await page.waitForTimeout(300);
    expect(remotePullCount).toBe(pullsBeforeFreshReload);
    await expect(page.locator("#navTaskCount")).toHaveText("1");

    // Giả lập lần đồng bộ / pull cuối cùng đã quá 5 phút (lùi về 10 phút trước) -> mở lại phải TỰ ĐỘNG Pull
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["syncMeta"], (res) => {
          const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const nextMeta = Object.assign({}, res.syncMeta || {}, {
            lastSyncAt: tenMinAgoIso,
            lastPullAt: tenMinAgoIso
          });
          chrome.storage.local.set({ syncMeta: nextMeta }, resolve);
        });
      });
    });

    const pullsBeforeStaleReload = remotePullCount;
    await page.reload();
    await expect.poll(() => remotePullCount, { timeout: 5000 }).toBeGreaterThan(pullsBeforeStaleReload);
    await expect(page.locator("#statusBanner")).toContainText("Auto Pull thành công");
    await expect(page.locator("#headerShaBadge")).toContainText("base_sha: cccc333");
    await expect(page.locator("#navTaskCount")).toHaveText("2");

    // Ngay sau khi Auto Pull vừa chạy xong -> mốc lastPullAt đã cập nhật mới -> reload lại KHÔNG gọi Auto Pull nữa
    const pullsRightAfterAutoPull = remotePullCount;
    await page.reload();
    await page.waitForTimeout(300);
    expect(remotePullCount).toBe(pullsRightAfterAutoPull);

    await page.locator('.group-section[data-group-name="Dự án GitHub"] .group-header').click();
    await expect(
      page.locator(".task-card", { hasText: "Task Mới Tự Động Pull Khi Mở" })
    ).toBeVisible();

    // Bảo vệ dữ liệu cục bộ: Khi cây đang dirty (chưa Push) -> kể cả quá hạn X phút mở lại vẫn KHÔNG Auto Pull ghi đè
    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Local Chưa Push");
    await page.click("#btnSubmitTask");
    await expect(page.locator("#treeStatusBadge")).toContainText("Chưa sạch");
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["syncMeta"], (res) => {
          const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const nextMeta = Object.assign({}, res.syncMeta || {}, {
            lastSyncAt: tenMinAgoIso,
            lastPullAt: tenMinAgoIso
          });
          chrome.storage.local.set({ syncMeta: nextMeta }, resolve);
        });
      });
    });

    const pullsBeforeDirtyReload = remotePullCount;
    await page.reload();
    await page.waitForTimeout(300);
    expect(remotePullCount).toBe(pullsBeforeDirtyReload);
    await expect(page.locator("#navTaskCount")).toHaveText("3");

    // Push xong về sạch -> Tắt công tắc Auto Pull -> quá hạn vẫn KHÔNG tự động Pull
    await page.click("#btnPushGitHub");
    await expect(page.locator("#treeStatusBadge")).toHaveText("✓ Cây sạch (Đã commit)");

    await page.click("#tabBtnSettings");
    await page.uncheck("#autoPullEnabledInput");
    await expect(page.locator("#autoPullEnabledInput")).not.toBeChecked();

    remoteSha = "dddd4444eeee5555ffff66667777888899990000";
    remoteTasks.push({
      id: "remote-ignored-when-off",
      title: "Task Không Tự Pull Khi Tắt",
      description: "",
      group: "Công việc",
      priority: "low",
      status: "todo",
      updatedAt: "2026-11-18T04:00:00.000Z"
    });
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["syncMeta"], (res) => {
          const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const nextMeta = Object.assign({}, res.syncMeta || {}, {
            lastSyncAt: tenMinAgoIso,
            lastPullAt: tenMinAgoIso
          });
          chrome.storage.local.set({ syncMeta: nextMeta }, resolve);
        });
      });
    });

    const pullsBeforeDisabledReload = remotePullCount;
    await page.reload();
    await page.waitForTimeout(300);
    expect(remotePullCount).toBe(pullsBeforeDisabledReload);
    await expect(page.locator("#navTaskCount")).toHaveText("3");

    assertCleanConsole();
  });

  test("13. Upload đa dạng loại file (PDF, TXT, JSON, ZIP + Ảnh), chặn SVG/HTML XSS, giới hạn 2.5MB & tải xuống", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();

    await page.click("#btnQuickGoAdd");
    await page.fill("#taskTitleInput", "Task Đính Kèm Đa Dạng File");

    // 1. Kiểm tra input không còn khóa accept chỉ mỗi ảnh
    const acceptAttr = await page.locator("#taskImageInput").getAttribute("accept");
    expect(acceptAttr).toBeNull();

    // 2. Chặn SVG và HTML vì lý do bảo mật XSS
    await page.setInputFiles("#taskImageInput", [
      { name: "evil.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg onload=alert(1)></svg>") }
    ]);
    await expect(page.locator("#statusBanner")).toContainText("SVG/HTML");
    await expect(page.locator("#imageCountLabel")).toContainText("0/6 tệp đính kèm");

    // 3. Chặn file vượt quá 2.5 MB
    const oversizedBuf = Buffer.alloc(2.6 * 1024 * 1024, 65);
    await page.setInputFiles("#taskImageInput", [
      { name: "too-big.bin", mimeType: "application/octet-stream", buffer: oversizedBuf }
    ]);
    await expect(page.locator("#statusBanner")).toContainText("2.5 MB");
    await expect(page.locator("#imageCountLabel")).toContainText("0/6 tệp đính kèm");

    // 4. Tạo 1 ảnh PNG + 3 file khác (PDF, TXT, JSON)
    const pngBytes = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 40;
      c.height = 40;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(0, 0, 40, 40);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    await page.setInputFiles("#taskImageInput", [
      { name: "preview.png", mimeType: "image/png", buffer: Buffer.from(pngBytes) },
      { name: "spec.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%test\n") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Ghi chu tieng Viet") },
      { name: "config.json", mimeType: "application/json", buffer: Buffer.from('{"ok":true}') }
    ]);

    await expect(page.locator("#imageCountLabel")).toContainText("4/6 tệp đính kèm");
    await expect(page.locator("#formImagePreviewList .image-preview-item")).toHaveCount(1);
    await expect(page.locator("#formImagePreviewList .file-preview-item")).toHaveCount(3);

    // Gỡ 1 file (config.json) trước khi lưu
    await page.locator("#formImagePreviewList .file-preview-item").last().locator(".image-remove-btn").click();
    await expect(page.locator("#imageCountLabel")).toContainText("3/6 tệp đính kèm");
    await expect(page.locator("#formImagePreviewList .file-preview-item")).toHaveCount(2);

    await page.click("#btnSubmitTask");

    // 5. Mở nhóm mặc định & kiểm tra thẻ công việc hiển thị cả ảnh lẫn file đính kèm
    await page.locator('.group-section[data-group-name="Công việc"] .group-header').click();
    const card = page.locator(".task-card", { hasText: "Task Đính Kèm Đa Dạng File" });
    await expect(card.locator(".badge-img")).toContainText("1 ảnh");
    await expect(card.locator(".badge-file")).toContainText("2 tệp");
    await expect(card.locator(".task-img-thumb")).toHaveCount(1);
    await expect(card.locator(".task-attachment-chip")).toHaveCount(2);
    await expect(card.locator(".task-attachment-chip").nth(0)).toContainText("spec.pdf");
    await expect(card.locator(".task-attachment-chip").nth(1)).toContainText("notes.txt");

    // 6. Kiểm tra tải xuống file đính kèm khi bấm vào chip
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card.locator(".task-attachment-chip", { hasText: "notes.txt" }).click()
    ]);
    expect(download.suggestedFilename()).toBe("notes.txt");
    const dlPath = await download.path();
    expect(fs.readFileSync(dlPath, "utf8")).toBe("Ghi chu tieng Viet");

    // 7. Reload trang kiểm tra lưu trữ bền vững trong chrome.storage.local
    await page.reload();
    await page.locator('.group-section[data-group-name="Công việc"] .group-header').click();
    const reloadedCard = page.locator(".task-card", { hasText: "Task Đính Kèm Đa Dạng File" });
    await expect(reloadedCard.locator(".task-attachment-chip")).toHaveCount(2);

    assertCleanConsole();
  });

  test("14. Bố cục dạng lưới (Grid) hiển thị nhiều task & giữ nguyên vị trí cuộn khi tích, sửa, xóa, đóng mở mô tả", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.setViewportSize({ width: 780, height: 600 });

    const seededTasks = Array.from({ length: 20 }, (_, i) => ({
      id: `grid-task-${i + 1}`,
      title: `Công việc Grid #${String(i + 1).padStart(2, "0")}`,
      description: i % 2 === 0 ? `Mô tả chi tiết cho task ${i + 1}` : "",
      group: "Công việc",
      priority: i < 4 ? "high" : i < 10 ? "medium" : i < 16 ? "low" : "none",
      status: "todo",
      updatedAt: new Date(Date.now() - i * 1000).toISOString()
    }));
    seededTasks.push(
      {
        id: "grid-sub-1",
        title: "Subfolder Task 1",
        description: "",
        group: "Công việc/Con",
        priority: "medium",
        status: "todo",
        updatedAt: new Date().toISOString()
      },
      {
        id: "grid-sub-2",
        title: "Subfolder Task 2",
        description: "",
        group: "Công việc/Con",
        priority: "low",
        status: "todo",
        updatedAt: new Date().toISOString()
      }
    );

    await page.evaluate((tasks) => {
      return new Promise((resolve) => {
        chrome.storage.local.set(
          {
            tasks,
            groups: ["Công việc", "Công việc/Con", "Dự án GitHub", "Cá nhân", "Khẩn cấp"]
          },
          resolve
        );
      });
    }, seededTasks);

    await page.reload();
    const workSection = page.locator('.group-section[data-group-name="Công việc"]');
    await workSection.locator("> .group-header").click();

    const gridEl = workSection.locator("> .group-section-body > .task-cards-grid");
    await expect(gridEl).toBeVisible();
    const gridDisplay = await gridEl.evaluate((el) => window.getComputedStyle(el).display);
    expect(gridDisplay).toBe("grid");

    // 1. Ở popup mặc định 780x600 -> hiển thị 2 cột trong lưới, thư mục con nằm full width bên dưới
    const popupColsInfo = await workSection.evaluate((sec) => {
      const cards = Array.from(
        sec.querySelectorAll(":scope > .group-section-body > .task-cards-grid > .task-card")
      );
      const firstRowTop = cards[0].getBoundingClientRect().top;
      const firstRowCards = cards.filter(
        (c) => Math.abs(c.getBoundingClientRect().top - firstRowTop) <= 2
      );
      const gridRect = sec
        .querySelector(":scope > .group-section-body > .task-cards-grid")
        .getBoundingClientRect();
      const subSectionRect = sec
        .querySelector('.group-section-nested[data-group-name="Công việc/Con"]')
        .getBoundingClientRect();
      return {
        firstRowCount: firstRowCards.length,
        subStartsBelowGrid: subSectionRect.top >= gridRect.bottom - 2,
        subWidthMatchesGrid: Math.abs(subSectionRect.width - gridRect.width) <= 4
      };
    });
    expect(popupColsInfo.firstRowCount).toBe(2);
    expect(popupColsInfo.subStartsBelowGrid).toBe(true);
    expect(popupColsInfo.subWidthMatchesGrid).toBe(true);

    // 2. Cuộn xuống giữa/cuối danh sách -> đóng/mở mô tả, tích hoàn thành, xóa, sửa & quay lại không bị nhảy lên đầu
    await page.locator("main.ext-body").evaluate((el) => {
      el.scrollTop = 300;
    });
    const initialScrollTop = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(initialScrollTop).toBeGreaterThanOrEqual(240);

    // Đóng/mở mô tả ở task phía dưới
    const card15 = page.locator('.task-card[data-task-id="grid-task-15"]');
    await card15.locator(".btn-toggle-desc").click();
    await expect(card15.locator(".task-desc-box")).toBeVisible();
    const scrollAfterDescToggle = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(scrollAfterDescToggle).toBeGreaterThanOrEqual(200);

    // Tích hoàn thành ở task phía dưới
    const card16 = page.locator('.task-card[data-task-id="grid-task-16"]');
    await card16.locator(".task-checkbox").click();
    await expect(page.locator("#countDoneBadge")).toHaveText("1");
    const scrollAfterTick = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(scrollAfterTick).toBeGreaterThanOrEqual(200);

    // Xóa task phía dưới
    const card18 = page.locator('.task-card[data-task-id="grid-task-18"]');
    await card18.locator(".btn-delete-task").click();
    await expect(page.locator("#navTaskCount")).toHaveText("21");
    const scrollAfterDelete = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(scrollAfterDelete).toBeGreaterThanOrEqual(200);

    // Sửa task phía dưới -> Lưu cập nhật -> quay lại màn Công việc giữ nguyên vị trí cuộn
    const card17 = page.locator('.task-card[data-task-id="grid-task-17"]');
    await card17.locator(".btn-edit-task").click();
    await expect(page.locator("#viewAddTask")).toHaveClass(/active/);
    await page.fill("#taskTitleInput", "Công việc Grid #17 Đã Cập Nhật");
    await page.click("#btnSubmitTask");
    await expect(page.locator("#viewTasks")).toHaveClass(/active/);
    await expect(page.locator(".task-card", { hasText: "Công việc Grid #17 Đã Cập Nhật" })).toBeVisible();
    const scrollAfterEditSave = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(scrollAfterEditSave).toBeGreaterThanOrEqual(200);

    // Mở Sửa -> bấm Quay lại (Cancel) -> giữ nguyên vị trí cuộn
    await page
      .locator(".task-card", { hasText: "Công việc Grid #17 Đã Cập Nhật" })
      .locator(".btn-edit-task")
      .click();
    await page.click("#btnCancelEdit");
    await expect(page.locator("#viewTasks")).toHaveClass(/active/);
    const scrollAfterCancel = await page.locator("main.ext-body").evaluate((el) => el.scrollTop);
    expect(scrollAfterCancel).toBeGreaterThanOrEqual(200);

    // 3. Kiểm tra số cột tăng lên ở Floating Window (960x640 -> 3 cột) & Full Tab (1280x720 -> 4 cột)
    const winPage = await context.newPage();
    await winPage.setViewportSize({ width: 960, height: 640 });
    await winPage.goto(`chrome-extension://${extensionId}/popup.html?mode=window`);
    const winWorkSection = winPage.locator('.group-section[data-group-name="Công việc"]');
    await winWorkSection.locator("> .group-header").click();
    const winFirstRowCols = await winWorkSection.evaluate((sec) => {
      const cards = Array.from(
        sec.querySelectorAll(":scope > .group-section-body > .task-cards-grid > .task-card")
      );
      const top = cards[0].getBoundingClientRect().top;
      return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) <= 2).length;
    });
    expect(winFirstRowCols).toBe(3);
    await winPage.close();

    const tabPage = await context.newPage();
    await tabPage.setViewportSize({ width: 1280, height: 720 });
    await tabPage.goto(`chrome-extension://${extensionId}/popup.html?mode=tab`);
    const tabWorkSection = tabPage.locator('.group-section[data-group-name="Công việc"]');
    await tabWorkSection.locator("> .group-header").click();
    const tabFirstRowCols = await tabWorkSection.evaluate((sec) => {
      const cards = Array.from(
        sec.querySelectorAll(":scope > .group-section-body > .task-cards-grid > .task-card")
      );
      const top = cards[0].getBoundingClientRect().top;
      return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) <= 2).length;
    });
    expect(tabFirstRowCols).toBe(4);
    await tabPage.close();

    assertCleanConsole();
  });

  test("15. Nút gom nhóm theo Folder và theo Flag (4 chế độ kết hợp, đóng/mở Flag & lưu bền vững)", async () => {
    const { page, assertCleanConsole } = await openExtensionPopupPage();
    await page.setViewportSize({ width: 780, height: 600 });

    const seededTasks = [
      {
        id: "gf-1",
        title: "Work High Task",
        description: "",
        group: "Công việc",
        priority: "high",
        status: "todo",
        updatedAt: "2026-11-25T09:00:00.000Z"
      },
      {
        id: "gf-2",
        title: "Work Medium Task",
        description: "",
        group: "Công việc",
        priority: "medium",
        status: "todo",
        updatedAt: "2026-11-25T08:50:00.000Z"
      },
      {
        id: "gf-3",
        title: "Work Low Task",
        description: "",
        group: "Công việc",
        priority: "low",
        status: "todo",
        updatedAt: "2026-11-25T08:40:00.000Z"
      },
      {
        id: "gf-4",
        title: "Work None Task",
        description: "",
        group: "Công việc",
        priority: "none",
        status: "todo",
        updatedAt: "2026-11-25T08:30:00.000Z"
      },
      {
        id: "gf-5",
        title: "GitHub High Task",
        description: "",
        group: "Dự án GitHub",
        priority: "high",
        status: "todo",
        updatedAt: "2026-11-25T08:20:00.000Z"
      },
      {
        id: "gf-6",
        title: "Personal Low Task",
        description: "",
        group: "Cá nhân",
        priority: "low",
        status: "todo",
        updatedAt: "2026-11-25T08:10:00.000Z"
      }
    ];

    await page.evaluate((tasks) => {
      return new Promise((resolve) => {
        chrome.storage.local.set({ tasks }, resolve);
      });
    }, seededTasks);
    await page.reload();

    const btnFolder = page.locator("#btnGroupByFolder");
    const btnFlag = page.locator("#btnGroupByFlag");

    // Mặc định: Folder BẬT, Flag TẮT
    await expect(btnFolder).toHaveClass(/active/);
    await expect(btnFolder).toHaveAttribute("aria-pressed", "true");
    await expect(btnFlag).not.toHaveClass(/active/);
    await expect(btnFlag).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".group-section")).toHaveCount(4);
    await expect(page.locator(".priority-section")).toHaveCount(0);

    // 1) Chế độ Folder + Flag: Bật thêm Flag
    await btnFlag.click();
    await expect(btnFlag).toHaveClass(/active/);
    await expect(btnFlag).toHaveAttribute("aria-pressed", "true");

    const workSection = page.locator('.group-section[data-group-name="Công việc"]');
    await workSection.locator("> .group-header").click();

    const nestedPrios = await workSection
      .locator(".priority-section")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-priority-group")));
    expect(nestedPrios).toEqual(["high", "medium", "low", "none"]);

    const nestedGridDisplay = await workSection
      .locator('.priority-section[data-priority-group="high"] .task-cards-grid')
      .evaluate((el) => window.getComputedStyle(el).display);
    expect(nestedGridDisplay).toBe("grid");

    // Đóng / mở nhóm Flag bên trong Folder
    const workHighPrio = workSection.locator('.priority-section[data-priority-group="high"]');
    await workHighPrio.locator(".priority-header").click();
    await expect(workHighPrio.locator(".priority-header")).toHaveAttribute("aria-expanded", "false");
    await expect(workHighPrio.locator(".priority-section-body")).toBeHidden();
    await workHighPrio.locator(".priority-header").click();
    await expect(workHighPrio.locator(".priority-header")).toHaveAttribute("aria-expanded", "true");
    await expect(workHighPrio.locator(".priority-section-body")).toBeVisible();

    // 2) Chế độ chỉ Flag: Tắt Folder (Flag vẫn BẬT)
    await btnFolder.click();
    await expect(btnFolder).not.toHaveClass(/active/);
    await expect(btnFolder).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".group-section")).toHaveCount(0);

    const topLevelPrios = await page
      .locator("#taskListContainer > .priority-section")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-priority-group")));
    expect(topLevelPrios).toEqual(["high", "medium", "low", "none"]);

    const highGroupTitles = await page
      .locator('.priority-section[data-priority-group="high"] .task-cards-grid .task-title')
      .allTextContents();
    expect(highGroupTitles).toEqual(["Work High Task", "GitHub High Task"]);

    // Reload giữ nguyên chế độ gom nhóm đã chọn
    await page.reload();
    await expect(btnFolder).not.toHaveClass(/active/);
    await expect(btnFlag).toHaveClass(/active/);
    await expect(page.locator(".group-section")).toHaveCount(0);
    await expect(page.locator("#taskListContainer > .priority-section")).toHaveCount(4);

    // 3) Chế độ Lưới phẳng (tắt cả Folder & Flag)
    await btnFlag.click();
    await expect(btnFlag).not.toHaveClass(/active/);
    await expect(page.locator(".group-section")).toHaveCount(0);
    await expect(page.locator(".priority-section")).toHaveCount(0);

    const flatTitles = await page
      .locator("#taskListContainer > .task-cards-grid > .task-card .task-title")
      .allTextContents();
    expect(flatTitles).toEqual([
      "Work High Task",
      "GitHub High Task",
      "Work Medium Task",
      "Work Low Task",
      "Personal Low Task",
      "Work None Task"
    ]);

    // 4) Bật lại Folder -> trở về chế độ mặc định theo Folder
    await btnFolder.click();
    await expect(btnFolder).toHaveClass(/active/);
    await expect(page.locator(".group-section")).toHaveCount(4);
    await expect(page.locator(".priority-section")).toHaveCount(0);

    assertCleanConsole();
  });
});

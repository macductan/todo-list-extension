# GitTask Sync — Chrome Extension (Manifest V3)

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/macductan/todo-list-extension)
[![Manifest](https://img.shields.io/badge/Manifest-V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Playwright Tests](https://img.shields.io/badge/playwright-11%2F11%20passed-brightgreen.svg)](tests/)
[![Vanilla JS](https://img.shields.io/badge/built%20with-100%25%20Vanilla%20JS-F7DF1E.svg)](extension/)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

Chrome Extension quản lý công việc cá nhân (To-Do) siêu nhẹ, được xây dựng bằng **100% Vanilla HTML, CSS, JavaScript (ES6+)** — hoàn toàn không dùng framework, không thư viện UI ngoài, không cần bundler (Webpack/Vite) — và đồng bộ dữ liệu hai chiều theo **cây thư mục thực tế** trực tiếp qua **GitHub REST API (Git Trees API, Contents API & Git Blobs API)**.

---

## 🌟 Điểm nổi bật & Tính năng chính

### 1. 📋 Quản lý Task toàn diện (CRUD)
- Lưu trữ chuẩn cấu trúc: `id`, `title`, `description`, `group`, `priority`, `status`, `updatedAt`, cùng tùy chọn đính kèm ảnh chụp màn hình nén nhẹ.
- **Rút gọn mô tả thông minh & Copy nhanh kèm ảnh**: Mặc định ẩn mô tả trong danh sách; khi mở tự động giới hạn 2 dòng kèm nút `Xem thêm ▾` / `Thu gọn ▴`. Nút `📋 Copy` trên thẻ công việc cho phép sao chép tức thì cả văn bản mô tả (`text/plain`, `text/html` an toàn XSS) lẫn hình ảnh đính kèm (`image/png`) vào Clipboard mà không cần mở mô tả trước.
- **Thông báo Toast tự động ẩn**: Hiển thị thông báo nổi gọn nhẹ kèm thanh đếm ngược tự ẩn, tự động tạm dừng khi rê chuột vào đọc.
- **2 Tab trạng thái tinh gọn (`⏳ Chưa làm` / `✅ Đã xong`) & Dọn dẹp theo ngày**: Chuyển đổi trạng thái nhanh giữa `Chưa làm` ↔ `Đã xong`. Ở tab `✅ Đã xong`, có thanh chọn mốc ngày (mặc định lùi 30 ngày so với hôm nay) kèm nút `🗑️ Xóa task quá 30 ngày` (hoặc xóa từ ngày đã chọn trở về trước) để dọn dẹp nhanh các công việc cũ.
- Tìm kiếm theo từ khóa theo thời gian thực trên cả Tiêu đề, Mô tả và Nhóm của task.

### 2. 🚩 4 Mức Cờ Ưu Tiên
- 4 cấp độ ưu tiên với màu sắc nhận diện trực quan trên từng thẻ công việc (và tự động sắp xếp thứ tự ưu tiên từ cao xuống thấp bên trong từng Folder):
  - 🔴 **High** (Ưu tiên Cao)
  - 🟡 **Medium** (Ưu tiên Trung bình)
  - 🔵 **Low** (Ưu tiên Thấp)
  - ⚪ **None** (Không ưu tiên)

### 3. 🗂️ Cây Thư Mục Đa Cấp (`Cha / Con / Cháu`) & Thao tác nhanh trên Folder
- Hỗ trợ tổ chức công việc theo **cây thư mục nhiều tầng** (ví dụ: `Công việc` ➔ `Công việc/Dự án A` ➔ `Công việc/Dự án A/Sprint 1`).
- Danh sách công việc hiển thị trực quan cấu trúc thư mục lồng nhau (`nested group section`), **mặc định thu gọn** toàn bộ Folder để giao diện gọn gàng và chỉ hiển thị số lượng công việc (`X công việc`).
- Ở tab `⏳ Chưa làm`, hiển thị đầy đủ tất cả Folder (kể cả Folder đang trống) kèm nút `➕ Thêm` ngay trên thanh tiêu đề của từng Folder để mở form tạo công việc chọn sẵn đúng Folder đó.
- Tab `🗂️ Quản lý Nhóm` chuyên biệt:
  - Tạo thư mục gốc hoặc thư mục con thông qua ô chọn **Thư mục cha**, nhập đường dẫn phân cách bởi `/`, hoặc bấm nút `➕ Nhóm con` ngay trên từng dòng thư mục.
  - Đổi tên thư mục cha tự động cập nhật dây chuyền (`cascade`) sang toàn bộ thư mục con/cháu và các công việc bên trong.
  - Sắp xếp thứ tự hiển thị anh em cùng cấp bằng nút `↑` / `↓`.
  - Xóa nhánh thư mục an toàn: bắt buộc chọn chuyển công việc sang thư mục khác trước khi xóa, và mọi thao tác thêm/sửa/xóa/sắp xếp thư mục đều đánh dấu trạng thái **Chưa sạch (`Dirty`)** để đồng bộ lên Git.

### 4. 🪟 Cửa sổ nổi độc lập mặc định (Floating Window) & Popup gắn thanh công cụ
- **Cửa sổ nổi (Floating Window — Mặc định)**: Khi bấm icon Extension trên thanh công cụ, tự động mở hoặc bật lại cửa sổ nổi độc lập qua `chrome.windows.create` (`type: "popup"`), thoải mái kéo thả, ghim cạnh màn hình làm việc, không phụ thuộc vào tab trình duyệt đang mở.
- **Popup gắn thanh công cụ**: Hỗ trợ chuyển đổi lại chế độ Popup (`780×600`) trong tab Cài đặt nếu muốn.

### 5. 🔄 Auto Push 2 Bộ đếm & Trạng thái Cây dữ liệu (`Clean` / `Dirty`)
- Hiển thị trực quan trạng thái trên thanh tiêu đề:
  - `✓ Cây sạch` / `✓ Cây sạch (Đã commit)`
  - `● Chưa sạch (Cần commit)` kèm đồng hồ đếm ngược Auto Push.
- **Cơ chế 2 bộ đếm an toàn (Dual-timer debounce)**:
  - **Idle Delay**: Đếm ngược sau thay đổi cuối cùng (mặc định `10s`).
  - **Max Delay**: Giới hạn tối đa tính từ thay đổi đầu tiên (mặc định `5 phút`), đảm bảo thay đổi liên tục vẫn được đẩy lên GitHub định kỳ.
  - Tự động tạm dừng nếu phát hiện xung đột từ xa.

### 6. 🐙 Đồng bộ Cây Thư Mục qua GitHub Git Trees API & Chống ghi đè xung đột
- **Tổ chức cây thư mục thật trên GitHub Repository**:
  - Mỗi nhóm/thư mục được đồng bộ thành một đường dẫn thư mục riêng chứa file `tasks.json` (ví dụ: `<baseDir>/Công việc/tasks.json`, `<baseDir>/Công việc/Dự án A/Sprint 1/tasks.json`) thông qua **Git Trees API** (`/git/refs/heads/{branch}`, `/git/trees`, `/git/commits`, `/git/blobs`), kèm theo file manifest lưu thứ tự cây thư mục (bao gồm cả thư mục rỗng) và tự động xóa các thư mục cũ (`sha: null`) khi đổi tên hoặc xóa nhóm.
  - Tự động tương thích ngược (fallback) về `/contents/{path}` khi cần thiết.
- Lưu trữ `base_sha` của commit gần nhất tại `chrome.storage.local`.
- Tự động kiểm tra xung đột trước khi đẩy:
  - Nếu `sha` trên GitHub khác `base_sha` hoặc API trả về mã `409 Conflict` / `422 Unprocessable`: lập tức cảnh báo đỏ, không ghi đè dữ liệu.
  - Cung cấp tùy chọn minh bạch: Mở file trên GitHub, Xem lịch sử Commit, **Force Pull** (nhận bản từ xa) hoặc **Force Push** (ghi đè bản cục bộ).
- Hỗ trợ xử lý file lớn (> 1MB) tự động thông qua **Git Blobs API** (`/git/blobs`).

### 7. 🔄 Tự động cập nhật Extension ngay trên giao diện (`git pull` + Reload)
- Nút **`🔄`** ngay trên thanh tiêu đề cho phép chạy `git pull --ff-only` trực tiếp tại thư mục repo trên máy thông qua **Chrome Native Messaging** (`scripts/native-updater.py`) và tự động gọi `chrome.runtime.reload()` để nạp lại bản mới mà không cần mở terminal hay vào `chrome://extensions`.
- Cài đặt 1 lần duy nhất bằng `./scripts/install-updater.sh` (hỗ trợ gỡ bỏ với `--uninstall`).

### 8. 🛡️ Bảo mật chuẩn Manifest V3 & Chống XSS
- **Tối thiểu hóa quyền**: Chỉ yêu cầu `permissions: ["storage", "nativeMessaging"]` và `host_permissions: ["https://api.github.com/*"]`. Không chèn `content_scripts`, không theo dõi lịch sử duyệt web.
- **Bảo mật Token**: GitHub Personal Access Token lưu trong `chrome.storage.local`, trường nhập mật khẩu ẩn ký tự (`type="password"`), tự động che mờ (`redact`) trong logs/thông báo lỗi.
- **Chống tấn công XSS**: Render toàn bộ văn bản qua `textContent`, kiểm tra nghiêm ngặt định dạng MIME ảnh đính kèm (chỉ nhận PNG, JPG, WEBP, GIF; chặn SVG chứa mã thực thi), chặn đường dẫn Directory Traversal (`..`).
- **Giao diện đa phong cách**: Chuyển đổi Dark Mode / Light Mode mượt mà.

---

## 📁 Cấu trúc thư mục dự án

```text
todo-list-extension/
├── .gitignore              # Bỏ qua node_modules, log, kết quả kiểm thử
├── README.md               # Tài liệu hướng dẫn sử dụng và đặc tả kỹ thuật
├── scripts/                # Native Messaging Host tự động git pull & cài đặt
│   ├── native-updater.py   # Host Python 3 thực thi ping & git pull --ff-only
│   └── install-updater.sh  # Script đăng ký Native Messaging Host với trình duyệt
├── extension/              # Mã nguồn Chrome Extension (Cài đặt Load Unpacked)
│   ├── manifest.json       # Khai báo quyền hạn và metadata chuẩn Manifest V3
│   ├── background.js       # Service worker khởi tạo, Floating Window & Native Updater
│   ├── popup.html          # Giao diện HTML semantic chính
│   ├── styles.css          # Hệ thống CSS biến (Dark/Light), Flexbox & Grid
│   ├── app.js              # Toàn bộ logic CRUD, GitHub API, Auto Push & UI
│   └── icons/              # Bộ icon tiêu chuẩn
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── tests/                  # Bộ kiểm thử E2E tự động bằng Playwright
    ├── package.json        # Cấu hình dependency Playwright
    ├── playwright.config.js# Cấu hình nạp Extension vào Chromium Headless
    └── extension.e2e.spec.js # 11 kịch bản kiểm thử E2E bao phủ toàn diện
```

---

## 🚀 Hướng dẫn cài đặt Extension trên Google Chrome / Chromium

1. Tải hoặc clone mã nguồn repository về máy:
   ```bash
   git clone git@github.com:macductan/todo-list-extension.git
   cd todo-list-extension
   ```
2. Mở trình duyệt Google Chrome (hoặc Edge, Brave, Chromium) và truy cập đường dẫn:
   ```text
   chrome://extensions
   ```
3. Bật công tắc **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên cùng bên phải.
4. Nhấn nút **Tải tiện ích đã giải nén (Load unpacked)** ở góc trên bên trái.
5. Chọn thư mục `extension/` trong dự án `todo-list-extension`.
6. Biểu tượng **GitTask Sync** sẽ xuất hiện trên thanh công cụ trình duyệt!
7. *(Tùy chọn — Bật nút `🔄` cập nhật 1 click)* Chạy lệnh sau **1 lần duy nhất** tại thư mục gốc của repo để đăng ký Native Messaging Host (sau này chỉ cần bấm `🔄` trên Extension là tự `git pull` & reload):
   ```bash
   ./scripts/install-updater.sh
   ```
   *(Nếu cần truyền kèm ID riêng của Extension, bạn có thể copy trực tiếp lệnh có sẵn ID trong tab **⚙️ GitHub & Bảo mật** ➔ mục **🔄 Cập nhật mã nguồn Extension**).*

---

## ⚙️ Hướng dẫn cấu hình kết nối GitHub

Để đồng bộ dữ liệu công việc lên GitHub cá nhân của bạn:

1. **Tạo GitHub Personal Access Token (PAT):**
   - Vào GitHub: **Settings** ➔ **Developer Settings** ➔ **Personal access tokens** (chọn *Tokens (classic)* hoặc *Fine-grained tokens*).
   - Chọn quyền tối thiểu:
     - Với Private Repo: Cấp quyền `repo`.
     - Với Public Repo: Cấp quyền `public_repo` (hoặc Fine-grained: Contents `Read & Write`).
2. **Cấu hình trên Extension:**
   - Mở GitTask Sync ➔ Chọn tab **⚙️ Cài đặt**.
   - Điền các thông tin:
     - **GitHub Token**: Mã PAT vừa tạo ở bước 1.
     - **GitHub Username / Org**: Tên người dùng hoặc Organization GitHub.
     - **Tên Repository**: Tên repo lưu trữ (ví dụ: `my-todo-vault`).
     - **Nhánh (Branch)**: Mặc định `main` (hoặc `master`).
     - **Đường dẫn tệp (File Path)**: Mặc định `tasks.json` (hoặc `todos/work.json`).
   - Nhấn **Lưu cấu hình & Kiểm tra kết nối**.
   - Bấm **Pull từ GitHub** để tải dữ liệu về máy hoặc **Push lên GitHub** để bắt đầu đồng bộ.

---

## 🧪 Chạy bộ kiểm thử tự động E2E (Playwright)

Bộ kiểm thử được thiết kế chuyên biệt cho Chrome Extension Manifest V3 bằng cách nạp trực tiếp extension vào Chromium với các cờ:
`--disable-extensions-except=...` và `--load-extension=...`.

```bash
cd tests
npm install
npm test
```

### Các kịch bản kiểm thử bao phủ (11 test suites):
1. **CRUD & Local Storage**: Tạo, Đọc, Sửa, Xóa task, đóng/mở mô tả chi tiết, lưu trữ `chrome.storage.local`.
2. **Sort & Search**: Đánh dấu Hoàn thành, tự động sắp xếp task xong xuống dưới, tìm kiếm từ khóa, chuyển đổi Dark/Light mode.
3. **GitHub Sync & Conflict**: Xử lý path chứa ký tự đặc biệt, Pull/Push, bảo vệ Dirty Local, phát hiện xung đột HTTP 409 & hiển thị link GitHub.
4. **Bảo mật & Sanitization**: Chống tấn công XSS, chặn Directory Traversal (`..`), lọc MIME ảnh an toàn, ẩn token trong thông báo lỗi.
5. **Edge Cases**: Đồng bộ mảng rỗng `[]`, xử lý file lớn (> 1MB) qua Blobs API, mất kết nối mạng khi PUT, mã lỗi 403 Rate Limit.
6. **Giao diện Folder, Rút gọn mô tả & 4 màu cờ**: Nút `➕ Thêm` trên từng Folder (kể cả Folder trống), mặc định thu gọn Folder ở màn danh sách, chỉ hiển thị số lượng công việc, bỏ các filter/option nhóm thừa, rút gọn mô tả tự động (2 dòng) kèm Xem thêm/Thu gọn.
7. **Cửa sổ nổi & Auto Push**: Mở Floating Window (`chrome.windows.create`), đếm ngược Auto Push 2 bộ đếm (Idle timer & Max timer), trạng thái Cây sạch/Chưa sạch.
8. **Dọn dẹp tab Đã xong theo ngày**: Thanh dọn dẹp ở tab `Đã xong` với mốc mặc định lùi 30 ngày (`🗑️ Xóa task quá 30 ngày`) và hỗ trợ xóa các công việc đã xong từ ngày tùy chọn trở về trước.
9. **Copy nhanh (Text + Ảnh) & Toast tự ẩn**: Sao chép đồng thời văn bản mô tả và nhiều hình ảnh đính kèm qua `ClipboardItem` (chống XSS khi paste), copy ảnh lẻ từ Lightbox, và thông báo Toast nổi tự động ẩn (kèm tạm dừng khi hover).
10. **Cây thư mục đa cấp & Git Trees API**: Tạo thư mục con/cháu nhiều tầng, lọc công việc theo nhánh thư mục, đổi tên thư mục cha cập nhật dây chuyền xuống thư mục con, đánh dấu Dirty khi thao tác thư mục và đồng bộ từng thư mục thành `<folder>/tasks.json` qua Git Trees API.
11. **Native Messaging Updater (`git pull` + Reload)**: Kiểm tra hướng dẫn & copy lệnh khi chưa cài host, kết nối Native Messaging Host trong môi trường cô lập, chạy `git pull --ff-only` kéo commit mới, tự reload Extension và báo đã ở bản mới nhất.

---

## 📊 Mô hình dữ liệu (JSON Schema)

Dữ liệu lưu trữ tại file JSON trên GitHub tuân thủ định dạng chuẩn sau:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-11-05T07:00:00.000Z",
  "groups": ["Công việc", "Dự án GitHub", "Cá nhân", "Khẩn cấp"],
  "tasks": [
    {
      "id": "task-uuid-v4",
      "title": "Hoàn thiện tài liệu kiến trúc",
      "description": "Chi tiết các API endpoint và sơ đồ luồng dữ liệu",
      "group": "Công việc",
      "priority": "high",
      "status": "todo",
      "updatedAt": "2026-11-05T07:00:00.000Z",
      "images": [
        {
          "id": "img-1",
          "name": "screenshot.png",
          "dataUrl": "data:image/png;base64,..."
        }
      ]
    }
  ]
}
```

---

## 📝 Nhật ký phát hành (Changelog)

### [1.0.0] - 2026-11-05
- **Khởi tạo dự án GitTask Sync**:
  - Kiến trúc 100% Vanilla JS, HTML, CSS không phụ thuộc bundler.
  - Chuẩn Manifest V3 với quyền tối thiểu.
  - Hỗ trợ cả 2 chế độ hiển thị: Popup gắn thanh công cụ và Cửa sổ nổi độc lập (Floating Window).
  - Tích hợp đồng bộ hai chiều GitHub Contents API & Blobs API với khả năng chống xung đột dữ liệu (Conflict Resolution).
  - Hệ thống Auto Push tự động 2 bộ đếm an toàn kèm chỉ báo trạng thái Clean/Dirty.
  - Hỗ trợ phân cấp Nhóm -> Priority với bộ lọc Multi-select tiện lợi.
  - Bộ kiểm thử tự động 8/8 suites E2E hoàn chỉnh với Playwright Chromium.

---

## 📄 Bản quyền (License)

Dự án phát hành theo giấy phép [MIT](LICENSE). Tự do sử dụng, chỉnh sửa và đóng góp cho cộng đồng.

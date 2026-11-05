# GitTask Sync — Chrome Extension (Manifest V3)

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/macductan/todo-list-extension)
[![Manifest](https://img.shields.io/badge/Manifest-V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Playwright Tests](https://img.shields.io/badge/playwright-9%2F9%20passed-brightgreen.svg)](tests/)
[![Vanilla JS](https://img.shields.io/badge/built%20with-100%25%20Vanilla%20JS-F7DF1E.svg)](extension/)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

Chrome Extension quản lý công việc cá nhân (To-Do) siêu nhẹ, được xây dựng bằng **100% Vanilla HTML, CSS, JavaScript (ES6+)** — hoàn toàn không dùng framework, không thư viện UI ngoài, không cần bundler (Webpack/Vite) — và đồng bộ dữ liệu hai chiều trực tiếp qua **GitHub REST API (Contents API & Git Blobs API)**.

---

## 🌟 Điểm nổi bật & Tính năng chính

### 1. 📋 Quản lý Task toàn diện (CRUD)
- Lưu trữ chuẩn cấu trúc: `id`, `title`, `description`, `group`, `priority`, `status`, `updatedAt`, cùng tùy chọn đính kèm ảnh chụp màn hình nén nhẹ.
- **Rút gọn mô tả thông minh & Copy nhanh kèm ảnh**: Mặc định ẩn mô tả trong danh sách; khi mở tự động giới hạn 2 dòng kèm nút `Xem thêm ▾` / `Thu gọn ▴`. Nút `📋 Copy` trên thẻ công việc cho phép sao chép tức thì cả văn bản mô tả (`text/plain`, `text/html` an toàn XSS) lẫn hình ảnh đính kèm (`image/png`) vào Clipboard mà không cần mở mô tả trước.
- **Thông báo Toast tự động ẩn**: Hiển thị thông báo nổi gọn nhẹ kèm thanh đếm ngược tự ẩn, tự động tạm dừng khi rê chuột vào đọc.
- Chuyển đổi trạng thái nhanh (`Chưa làm` ↔ `Đã xong`), tự động đưa các việc đã hoàn thành xuống cuối danh sách.
- Tìm kiếm theo từ khóa theo thời gian thực trên cả Tiêu đề và Mô tả task.

### 2. 🚩 4 Mức Cờ Ưu Tiên & Bộ lọc linh hoạt (Multi-select Priority)
- 4 cấp độ ưu tiên với màu sắc nhận diện trực quan:
  - 🔴 **High** (Ưu tiên Cao)
  - 🟡 **Medium** (Ưu tiên Trung bình)
  - 🔵 **Low** (Ưu tiên Thấp)
  - ⚪ **None** (Không ưu tiên)
- **Lọc nhiều cờ cùng lúc**: Cho phép chọn đồng thời nhiều cờ (ví dụ High + Medium); nút `Tất cả cờ` hỗ trợ bật/tắt toàn bộ nhanh chóng.
- Huy hiệu số đếm (`badge count`) tự động đồng bộ theo bộ lọc trạng thái (`Đang làm` / `Đã xong`).

### 3. 🗂️ Phân cấp `Nhóm -> Priority` & Quản lý Nhóm độc lập
- Danh sách công việc phân cấp 2 tầng rõ ràng: **Nhóm công việc (`Group`)** ➔ **Cờ ưu tiên (`Priority`)**.
- Cho phép thu gọn/mở rộng từng nhóm hoặc lọc hiển thị nhóm trên thanh công cụ.
- Tab `🗂️ Quản lý Nhóm` chuyên biệt:
  - Thêm mới, đổi tên nhóm (tự động cập nhật toàn bộ task thuộc nhóm).
  - Sắp xếp thứ tự hiển thị bằng nút `↑` / `↓`.
  - Xóa nhóm an toàn: bắt buộc chọn chuyển việc sang nhóm khác trước khi xóa, tránh mất dữ liệu.

### 4. 🪟 Popup tiện dụng & Cửa sổ nổi độc lập (Floating Window)
- **Popup mặc định**: Nhấn icon trên thanh công cụ mở giao diện kích thước chuẩn `780×600`.
- **Cửa sổ nổi (Floating Window)**: Nút `🪟 Cửa sổ nổi` mở riêng cửa sổ độc lập qua `chrome.windows.create` (`type: "popup"`), thoải mái kéo thả, ghim cạnh màn hình làm việc, không phụ thuộc vào tab trình duyệt đang mở.
- Hỗ trợ tùy chọn mở thẳng Cửa sổ nổi khi nhấn icon trong phần Cài đặt.

### 5. 🔄 Auto Push 2 Bộ đếm & Trạng thái Cây dữ liệu (`Clean` / `Dirty`)
- Hiển thị trực quan trạng thái trên thanh tiêu đề:
  - `✓ Cây sạch` / `✓ Cây sạch (Đã commit)`
  - `● Chưa sạch (Cần commit)` kèm đồng hồ đếm ngược Auto Push.
- **Cơ chế 2 bộ đếm an toàn (Dual-timer debounce)**:
  - **Idle Delay**: Đếm ngược sau thay đổi cuối cùng (mặc định `10s`).
  - **Max Delay**: Giới hạn tối đa tính từ thay đổi đầu tiên (mặc định `5 phút`), đảm bảo thay đổi liên tục vẫn được đẩy lên GitHub định kỳ.
  - Tự động tạm dừng nếu phát hiện xung đột từ xa.

### 6. 🐙 Đồng bộ GitHub REST API & Chống ghi đè xung đột (Conflict Resolution)
- Đồng bộ hóa qua `https://api.github.com/repos/{owner}/{repo}/contents/{path}`.
- Lưu trữ `base_sha` của commit gần nhất tại `chrome.storage.local`.
- Tự động kiểm tra xung đột trước khi đẩy:
  - Nếu `sha` trên GitHub khác `base_sha` hoặc API trả về mã `409 Conflict` / `422 Unprocessable`: lập tức cảnh báo đỏ, không ghi đè dữ liệu.
  - Cung cấp tùy chọn minh bạch: Mở file trên GitHub, Xem lịch sử Commit, **Force Pull** (nhận bản từ xa) hoặc **Force Push** (ghi đè bản cục bộ).
- Hỗ trợ xử lý file lớn (> 1MB) tự động thông qua **Git Blobs API** (`/git/blobs`).

### 7. 🛡️ Bảo mật chuẩn Manifest V3 & Chống XSS
- **Tối thiểu hóa quyền**: Chỉ yêu cầu `permissions: ["storage"]` và `host_permissions: ["https://api.github.com/*"]`. Không chèn `content_scripts`, không theo dõi lịch sử duyệt web.
- **Bảo mật Token**: GitHub Personal Access Token lưu trong `chrome.storage.local`, trường nhập mật khẩu ẩn ký tự (`type="password"`), tự động che mờ (`redact`) trong logs/thông báo lỗi.
- **Chống tấn công XSS**: Render toàn bộ văn bản qua `textContent`, kiểm tra nghiêm ngặt định dạng MIME ảnh đính kèm (chỉ nhận PNG, JPG, WEBP, GIF; chặn SVG chứa mã thực thi), chặn đường dẫn Directory Traversal (`..`).
- **Giao diện đa phong cách**: Chuyển đổi Dark Mode / Light Mode mượt mà.

---

## 📁 Cấu trúc thư mục dự án

```text
todo-list-extension/
├── .gitignore              # Bỏ qua node_modules, log, kết quả kiểm thử
├── README.md               # Tài liệu hướng dẫn sử dụng và đặc tả kỹ thuật
├── extension/              # Mã nguồn Chrome Extension (Cài đặt Load Unpacked)
│   ├── manifest.json       # Khai báo quyền hạn và metadata chuẩn Manifest V3
│   ├── background.js       # Service worker khởi tạo & điều hướng Floating Window
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
    └── extension.e2e.spec.js # 8 kịch bản kiểm thử E2E bao phủ toàn diện
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

### Các kịch bản kiểm thử bao phủ (9 test suites):
1. **CRUD & Local Storage**: Tạo, Đọc, Sửa, Xóa task, đóng/mở mô tả chi tiết, lưu trữ `chrome.storage.local`.
2. **Sort & Search**: Đánh dấu Hoàn thành, tự động sắp xếp task xong xuống dưới, tìm kiếm từ khóa, chuyển đổi Dark/Light mode.
3. **GitHub Sync & Conflict**: Xử lý path chứa ký tự đặc biệt, Pull/Push, bảo vệ Dirty Local, phát hiện xung đột HTTP 409 & hiển thị link GitHub.
4. **Bảo mật & Sanitization**: Chống tấn công XSS, chặn Directory Traversal (`..`), lọc MIME ảnh an toàn, ẩn token trong thông báo lỗi.
5. **Edge Cases**: Đồng bộ mảng rỗng `[]`, xử lý file lớn (> 1MB) qua Blobs API, mất kết nối mạng khi PUT, mã lỗi 403 Rate Limit.
6. **Mô tả & Nhóm**: Rút gọn mô tả tự động (2 dòng), nút xem thêm/thu gọn, chia nhóm và ẩn/hiện task theo Nhóm và Priority.
7. **Cửa sổ nổi & Auto Push**: Mở Floating Window (`chrome.windows.create`), đếm ngược Auto Push 2 bộ đếm (Idle timer & Max timer), trạng thái Cây sạch/Chưa sạch.
8. **Bộ lọc Multi-select Priority**: Chọn đồng thời nhiều cờ ưu tiên, nút Tất cả cờ, kiểm tra biến động số đếm khi thay đổi trạng thái hoàn thành.
9. **Copy nhanh (Text + Ảnh) & Toast tự ẩn**: Sao chép đồng thời văn bản mô tả và nhiều hình ảnh đính kèm qua `ClipboardItem` (chống XSS khi paste), copy ảnh lẻ từ Lightbox, và thông báo Toast nổi tự động ẩn (kèm tạm dừng khi hover).

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

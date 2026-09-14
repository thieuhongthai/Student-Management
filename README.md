# Sổ Lớp — Quản lý trung tâm dạy học

Ứng dụng quản lý học sinh, lớp học, phiếu thu học phí và nhật ký giảng dạy.
Chạy hoàn toàn trên laptop của bạn (Windows 11), dữ liệu lưu trong file SQLite tại `data/trungtam.db`.

---

## PHẦN 1 — Chạy thử trên chính laptop của bạn

### Bước 1: Cài Node.js
1. Vào https://nodejs.org
2. Tải bản **LTS** (bản khuyến nghị, số hiệu chẵn, ví dụ 20.x hoặc 22.x)
3. Chạy file cài đặt, bấm Next liên tục theo mặc định
4. Mở **PowerShell** (bấm Start, gõ "PowerShell"), gõ lệnh sau để kiểm tra:
   ```
   node -v
   npm -v
   ```
   Nếu hiện ra số phiên bản là cài thành công.

### Bước 2: Giải nén và cài thư viện
1. Giải nén file `so-lop-server.zip` vào một thư mục, ví dụ `C:\SoLop`
2. Mở PowerShell, di chuyển vào thư mục đó:
   ```
   cd C:\SoLop
   ```
3. Cài các thư viện cần thiết:
   ```
   npm install
   ```
   Chờ khoảng 1-2 phút. Nếu thấy dòng cuối `added XX packages` là thành công.

   > Nếu bước này báo lỗi liên quan đến `better-sqlite3` (biên dịch C++), tải và cài thêm **Visual Studio Build Tools** (chọn mục "Desktop development with C++") từ https://visualstudio.microsoft.com/visual-cpp-build-tools/, sau đó chạy lại `npm install`. Trường hợp này khá hiếm vì thư viện có sẵn bản dựng cho Windows.

### Bước 3: Chạy server
```
npm start
```
Nếu thấy dòng:
```
Sổ Lớp đang chạy tại http://localhost:3000
```
là server đã chạy. Cửa sổ PowerShell này phải **để mở**, đóng lại là server dừng.

### Bước 4: Mở ứng dụng
Mở trình duyệt, vào: **http://localhost:3000**

Đăng nhập lần đầu bằng tài khoản mặc định (được in ra trong PowerShell khi chạy lần đầu):
- Tên đăng nhập: `admin`
- Mật khẩu: `Admin@123`

**Đổi mật khẩu ngay** ở mục "Tài khoản" trong app.

### Bước 5: Tạo tài khoản cho các giáo viên/nhân viên khác
Vào mục **Tài khoản** (chỉ admin thấy được mục thêm nhân viên) → điền tên đăng nhập, mật khẩu tạm, vai trò → Thêm tài khoản. Gửi thông tin đăng nhập cho người đó và nhắc họ đổi mật khẩu sau lần đăng nhập đầu.

---

## PHẦN 2 — Cho các máy khác trong mạng LAN cùng dùng (VD: giáo viên dùng điện thoại/laptop trong cùng wifi trung tâm)

### Bước 1: Lấy địa chỉ IP nội bộ của laptop đang chạy server
Trong PowerShell:
```
ipconfig
```
Tìm dòng **IPv4 Address** trong phần Wi-Fi hoặc Ethernet đang dùng, ví dụ `192.168.1.15`.

> Khuyên: vào cài đặt router, đặt **IP tĩnh (Static/Reserved IP)** cho laptop này, để địa chỉ không đổi mỗi lần khởi động lại.

### Bước 2: Mở cổng 3000 trên Windows Firewall
1. Mở **Windows Defender Firewall with Advanced Security**
2. Chọn **Inbound Rules** → **New Rule**
3. Chọn **Port** → Next → **TCP**, Specific local ports: `3000` → Next
4. Chọn **Allow the connection** → Next → tick cả 3 (Domain/Private/Public, hoặc chỉ Private nếu muốn an toàn hơn) → Next
5. Đặt tên (VD: "So Lop Server") → Finish

### Bước 3: Truy cập từ máy khác
Trên điện thoại/laptop khác **trong cùng mạng wifi**, mở trình duyệt, vào:
```
http://192.168.1.15:3000
```
(thay bằng đúng IP của laptop bạn)

---

## PHẦN 3 — Giữ server luôn chạy ổn định (không cần mở PowerShell tay)

Cài **PM2** để server tự chạy nền và tự khởi động lại nếu bị lỗi:

```
npm install -g pm2
pm2 start server.js --name so-lop
pm2 save
```

Để PM2 tự chạy khi Windows khởi động, cài thêm:
```
npm install -g pm2-windows-startup
pm2-startup install
```

Kiểm tra trạng thái: `pm2 status` — Dừng: `pm2 stop so-lop` — Xem log: `pm2 logs so-lop`

---

## PHẦN 4 — Sao lưu dữ liệu (quan trọng!)

Toàn bộ dữ liệu nằm trong 1 file: `data/trungtam.db`

Khuyến nghị: thiết lập sao chép file này mỗi ngày sang USB, ổ cứng khác, hoặc thư mục Google Drive/OneDrive đồng bộ. Có thể dùng **Task Scheduler** của Windows để tự động copy file này mỗi tối.

---

## PHẦN 5 — Nếu muốn truy cập từ ngoài internet (không chỉ trong LAN)

Đây là bước nâng cao, cần thêm:
- Domain + Dynamic DNS (vì IP nhà thường đổi)
- Mở port trên router (port forwarding) trỏ vào laptop
- Cấu hình HTTPS (khuyên dùng **Caddy** làm reverse proxy, tự cấp SSL miễn phí)
- Trong `server.js`, đổi `cookie.secure` thành `true` khi đã chạy qua HTTPS

Phần này nên làm sau khi đã dùng ổn định trong LAN. Nhắn lại nếu bạn muốn mình hướng dẫn chi tiết bước này.

---

## Cấu trúc thư mục

```
so-lop-server/
├── server.js          # Backend Express + SQLite
├── package.json
├── public/
│   └── index.html     # Toàn bộ giao diện (SPA)
└── data/
    └── trungtam.db    # Database (tự tạo khi chạy lần đầu)
```

## Các lệnh thường dùng

| Lệnh | Ý nghĩa |
|---|---|
| `npm install` | Cài thư viện (chỉ cần chạy 1 lần, hoặc khi cập nhật code) |
| `npm start` | Chạy server |
| `pm2 start server.js --name so-lop` | Chạy server nền, tự khởi động lại khi lỗi |
| `pm2 logs so-lop` | Xem log khi chạy bằng PM2 |

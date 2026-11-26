# Viewstreets IoT Platform (InfluxDB + PostgreSQL + HTTP Camera + Docker)

Hệ thống giám sát và điều khiển chiếu sáng đường phố thông minh Viewstreets, được tái cấu trúc theo kiến trúc phân lớp và đóng gói hoàn chỉnh bằng Docker Compose.

## 1. Kiến trúc lưu trữ & Truyền dữ liệu
- **InfluxDB 2.7 (`http://localhost:8086`)**: Lưu chuỗi thời gian các thông số cảm biến (`temp`, `humi`, `light`, `motion`, `rain`, `dust`, `bat`, `rssi`, `load`).
- **PostgreSQL 16 (`localhost:5432`)**: Lưu danh sách node (`nodes`), cấu hình điều khiển & trạng thái đồng bộ sau deep sleep (`node_controls`, `control_logs`), sơ đồ liên kết định tuyến (`network_links`), và dữ liệu hình ảnh/video nhị phân từ camera (`camera_media`).
- **HTTP Camera & Video Stream (`/api/camera/*`)**:
  - `POST /api/camera/upload?nodeId=<id>&type=image|video`: Nhận ảnh JPEG/PNG hoặc video MP4 trực tiếp từ ESP32-CAM.
  - `GET /api/camera/<id>/stream`: Phát luồng video HTTP MJPEG trực tiếp lên giao diện web.
  - `GET /api/camera/<id>/latest`: Lấy ảnh/video mới nhất từ PostgreSQL.
  - `GET /api/camera/<id>/history`: Liệt kê lịch sử ảnh/video trong PostgreSQL.

## 2. Hướng dẫn chạy bằng Docker
1. Giải nén thư mục dự án và mở terminal tại thư mục gốc.
2. Khởi chạy toàn bộ cụm dịch vụ (`web`, `postgres`, `influxdb`):
   ```bash
   docker compose up -d --build
   ```
3. Mở trình duyệt tại:
   - **Web Dashboard**: `http://localhost:3000` (nhập token mặc định `viewstreet_admin_2026` ở góc phải trên).
   - **InfluxDB UI**: `http://localhost:8086` (tài khoản `admin` / mật khẩu `viewstreet12345`).

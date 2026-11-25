# ViewStreet — ESP32-CAM Node Firmware

Firmware chính thức cho các nút **ESP32-CAM** trong hệ thống ViewStreet:
- **Định danh duy nhất (`NodeID`) cho từng ESP32**: tự động sinh từ địa chỉ MAC phần cứng eFuse của chip (ví dụ `node_a1b2c3`) khi đặt `NODE_ID "AUTO"`, hoặc cho phép đặt tên cố định (`"node_1"`, `"node_2"`, ...) trong `include/secrets.h`.
- **Dữ liệu cảm biến -> gửi lên Adafruit IO (MQTT)**:
  - Đọc **DHT20** (nhiệt độ, độ ẩm), **BH1750** (ánh sáng Lux) trên bus `I2C_NUM_1` độc lập (`SDA=GPIO13`, `SCL=GPIO14`) và cảm biến chuyển động/hiện diện (`GPIO15`).
  - Publish JSON định kỳ lên `<AIO_USERNAME>/feeds/viewstreet.telemetry` kèm `nodeId`, `temp`, `humi`, `light`, `motion`, `bat`, `rssi`, `load`, `mode`, `ledLevel`, `error`.
  - Lắng nghe lệnh điều khiển từ xa trên `<AIO_USERNAME>/feeds/viewstreet.control` (`set_mode`, `set_led`, `set_camera`, `set_threshold`, `ota_update`, đồng bộ `sync`) và gửi gói tin phản hồi `ACK` (`type: "ack"`, `cmdId`) về server.
- **Hình ảnh Camera -> gửi trực tiếp lên Web Server (HTTP)**:
  - Tự động hỗ trợ cả cảm biến JPEG phần cứng (**OV2640/OV3660/OV5640**) lẫn cảm biến RAW (**GC2145/GC0308/OV7670/OV7725** nén sang JPEG trong RAM qua `frame2jpg()`).
  - Upload trực tiếp qua `POST <BACKEND_URL>/api/camera/upload?nodeId=<NodeID>&type=image` (header `Content-Type: image/jpeg`, `X-Node-Id: <NodeID>`), hỗ trợ cả 3 chế độ điều khiển từ Web: `PERIODIC` (định kỳ theo giây), `CONTINUOUS` (luồng video MJPEG trực tiếp) và `OFF`.

## Cấu hình và nạp chương trình

1. Sao chép `include/secrets.h.example` thành `include/secrets.h` và điền thông tin:
   - `WIFI_SSID`, `WIFI_PASSWORD` (Wi-Fi 2.4GHz)
   - `AIO_USERNAME`, `AIO_KEY` (Adafruit IO)
   - `BACKEND_URL` (địa chỉ LAN của máy chạy Web Server, ví dụ `"http://192.168.1.100:3000"`)
   - `NODE_ID`: giữ `"AUTO"` để mỗi mạch ESP32 tự nhận ID riêng theo phần cứng, hoặc đặt `"node_1"`, `"node_2"`, ...
2. Biên dịch và nạp từ thư mục `firmware`:

```powershell
pio run
pio run -t upload
pio device monitor -b 115200
```

3. Khi mạch khởi động lần đầu và gửi gói tin MQTT hoặc ảnh HTTP, node sẽ xuất hiện trong danh sách **Chờ duyệt (`pending_nodes`)** trên Web Dashboard. Bấm **Duyệt (Approve)** trên Web để bắt đầu lưu dữ liệu vào PostgreSQL / InfluxDB và hiển thị trực tiếp.
4. Lệnh kiểm tra nhanh qua Serial Monitor (`115200` baud): `STATUS`, `CAPTURE`, `TELEMETRY`.

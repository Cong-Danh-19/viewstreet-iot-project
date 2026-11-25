# ViewStreet — ESP32-CAM Node Firmware

Firmware chính thức cho các nút **ESP32-CAM** trong hệ thống ViewStreet:
- **Định danh duy nhất (`NodeID`) cho từng ESP32**: tự động sinh từ địa chỉ MAC phần cứng eFuse của chip (ví dụ `node_98b78c`) khi đặt `NODE_ID "AUTO"`, hoặc cho phép đặt tên cố định (`"node_1"`, `"node_2"`, ...) trong `include/secrets.h`.
- **Dữ liệu cảm biến -> gửi tự động lên Adafruit IO (MQTT)**:
  - Đọc **DHT20** (nhiệt độ, độ ẩm), **BH1750** (ánh sáng Lux) trên bus `I2C_NUM_0` (`SDA=GPIO13`, `SCL=GPIO14`) độc lập với Camera SCCB (`I2C_NUM_1`), cùng cảm biến chuyển động/hiện diện (`GPIO15`).
  - Tự động đẩy gói tin đầu tiên **ngay tức thì** khi `mqtt.connected()` thành công (không bị trễ bởi log offline lúc mới khởi động).
  - Nhận lệnh điều khiển từ xa trên `<AIO_USERNAME>/feeds/viewstreet.control` và gửi phản hồi `ACK` (`type: "ack"`, `cmdId`).
- **Hình ảnh Camera -> gửi trực tiếp lên Web Server (hỗ trợ cả `http://` LAN và `https://` Cloud/Ngrok)**:
  - Tự động hỗ trợ cả cảm biến JPEG phần cứng (**OV2640**) lẫn cảm biến RAW (**GC2145/GC0308/OV7670** nén sang JPEG trong RAM qua `frame2jpg()`).
  - Hỗ trợ cả **`http://`** (kèm tự động dò tìm máy chủ qua Gateway/mDNS `<BACKEND_MDNS_HOST>.local`) lẫn **`https://`** (`WiFiClientSecure`, tương thích Ngrok, Cloudflare Tunnel, Render, Railway).

## Lưu ý bắt buộc khi cắm nguồn độc lập & mở cổng mạng

1. **Chân `GPIO 0` (Boot Mode vs Camera XCLK)**:
   - Sau khi nạp code xong và chuyển sang cấp nguồn độc lập (sạc 5V / pin dự phòng), **bắt buộc rút hoàn toàn dây nối `IO0 - GND`** (hoặc tháo mạch ESP32-CAM ra khỏi đế nạp `ESP32-CAM-MB` nếu nút `IO0` trên đế bị kẹt) để tránh ESP32 rơi vào chế độ `Download Mode` lúc mới cấp điện.
2. **Mạng nội bộ & Tường lửa máy chủ (khi dùng `http://<IP_LAN>:3000`)**:
   - Máy chạy Server và ESP32 cần kết nối **cùng mạng Wi-Fi / Hotspot** (hoặc dùng `https://...` qua Ngrok / Cloudflare Tunnel nếu khác mạng).
   - Trên Windows, mở cổng `3000` cho mạng nội bộ nếu bị Windows Defender Firewall chặn:
     ```powershell
     New-NetFirewallRule -DisplayName "ViewStreet Port 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
     ```

## Biên dịch và nạp chương trình

Chạy từ thư mục `firmware`:

```powershell
pio run
pio run -t upload
pio device monitor
```

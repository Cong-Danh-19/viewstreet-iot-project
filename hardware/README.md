# ESP32-CAM firmware

Đọc DHT20, BH1750 và cảm biến hiện diện; gửi telemetry lên Adafruit IO mỗi 5 giây. Khi nhận lệnh camera trên feed `viewstreet.control`, ESP32-CAM chụp một JPEG, mã hóa Base64 và gửi lên feed `viewstreet.camera`.

## Cấu hình và chạy

1. Điền Wi-Fi và Adafruit IO trong `include/secrets.h` (copy từ `include/secrets.h.example`). File secrets đã được Git ignore.
2. Tạo feeds `viewstreet.telemetry`, `viewstreet.camera`, `viewstreet.control`, `device-status` trong Adafruit IO.
3. Tắt history cho feed `viewstreet.camera`; feed có history giới hạn mỗi giá trị ở 1 KB. Ảnh được giới hạn bởi MQTT buffer 32 KB.
4. Từ thư mục `hardware`:

```sh
pio run
pio run -t upload
pio device monitor -b 115200
```

Gửi `capture`, `camera` hoặc `{"command":"camera"}` lên `USERNAME/feeds/viewstreet.control` để chụp ảnh. Ảnh chỉ chụp khi có lệnh.

## Kết nối

- I2C: SDA GPIO13, SCL GPIO14; DHT20 `0x38`, BH1750 `0x23`.
- Presence: GPIO15, active-low. Đây là chân strap; kiểm tra tín hiệu lúc khởi động và dùng mức logic 3.3V.
- Camera: OV2640 theo pinout AI Thinker ESP32-CAM.
- Dùng nguồn 5V ổn định, chung GND; không cấp nguồn board từ chân 3.3V của USB-UART.

Firmware cần thư viện DFRobot_DHT20, BH1750 và PubSubClient. JPEG gửi qua Adafruit IO dạng Base64; ảnh lớn hơn MQTT buffer sẽ bị bỏ qua và ghi lỗi Serial. Adafruit IO giới hạn payload feed 512 KB khi tắt history; giới hạn firmware hiện là 32 KB. [Tài liệu Adafruit IO](https://io.adafruit.com/api/docs/).

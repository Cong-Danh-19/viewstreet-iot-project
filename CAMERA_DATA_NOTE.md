# Ghi chú kiểm tra truyền dữ liệu camera

## Kết luận

Luồng trong code đã được nối từ Adafruit IO MQTT đến trình duyệt: backend subscribe feed `viewstreet.camera`, nhận message rồi phát Socket.IO event `camera_frame`; frontend nhận event và gán vào `#cam-view` dưới dạng `data:image/jpeg;base64,...` nếu payload chưa có data URI.

Chưa thể khẳng định ảnh thực tế đã qua tới web trong lần kiểm tra này: không có bằng chứng về message camera đang được publish và hiển thị. Vì vậy kết luận là **đường truyền đã có trong code, nhưng truyền ảnh đầu-cuối chưa được xác nhận**.

## Lỗi/rủi ro tìm thấy

1. **Giới hạn kích thước feed có thể chặn ảnh.** Adafruit IO giới hạn giá trị feed tối đa 1 KB khi bật lưu lịch sử, hoặc 512 KB khi tắt lưu lịch sử. Ảnh JPEG mã hóa Base64 tăng kích thước khoảng 33%, nên ảnh camera thường vượt mức 1 KB rất dễ dàng.
2. **Frontend chỉ hiểu một số định dạng.** Code giả định payload là JPEG Base64 thuần hoặc data URI. URL ảnh, JSON bọc Base64, hoặc data URI có MIME khác sẽ không hiển thị đúng.
3. **Thiếu chẩn đoán lỗi ảnh.** Backend không ghi nhận kích thước message hay lỗi parse/định dạng; frontend không xử lý sự kiện `img.onerror`, nên ảnh hỏng có thể chỉ hiện khung trống.
4. **Chưa có xác nhận hiển thị trên trang.** Luồng là phát broadcast realtime; không có sự kiện khởi tạo gửi lại frame mới nhất cho client vừa mở trang.

## Cách khắc phục đề xuất

- Nếu tiếp tục dùng Adafruit IO: tắt feed history cho feed camera để dùng giới hạn tối đa 512 KB, giảm kích thước JPEG trước khi mã hóa Base64, và kiểm tra tổng kích thước payload sau mã hóa trước khi publish. Giới hạn thực tế của ảnh cần thấp hơn 512 KB.
- Chuẩn hóa định dạng payload: publish data URI (`data:image/jpeg;base64,...`) hoặc thống nhất Base64 thuần; nếu dùng JSON thì parse đúng cấu trúc ở backend/frontend. Hỗ trợ MIME thực tế (`jpeg`/`png`) thay vì mặc định JPEG.
- Thêm log an toàn gồm topic, byte length, thời điểm nhận; thêm kiểm tra định dạng và xử lý `img.onerror` để phát hiện ảnh không hợp lệ. Không ghi nội dung ảnh hay khóa API vào log.
- Khi cần ảnh lớn hoặc luồng video liên tục, gửi ảnh trực tiếp qua HTTP/WebSocket/WebRTC tới backend hoặc object storage; chỉ gửi URL/metadata qua MQTT. Adafruit IO giới hạn tốc độ dữ liệu (30 điểm/phút gói Free, 60 điểm/phút IO+), nên không phù hợp làm kênh video.
- Để người mở trang sau vẫn thấy hình gần nhất, lưu frame mới nhất ở backend và gửi cho client ngay khi Socket.IO kết nối.

## Tài liệu tham khảo

- [Adafruit IO API Reference: giới hạn kích thước feed và tốc độ dữ liệu](https://io.adafruit.com/api/docs/)
- [Adafruit IO MQTT API: topic và rate limit MQTT](https://io.adafruit.com/api/docs/mqtt.html)
- [Adafruit IO Cookbook: hiển thị Base64 image](https://io.adafruit.com/api/docs/cookbook.html)

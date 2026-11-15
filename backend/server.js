const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { client, FEEDS } = require('./config/adafruit');
const stateManager = require('./services/stateManager');
const routingService = require('./services/routingService');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Phục vụ giao diện tĩnh từ thư mục frontend
app.use(express.static('frontend'));

// Lắng nghe dữ liệu thực tế từ Adafruit IO MQTT Client
client.on('message', (topic, message) => {
    const payloadStr = message.toString();

    if (topic === FEEDS.TELEMETRY) {
        try {
            const data = JSON.parse(payloadStr);
            
            // Cập nhật trạng thái Node 1 và tự động ghi vào history.json
            const { networkState, newRecord } = stateManager.updateNode1(data);
            
            // Tính toán định tuyến cân bằng tải
            const routingInfo = routingService.evaluateRoutes(networkState);
            
            // Phát tán dữ liệu thật kèm bản ghi lịch sử mới xuống WebSocket
            io.emit('state_update', { currentState: networkState, routingInfo, newRecord });
        } catch (e) {
            console.error('[JSON Parse Error]:', e.message);
        }
    } else if (topic === FEEDS.CAMERA) {
        io.emit('camera_frame', payloadStr);
    }
});

// Xử lý kết nối WebSocket từ Client
io.on('connection', (socket) => {
    console.log('[WebSocket] Client đã kết nối:', socket.id);
    
    // Gửi trạng thái hiện tại, định tuyến và toàn bộ lịch sử cũ từ file JSON cho client
    const currentState = stateManager.getState();
    const routingInfo = routingService.evaluateRoutes(currentState);
    const history = stateManager.getHistory();
    
    socket.emit('init_dashboard', { currentState, routingInfo, history });

    // Nhận lệnh điều khiển từ web -> Publish lên Adafruit IO xuống ESP32
    socket.on('cmd_hardware', (cmdObj) => {
        console.log('[Web Control -> Adafruit]:', cmdObj);
        client.publish(FEEDS.CONTROL, JSON.stringify(cmdObj));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`>>> Modular Backend Server đang chạy tại: http://localhost:${PORT}`);
});
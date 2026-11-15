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

// Lắng nghe dữ liệu từ Adafruit IO MQTT Client
client.on('message', (topic, message) => {
    const payloadStr = message.toString();

    if (topic === FEEDS.TELEMETRY) {
        try {
            const data = JSON.parse(payloadStr);
            const currentState = stateManager.updateNode1(data);
            
            // Tính toán định tuyến cân bằng tải
            const routingInfo = routingService.evaluateRoutes(currentState);
            
            // Phát tán xuống toàn bộ Web Client qua WebSocket
            io.emit('state_update', { currentState, routingInfo });
        } catch (e) {
            console.error('[JSON Parse Error]:', e.message);
        }
    } else if (topic === FEEDS.CAMERA) {
        io.emit('camera_frame', payloadStr);
    }
});

// Xử lý sự kiện WebSocket từ Web Dashboard
io.on('connection', (socket) => {
    console.log('[WebSocket] Client đã kết nối:', socket.id);
    
    // Gửi state ban đầu
    const currentState = stateManager.getState();
    const routingInfo = routingService.evaluateRoutes(currentState);
    socket.emit('state_update', { currentState, routingInfo });

    // Nhận lệnh điều khiển từ web -> Publish lên Adafruit IO xuống ESP32
    socket.on('cmd_hardware', (cmdObj) => {
        console.log('[Web Control -> Adafruit]:', cmdObj);
        client.publish(FEEDS.CONTROL, JSON.stringify(cmdObj));
    });

    // Giả lập lỗi node trên giao diện
    socket.on('toggle_sim_node', (nodeId) => {
        const currentState = stateManager.toggleNodeSim(nodeId);
        const routingInfo = routingService.evaluateRoutes(currentState);
        io.emit('state_update', { currentState, routingInfo });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`>>> Modular Backend Server đang chạy tại: http://localhost:${PORT}`);
});

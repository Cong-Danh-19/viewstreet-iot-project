const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const env = require('./config/env');
const { initDatabases } = require('./config/db');
const adafruit = require('./config/adafruit');
const registry = require('./services/nodeRegistry');
const stateManager = require('./services/stateManager');
const controlService = require('./services/controlService');
const routingService = require('./services/routingService');
const alertService = require('./services/alertService');
const registerMqttHandlers = require('./handlers/mqttHandler');
const registerSocketHandlers = require('./handlers/socketHandler');
const createCameraRoutes = require('./routes/cameraRoutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Parse JSON cho API (hỗ trợ payload Base64 lên tới 15MB)
app.use(express.json({ limit: '15mb' }));

// Phục vụ giao diện Web Dashboard
app.use(express.static(env.FRONTEND_DIR));

// API Healthcheck cho Docker / giám sát
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        mqttConnected: adafruit.isConnected(),
        nodeCount: registry.list().length,
        ts: Date.now(),
    });
});

// API HTTP nhận và phát hình ảnh/video từ Camera lưu trong PostgreSQL
app.use('/api/camera', createCameraRoutes(io));

// Đăng ký luồng MQTT và WebSocket
registerMqttHandlers(io);
registerSocketHandlers(io);

// Vòng lặp 5 giây quét node mất kết nối
setInterval(() => {
    const offlineIds = stateManager.sweepOffline(env.OFFLINE_AFTER_MS);
    if (offlineIds.length > 0) {
        io.emit('network_update', stateManager.getState());
        for (const id of offlineIds) {
            const alert = alertService.alertOffline(id);
            if (alert) io.emit('system_alert', alert);
        }
    }
}, 5000);

async function start() {
    await initDatabases();
    await registry.init();
    stateManager.init();
    await controlService.init();
    await routingService.initRouting();

    adafruit.connect();

    server.listen(env.PORT, () => {
        console.log(`[Server] Viewstreets đang chạy tại http://localhost:${env.PORT}`);
    });
}

start().catch((err) => {
    console.error('[Server] Khởi động thất bại:', err);
    process.exit(1);
});

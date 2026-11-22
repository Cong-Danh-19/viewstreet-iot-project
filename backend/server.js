const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const env = require('./config/env');
const { client, publishControl } = require('./config/adafruit');
const registry = require('./services/nodeRegistry');
const stateManager = require('./services/stateManager');
const alertService = require('./services/alertService');
const { createControlService } = require('./services/controlService');
const { registerMqttHandlers } = require('./handlers/mqttHandler');
const { registerSocketHandlers, buildNodeList, buildRoutingAll } = require('./handlers/socketHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (!fs.existsSync(path.join(env.FRONTEND_DIR, 'index.html'))) {
    console.warn(`[UI] Không thấy ${path.join(env.FRONTEND_DIR, 'index.html')}`);
}
app.use(express.static(env.FRONTEND_DIR));

const control = createControlService({
    isRegistered: registry.isRegistered,
    emit: (event, payload) => io.emit(event, payload),
    publish: publishControl,
});

registerMqttHandlers(client, { io, control });
registerSocketHandlers(io, { control });

// Quét định kỳ các node ngừng gửi dữ liệu quá OFFLINE_AFTER_MS
setInterval(() => {
    const changed = stateManager.sweepOffline(env.OFFLINE_AFTER_MS);
    if (!changed.length) return;

    const allRoutes = buildRoutingAll();
    io.emit('node_list', buildNodeList());
    io.emit('routing_update', allRoutes);

    for (const id of changed) {
        io.emit('node_offline', { nodeId: id, routingInfo: allRoutes[id] });
        alertService.notifyOffline(stateManager.getNodeState(id), (ev, p) => io.emit(ev, p));
    }
}, 5000).unref();

server.listen(env.PORT, () => {
    console.log(`>>> Viewstreets Backend Server đang chạy tại: http://localhost:${env.PORT}`);
});
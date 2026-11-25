const adafruit = require('../config/adafruit');
const registry = require('../services/nodeRegistry');
const stateManager = require('../services/stateManager');
const controlService = require('../services/controlService');
const alertService = require('../services/alertService');

module.exports = function registerMqttHandlers(io) {
    adafruit.onMessage(async (topic, payloadBuffer) => {
        let data;
        try {
            data = JSON.parse(payloadBuffer.toString('utf8'));
        } catch (e) {
            console.warn('[MQTT] Bỏ qua gói tin không phải JSON hợp lệ');
            return;
        }

        const nodeId = String(data.nodeId || data.id || '').trim();
        if (!nodeId || !registry.isValidId(nodeId)) return;

        // 1. Xử lý gói tin phản hồi ACK từ node
        if (data.type === 'ack') {
            const ackResult = await controlService.handleAck(nodeId, data);
            if (ackResult) {
                io.emit('control_ack', ackResult);
                io.emit('control_logs', controlService.getLogs());
            }
            return;
        }

        // 2. Nếu node chưa được duyệt -> đưa vào hàng chờ trong PostgreSQL
        if (!registry.isRegistered(nodeId)) {
            await registry.recordPending(nodeId, 'mqtt');
            io.emit('pending_nodes', registry.listPending());
            return;
        }

        // 3. Kiểm tra node có vừa thức dậy từ offline/deep sleep không
        const prev = stateManager.getNodeState(nodeId);
        const wasOffline = !prev || !prev.online;

        // 4. Cập nhật trạng thái live & ghi vào InfluxDB
        const updated = await stateManager.updateNode(nodeId, data);
        if (!updated) return;

        io.emit('network_update', updated.networkState);
        io.emit('sensor_update', updated.node);

        // 5. Đồng bộ cấu hình điều khiển nếu node vừa thức dậy
        if (wasOffline) {
            controlService.syncNode(nodeId, adafruit.publishControl);
        }

        // 6. Kiểm tra ngưỡng cảnh báo
        const alerts = alertService.checkTelemetryAlerts(updated.node);
        for (const alert of alerts) {
            io.emit('system_alert', alert);
        }
    });
};

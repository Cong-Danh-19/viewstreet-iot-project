const env = require('../config/env');
const { FEEDS } = require('../config/adafruit');
const registry = require('../services/nodeRegistry');
const stateManager = require('../services/stateManager');
const routingService = require('../services/routingService');
const imageStorage = require('../services/imageStorageService');
const alertService = require('../services/alertService');

function registerMqttHandlers(client, { io, control }) {
    if (!client) return;

    const warned = new Set();
    const warnOnce = (key, msg) => {
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(msg);
    };

    const resolveNodeId = (raw) =>
        registry.validateNodeId(raw === undefined || raw === null ? env.LEGACY_NODE_ID : raw);

    const routingAll = () => {
        const state = stateManager.getState();
        const out = {};
        for (const e of registry.list()) {
            out[e.id] = routingService.evaluateRoutes(state, { source: e.id });
        }
        return out;
    };

    function pickSample(data) {
        const sample = {};
        for (const k of ['temp', 'humi', 'light', 'bat', 'rssi', 'motion']) {
            if (typeof data[k] === 'number') sample[k] = data[k];
        }
        return sample;
    }

    function handleUnknownNode(id, via, sample) {
        const result = registry.observeUnknown(id, via, sample);
        if (result === 'new') {
            console.log(`[Node] NodeID mới "${id}" (qua ${via}) đang chờ xác nhận trên web`);
            io.emit('pending_nodes', registry.listPending());
        } else if (result === 'full') {
            warnOnce('pending_full', '[Node] Hàng chờ đã đầy, bỏ qua NodeID lạ');
        }
    }

    function handleTelemetry(payloadStr) {
        try {
            const data = JSON.parse(payloadStr);
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('payload không phải object');
            }

            const v = resolveNodeId(data.nodeId);
            if (!v.ok) {
                warnOnce(`bad:${data.nodeId}`, `[Telemetry] NodeID không hợp lệ: ${v.message}`);
                return;
            }
            if (!registry.isRegistered(v.id)) {
                handleUnknownNode(v.id, 'telemetry', pickSample(data));
                return;
            }

            const { data: fields, ackOnly } = control.onDeviceMessage(v.id, data);
            if (ackOnly) return;

            const wasOnline = !!(stateManager.getNodeState(v.id) || {}).online;
            const { networkState, node, newRecord } = stateManager.updateNode(v.id, fields);
            const allRoutes = routingAll();

            // Giữ routingInfo cho nodeId (tương thích frontend cũ) + gửi kèm routing_update toàn mạng
            io.emit('state_update', {
                nodeId: v.id,
                currentState: networkState,
                routingInfo: allRoutes[v.id],
                newRecord,
            });
            io.emit('routing_update', allRoutes);

            alertService.checkTelemetryAlerts(node, control.getDesired(v.id), (ev, p) => io.emit(ev, p));

            if (!wasOnline) control.resync(v.id);
        } catch (e) {
            console.error('[Telemetry Parse Error]:', e.message);
        }
    }

    function parseCameraPayload(payloadStr) {
        try {
            const o = JSON.parse(payloadStr);
            if (o && typeof o === 'object' && !Array.isArray(o)) {
                return { rawId: o.nodeId, frame: o.frame ?? o.image ?? o.data };
            }
        } catch (e) { /* chuỗi base64 thô */ }
        return { rawId: undefined, frame: payloadStr };
    }

    function handleCamera(payloadStr) {
        const { rawId, frame } = parseCameraPayload(payloadStr);
        if (typeof frame !== 'string' || !frame) return;

        const v = resolveNodeId(rawId);
        if (!v.ok) {
            warnOnce(`bad:${rawId}`, `[Camera] NodeID không hợp lệ: ${v.message}`);
            return;
        }
        if (!registry.isRegistered(v.id)) {
            handleUnknownNode(v.id, 'camera', null);
            return;
        }

        imageStorage.saveFrame(v.id, frame);
        io.to(`cam:${v.id}`).emit('camera_frame', { nodeId: v.id, frame });
    }

    client.on('message', (topic, message) => {
        const payloadStr = message.toString();
        if (topic === FEEDS.TELEMETRY) handleTelemetry(payloadStr);
        else if (topic === FEEDS.CAMERA) handleCamera(payloadStr);
    });
}

module.exports = { registerMqttHandlers };
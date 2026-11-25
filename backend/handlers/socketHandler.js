const env = require('../config/env');
const adafruit = require('../config/adafruit');
const registry = require('../services/nodeRegistry');
const stateManager = require('../services/stateManager');
const controlService = require('../services/controlService');
const routingService = require('../services/routingService');
const mediaRepo = require('../repositories/mediaRepo');

module.exports = function registerSocketHandlers(io) {
    io.on('connection', (socket) => {
        let isAuthorized = !env.ADMIN_TOKEN;

        const requireAuth = (cb) => {
            if (!isAuthorized) {
                if (typeof cb === 'function') cb({ ok: false, error: 'Thiếu hoặc sai ADMIN_TOKEN' });
                return false;
            }
            return true;
        };

        const safe = (fn) => async (...args) => {
            try {
                await fn(...args);
            } catch (err) {
                console.error('[WebSocket] Lỗi xử lý sự kiện:', err);
                const last = args[args.length - 1];
                if (typeof last === 'function') last({ ok: false, error: err.message });
            }
        };

        // Gửi toàn bộ trạng thái khởi tạo khi client kết nối
        socket.emit('init_state', {
            authRequired: Boolean(env.ADMIN_TOKEN),
            authorized: isAuthorized,
            networkState: stateManager.getState(),
            pendingNodes: registry.listPending(),
            controlSchema: controlService.CONTROL_SCHEMA,
            controlLogs: controlService.getLogs(),
            links: routingService.defaultConfig.links,
            autoDirectToGateway: routingService.defaultConfig.autoDirectToGateway,
        });

        socket.on('auth', safe((token, cb) => {
            if (!env.ADMIN_TOKEN || token === env.ADMIN_TOKEN) {
                isAuthorized = true;
                if (typeof cb === 'function') cb({ ok: true });
            } else {
                isAuthorized = false;
                if (typeof cb === 'function') cb({ ok: false, error: 'Token quản trị không đúng' });
            }
        }));

        // Chọn một node để xem lịch sử InfluxDB, định tuyến và danh sách ảnh PostgreSQL
        socket.on('select_node', safe(async (nodeId, cb) => {
            const history = await stateManager.getHistory(nodeId, 50);
            const routing = routingService.evaluateRoutes(stateManager.getState(), { source: nodeId });
            const mediaList = await mediaRepo.listMedia(nodeId, 12);
            const desiredState = controlService.getDesiredState(nodeId);

            if (typeof cb === 'function') {
                cb({ ok: true, nodeId, history, routing, mediaList, desiredState });
            }
        }));

        // Quản lý phòng nhận luồng camera
        socket.on('join_camera', (nodeId) => {
            if (nodeId) socket.join(`cam:${nodeId}`);
        });

        socket.on('leave_camera', (nodeId) => {
            if (nodeId) socket.leave(`cam:${nodeId}`);
        });

        // Duyệt node mới từ hàng chờ -> lưu PostgreSQL
        socket.on('approve_node', safe(async ({ nodeId, name }, cb) => {
            if (!requireAuth(cb)) return;
            const entry = await registry.approve(nodeId, name);
            if (!entry) return cb && cb({ ok: false, error: 'nodeId không hợp lệ' });

            stateManager.registerNode(entry);
            io.emit('network_update', stateManager.getState());
            io.emit('pending_nodes', registry.listPending());
            if (typeof cb === 'function') cb({ ok: true, node: entry });
        }));

        // Thêm node thủ công -> lưu PostgreSQL
        socket.on('add_node', safe(async ({ nodeId, name }, cb) => {
            if (!requireAuth(cb)) return;
            const entry = await registry.addManual(nodeId, name);
            if (!entry) return cb && cb({ ok: false, error: 'nodeId không hợp lệ (chỉ dùng chữ, số, _, -)' });

            stateManager.registerNode(entry);
            io.emit('network_update', stateManager.getState());
            io.emit('pending_nodes', registry.listPending());
            if (typeof cb === 'function') cb({ ok: true, node: entry });
        }));

        // Đổi tên node
        socket.on('rename_node', safe(async ({ nodeId, name }, cb) => {
            if (!requireAuth(cb)) return;
            const updated = await registry.rename(nodeId, name);
            if (!updated) return cb && cb({ ok: false, error: 'Không thể đổi tên node' });

            stateManager.renameNode(nodeId, updated.name);
            io.emit('network_update', stateManager.getState());
            if (typeof cb === 'function') cb({ ok: true });
        }));

        // Xóa node
        socket.on('remove_node', safe(async (nodeId, cb) => {
            if (!requireAuth(cb)) return;
            await registry.remove(nodeId);
            stateManager.unregisterNode(nodeId);
            io.emit('network_update', stateManager.getState());
            io.emit('pending_nodes', registry.listPending());
            if (typeof cb === 'function') cb({ ok: true });
        }));

        // Điều khiển từ xa
        socket.on('send_control', safe(async ({ nodeId, command, params }, cb) => {
            if (!requireAuth(cb)) return;
            const result = await controlService.sendCommand(
                nodeId,
                command,
                params,
                adafruit.publishControl,
                (timeoutInfo) => {
                    io.emit('control_ack', timeoutInfo);
                    io.emit('control_logs', controlService.getLogs());
                }
            );
            if (result.ok) {
                io.emit('control_logs', controlService.getLogs());
            }
            if (typeof cb === 'function') cb(result);
        }));

        // Cập nhật sơ đồ liên kết mạng -> lưu PostgreSQL
        socket.on('update_links', safe(async ({ links }, cb) => {
            if (!requireAuth(cb)) return;
            const ok = await routingService.defaultConfig.setLinks(links);
            if (!ok) return cb && cb({ ok: false, error: 'Danh sách liên kết không hợp lệ' });

            io.emit('links_updated', routingService.defaultConfig.links);
            io.emit('network_update', stateManager.getState());
            if (typeof cb === 'function') cb({ ok: true, links: routingService.defaultConfig.links });
        }));

        // Bật/tắt chế độ tự động nối thẳng tới gateway
        socket.on('set_auto_direct', safe(async ({ enabled }, cb) => {
            if (!requireAuth(cb)) return;
            routingService.defaultConfig.autoDirectToGateway = Boolean(enabled);
            io.emit('network_update', stateManager.getState());
            if (typeof cb === 'function') cb({ ok: true, autoDirectToGateway: routingService.defaultConfig.autoDirectToGateway });
        }));

        // Giả lập thông số node để test định tuyến cân bằng tải
        socket.on('simulate_node', safe(async (payload, cb) => {
            if (!requireAuth(cb)) return;
            const { nodeId, ...patch } = payload || {};
            const res = stateManager.simulateNode(nodeId, patch);
            if (!res) return cb && cb({ ok: false, error: `Không tìm thấy node '${nodeId}'` });

            io.emit('network_update', res.networkState);
            if (typeof cb === 'function') cb({ ok: true, node: res.node });
        }));
    });
};

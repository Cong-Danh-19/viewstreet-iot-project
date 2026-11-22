const env = require('../config/env');
const registry = require('../services/nodeRegistry');
const stateManager = require('../services/stateManager');
const routingService = require('../services/routingService');
const { defaultConfig: routingConfig } = require('../services/routingService');
const imageStorage = require('../services/imageStorageService');

function buildNodeList() {
    const state = stateManager.getState();
    return registry.list().map((e) => ({
        id: e.id,
        name: e.name,
        source: e.source,
        addedAt: e.addedAt,
        online: !!(state[e.id] && state[e.id].online),
        lastSeen: state[e.id] ? state[e.id].lastSeen : null,
        packetCount: state[e.id] ? state[e.id].packetCount || 0 : 0,
    }));
}

function buildRoutingAll() {
    const state = stateManager.getState();
    const out = {};
    for (const e of registry.list()) {
        out[e.id] = routingService.evaluateRoutes(state, { source: e.id });
    }
    return out;
}

function registerSocketHandlers(io, { control }) {
    const camRoom = (id) => `cam:${id}`;
    const broadcastNodes = () => io.emit('node_list', buildNodeList());
    const broadcastPending = () => io.emit('pending_nodes', registry.listPending());
    const broadcastRouting = () => io.emit('routing_update', buildRoutingAll());

    io.on('connection', (socket) => {
        console.log('[WebSocket] Client kết nối:', socket.id);

        const isAdmin = !env.ADMIN_TOKEN || (socket.handshake.auth && socket.handshake.auth.token === env.ADMIN_TOKEN);

        const admin = (fn) => (payload, cb) => {
            const reply = typeof cb === 'function' ? cb : () => {};
            if (!isAdmin) return reply({ ok: false, error: 'unauthorized', message: 'Cần token quản trị.' });
            try {
                fn(payload && typeof payload === 'object' ? payload : {}, reply);
            } catch (e) {
                console.error('[WebSocket] Lỗi xử lý sự kiện:', e);
                reply({ ok: false, error: 'internal', message: 'Lỗi máy chủ.' });
            }
        };

        socket.emit('init_dashboard', {
            isAdmin,
            controlSchema: control.schema(),
            currentState: stateManager.getState(),
            routingInfo: buildRoutingAll(),
            links: routingConfig.links,
            nodes: buildNodeList(),
            pendingNodes: registry.listPending(),
        });

        socket.on('select_node', (payload, cb) => {
            const reply = typeof cb === 'function' ? cb : () => {};
            const id = payload && payload.nodeId;
            if (typeof id !== 'string' || !registry.isRegistered(id)) {
                return reply({ ok: false, error: 'not_found', message: 'Không tìm thấy node.' });
            }
            if (socket.data.selectedNode) socket.leave(camRoom(socket.data.selectedNode));
            socket.data.selectedNode = id;
            socket.join(camRoom(id));

            const allRoutes = buildRoutingAll();
            socket.emit('node_selected', {
                nodeId: id,
                state: stateManager.getNodeState(id),
                routingInfo: allRoutes[id],
                history: stateManager.getHistory(id),
                desired: control.getDesired(id),
                commands: control.getCommands(id),
            });
            if (imageStorage.hasLastFrame(id)) {
                socket.emit('camera_frame', { nodeId: id, frame: imageStorage.getLastFrame(id) });
            }
            reply({ ok: true });
        });

        socket.on('add_node', admin(({ nodeId, name }, reply) => {
            const r = registry.addManual(nodeId, name);
            if (r.ok) {
                stateManager.registerNode(r.node);
                broadcastNodes();
                broadcastPending();
                broadcastRouting();
            }
            reply(r);
        }));

        socket.on('approve_node', admin(({ nodeId, name }, reply) => {
            const r = registry.approve(nodeId, name);
            if (r.ok) {
                stateManager.registerNode(r.node);
                broadcastNodes();
                broadcastPending();
                broadcastRouting();
            }
            reply(r);
        }));

        socket.on('reject_node', admin(({ nodeId }, reply) => {
            const r = registry.reject(nodeId);
            if (r.ok) broadcastPending();
            reply(r);
        }));

        socket.on('rename_node', admin(({ nodeId, name }, reply) => {
            const r = registry.rename(nodeId, name);
            if (r.ok) {
                stateManager.renameNode(nodeId, r.node.name);
                broadcastNodes();
            }
            reply(r);
        }));

        socket.on('remove_node', admin(({ nodeId }, reply) => {
            const r = registry.remove(nodeId);
            if (r.ok) {
                stateManager.unregisterNode(nodeId);
                control.forget(nodeId);
                imageStorage.forgetNode(nodeId);
                io.in(camRoom(nodeId)).emit('node_removed', { nodeId });
                io.in(camRoom(nodeId)).socketsLeave(camRoom(nodeId));
                broadcastNodes();
                broadcastRouting();
            }
            reply(r);
        }));

        socket.on('cmd_hardware', admin((payload, reply) => {
            const targetId = payload.nodeId || socket.data.selectedNode;
            const r = control.send(targetId, payload);
            if (r.ok) console.log(`[Control] ${targetId}: ${payload.command} ${JSON.stringify(payload.value)} (cmd ${r.cmdId})`);
            reply(r);
        }));

        // Giả lập lỗi/tải để test cân bằng tải: { nodeId, online?, bat?, load?, rssi? }
        socket.on('simulate_node', admin((payload, reply) => {
            const targetId = payload.nodeId || socket.data.selectedNode;
            if (!registry.isRegistered(targetId)) {
                return reply({ ok: false, error: 'not_found', message: 'Không tìm thấy node.' });
            }
            const res = stateManager.simulateNode(targetId, payload);
            const allRoutes = buildRoutingAll();

            broadcastNodes();
            io.emit('state_update', {
                nodeId: targetId,
                currentState: res.networkState,
                routingInfo: allRoutes[targetId],
                newRecord: stateManager.getHistory(targetId).slice(-1)[0] || res.node,
            });
            io.emit('routing_update', allRoutes);
            reply({ ok: true, node: res.node, routing: allRoutes });
        }));

        // Cập nhật danh sách liên kết trung gian giữa các node: { links: [['cam_03', 'cam_005'], ...] }
        socket.on('update_links', admin(({ links }, reply) => {
            if (!routingConfig.setLinks(links)) {
                return reply({ ok: false, error: 'invalid_links', message: 'Danh sách liên kết không hợp lệ.' });
            }
            broadcastRouting();
            reply({ ok: true, links: routingConfig.links });
        }));
    });

    return { buildNodeList, buildRoutingAll };
}

module.exports = { registerSocketHandlers, buildNodeList, buildRoutingAll };
const defaultConfig = require('./routingService.config');

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Chất lượng liên kết [0,1] từ RSSI (dBm). Chấp nhận cả dạng âm (-70) lẫn độ lớn (70). */
function rssiQuality(rssi, cfg) {
    const dbm = -Math.abs(num(rssi, cfg.defaults.rssi));
    return clamp01((dbm - cfg.rssi.bad) / (cfg.rssi.good - cfg.rssi.bad));
}

/**
 * Cost của MỘT đoạn tới `node` (node nhận). Giữ chữ ký cũ để tương thích:
 * calculateCost(node, hops) vẫn dùng được; hops mặc định 1 = một đoạn.
 * `rssi` là RSSI của liên kết (mặc định lấy node.rssi).
 */
function calculateCost(node, hops = 1, { config = defaultConfig, rssi, isGateway = false } = {}) {
    const w = config.weights;
    const n = node || {};
    const quality = rssiQuality(rssi !== undefined ? rssi : n.rssi, config);
    const pinNorm = clamp01(num(n.bat, config.defaults.bat) / 100);
    const loadNorm = clamp01(num(n.load, config.defaults.load) / 100);

    const cost = w.hop * hops
        + (isGateway ? 0 : w.battery * (1 - pinNorm))
        + w.rssi * (1 - quality)
        + (isGateway ? 0 : w.load * loadNorm);
    return Math.round(cost * 1000) / 1000;
}

/** Dựng đồ thị có trọng số từ state; bỏ node offline và các node trong `excluded`. */
function buildGraph(state, config, excluded = new Set()) {
    const gw = config.gateway;
    const alive = (id) => id === gw || (state[id] && state[id].online && !excluded.has(id));
    const graph = new Map();
    for (const [from, to] of config.links) {
        if (!alive(from) || !alive(to) || from === gw) continue;
        const linkRssi = state.links && state.links[`${from}->${to}`]
            ? state.links[`${from}->${to}`].rssi
            : undefined;
        const rssi = linkRssi !== undefined ? linkRssi : state[from].rssi;
        const weight = calculateCost(to === gw ? {} : state[to], 1, {
            config, rssi, isGateway: to === gw,
        });
        if (!graph.has(from)) graph.set(from, []);
        graph.get(from).push({ to, weight });
    }
    return graph;
}

/** Dijkstra (đồ thị nhỏ nên dùng quét tuyến tính thay vì heap). */
function dijkstra(graph, source, target) {
    const dist = new Map([[source, 0]]);
    const prev = new Map();
    const done = new Set();

    while (true) {
        let u = null;
        for (const [id, d] of dist) {
            if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
        }
        if (u === null) break;
        if (u === target) break;
        done.add(u);
        for (const { to, weight } of graph.get(u) || []) {
            const nd = dist.get(u) + weight;
            if (!dist.has(to) || nd < dist.get(to)) {
                dist.set(to, nd);
                prev.set(to, u);
            }
        }
    }

    if (!dist.has(target)) return { cost: Infinity, path: [] };
    const path = [target];
    while (path[0] !== source) path.unshift(prev.get(path[0]));
    return { cost: dist.get(target), path };
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/**
 * Đánh giá tuyến từ `source` tới gateway.
 * Trả về:
 *  - optimalPath / totalCost / optimalRoute: tuyến tốt nhất
 *  - alternatives: tốt nhất theo từng hop đầu tiên (để so sánh, hiển thị dashboard)
 *  - costViaNode2 / costViaNode3: giữ lại để tương thích code cũ
 */
function evaluateRoutes(state, { source = 'node_1', config = defaultConfig } = {}) {
    const gw = config.gateway;
    const unreachable = config.unreachableCost;
    const empty = {
        optimalPath: [], totalCost: unreachable, alternatives: [],
        costViaNode2: unreachable, costViaNode3: unreachable,
    };

    if (!state[source] || !state[source].online) {
        return { ...empty, optimalRoute: `${source} đang ngoại tuyến (Offline)` };
    }

    // Với mỗi hop đầu tiên, tìm đường tốt nhất tới gateway mà không quay lại nguồn
    const first = buildGraph(state, config).get(source) || [];
    const alternatives = first.map(({ to, weight }) => {
        if (to === gw) return { via: to, path: [source, gw], cost: weight };
        const rest = dijkstra(buildGraph(state, config, new Set([source])), to, gw);
        return {
            via: to,
            path: rest.path.length ? [source, ...rest.path] : [],
            cost: weight + rest.cost,
        };
    }).filter((r) => Number.isFinite(r.cost))
      .sort((x, y) => x.cost - y.cost)
      .map((r) => ({ ...r, cost: round(r.cost) }));

    const best = alternatives[0];
    const viaCost = (id) => {
        const r = alternatives.find((x) => x.via === id);
        return r ? r.cost : unreachable;
    };

    if (!best) {
        return { ...empty, optimalRoute: `${source}: không có đường tới gateway` };
    }
    return {
        optimalPath: best.path,
        totalCost: best.cost,
        alternatives,
        costViaNode2: viaCost('node_2'),
        costViaNode3: viaCost('node_3'),
        optimalRoute: best.path.join(' -> '),
    };
}

module.exports = { calculateCost, evaluateRoutes, dijkstra, buildGraph, rssiQuality };
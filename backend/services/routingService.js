/**
 * Công thức Cost: Cost = a*Hop + b*(1 - Pin) + c*(1 - RSSI) + d*Load
 */
function calculateCost(node, hops = 1) {
    const a = 1.0, b = 2.0, c = 1.5, d = 1.0;
    const pinNorm = (node.bat || 0) / 100.0;
    const rssiNorm = Math.abs(node.rssi || 50) / 100.0;
    const loadNorm = (node.load || 0) / 100.0;
    const cost = (a * hops) + (b * (1 - pinNorm)) + (c * rssiNorm) + (d * loadNorm);
    return parseFloat(cost.toFixed(2));
}

function evaluateRoutes(state) {
    // Đánh giá tuyến đường từ Node 1 thực tế trực tiếp tới Gateway
    const node1 = state.node_1;
    const cost = node1 && node1.online ? calculateCost(node1, 1) : 999;
    const optimalRoute = node1 && node1.online 
        ? "Node 1 -> Gateway (Kết nối trực tiếp ổn định)" 
        : "Node 1 đang ngoại tuyến (Offline)";

    return { 
        costViaNode2: cost, 
        costViaNode3: 999, 
        optimalRoute 
    };
}

module.exports = { calculateCost, evaluateRoutes };
/**
 * Công thức Cost: Cost = a*Hop + b*(1 - Pin) + c*(1 - RSSI) + d*Load
 */
function calculateCost(node, hops = 1) {
    const a = 1.0, b = 2.0, c = 1.5, d = 1.0;
    const pinNorm = node.bat / 100.0;
    const rssiNorm = Math.abs(node.rssi) / 100.0;
    const loadNorm = node.load / 100.0;

    const cost = (a * hops) + (b * (1 - pinNorm)) + (c * rssiNorm) + (d * loadNorm);
    return parseFloat(cost.toFixed(2));
}

function evaluateRoutes(state) {
    // Đánh giá tuyến đường từ Node 1 qua Node 2 hoặc Node 3
    const costViaNode2 = state.node_2.online ? calculateCost(state.node_2, 1) : 999;
    const costViaNode3 = state.node_3.online ? calculateCost(state.node_3, 1) : 999;

    let optimalRoute = "Node 1 -> Node 2 -> Gateway";
    if (costViaNode2 > costViaNode3) {
        optimalRoute = "Node 1 -> Node 3 -> Node 4 -> Gateway (Tự động chuyển tuyến do Node 2 quá tải/lỗi)";
    }
    return { costViaNode2, costViaNode3, optimalRoute };
}

module.exports = { calculateCost, evaluateRoutes };

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Tự động tạo thư mục 'data' và file 'history.json' nếu chưa tồn tại
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2), 'utf8');
}

// Trạng thái hệ thống (tập trung vào thiết bị thật Node 1)
let networkState = {
    node_1: { 
        id: 'Node 1 (Real)', 
        temp: 0, 
        humi: 0, 
        light: 0, 
        motion: 0, 
        bat: 0, 
        mode: 'NORMAL', 
        ledLevel: 0, 
        error: 'Đang chờ thiết bị...', 
        online: false, 
        rssi: -50, 
        load: 0 
    }
};

// Đọc danh sách lịch sử từ file JSON
function getHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return [];
    }
}

// Thêm bản ghi mới vào tệp lịch sử (giới hạn tối đa 50 bản ghi gần nhất)
function appendHistory(data) {
    const history = getHistory();
    const record = {
        time: new Date().toLocaleTimeString('vi-VN'),
        date: new Date().toLocaleDateString('vi-VN'),
        temp: data.temp,
        humi: data.humi,
        light: data.light,
        bat: data.bat,
        motion: data.motion,
        error: data.error || 'OK'
    };
    
    history.push(record);
    if (history.length > 50) history.shift(); // Giữ tối đa 50 dòng để tối ưu dung lượng file
    
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    return record;
}

function getState() {
    return networkState;
}

// Cập nhật dữ liệu thật từ Node 1 và tự động ghi log lịch sử
function updateNode1(newData) {
    networkState.node_1 = { ...networkState.node_1, ...newData, online: true };
    const newRecord = appendHistory(networkState.node_1);
    return { networkState, newRecord };
}

module.exports = { getState, getHistory, updateNode1 };
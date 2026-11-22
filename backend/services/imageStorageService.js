const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const IMAGES_DIR = path.join(env.DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const lastFrames = new Map(); // nodeId -> chuỗi base64 gần nhất

function saveFrame(nodeId, frameStr) {
    lastFrames.set(nodeId, frameStr);

    try {
        const cleanBase64 = frameStr.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(cleanBase64, 'base64');
        if (!buf.length) return;

        const nodeDir = path.join(IMAGES_DIR, nodeId);
        fs.mkdirSync(nodeDir, { recursive: true });

        const filename = `${Date.now()}.jpg`;
        fs.writeFileSync(path.join(nodeDir, filename), buf);

        // Xóa bớt ảnh cũ nếu vượt quá giới hạn MAX_IMAGES_PER_NODE
        const files = fs.readdirSync(nodeDir).filter((f) => f.endsWith('.jpg')).sort();
        while (files.length > env.MAX_IMAGES_PER_NODE) {
            const oldest = files.shift();
            fs.unlinkSync(path.join(nodeDir, oldest));
        }
    } catch (e) {
        console.error(`[ImageStorage] Lỗi lưu ảnh cho ${nodeId}:`, e.message);
    }
}

const getLastFrame = (nodeId) => lastFrames.get(nodeId) || null;
const hasLastFrame = (nodeId) => lastFrames.has(nodeId);
const forgetNode = (nodeId) => lastFrames.delete(nodeId);

module.exports = { saveFrame, getLastFrame, hasLastFrame, forgetNode };
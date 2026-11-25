const express = require('express');
const mediaRepo = require('../repositories/mediaRepo');
const registry = require('../services/nodeRegistry');
const stateManager = require('../services/stateManager');

const mjpegClients = new Map(); // nodeId -> Set<Response>

function broadcastMjpegFrame(nodeId, jpegBuffer) {
    const clients = mjpegClients.get(nodeId);
    if (!clients || clients.size === 0) return;

    const header =
        `--frame
` +
        `Content-Type: image/jpeg
` +
        `Content-Length: ${jpegBuffer.length}

`;

    for (const res of clients) {
        if (!res.writableEnded) {
            res.write(header);
            res.write(jpegBuffer);
            res.write('\r\n');
        }
    }
}

module.exports = function createCameraRoutes(io) {
    const router = express.Router();

    const rawMediaParser = express.raw({
        type: ['image/jpeg', 'image/png', 'video/mp4', 'application/octet-stream'],
        limit: '15mb',
    });

    /**
     * POST /api/camera/upload?nodeId=node_1&type=image|video
     * Nhận ảnh JPEG/PNG hoặc video MP4 trực tiếp qua HTTP từ ESP32-CAM
     */
    router.post('/upload', rawMediaParser, async (req, res) => {
        try {
            const nodeId = String(
                req.headers['x-node-id'] ||
                req.query.nodeId ||
                (req.body && !Buffer.isBuffer(req.body) ? req.body.nodeId : '') ||
                ''
            ).trim();

            if (!nodeId || !registry.isValidId(nodeId)) {
                return res.status(400).json({ ok: false, error: 'Thiếu hoặc sai định dạng nodeId' });
            }

            if (!registry.isRegistered(nodeId)) {
                await registry.recordPending(nodeId, 'http_camera');
                if (io) io.emit('pending_nodes', registry.listPending());
                return res.status(202).json({
                    ok: false,
                    error: `Node '${nodeId}' chưa được duyệt, đã đưa vào hàng chờ trong PostgreSQL`,
                });
            }

            const contentType = req.headers['content-type'] || 'image/jpeg';
            const mediaType = req.query.type === 'video' || contentType.startsWith('video/')
                ? 'video'
                : 'image';

            let buffer = null;
            let resolvedMime = contentType.split(';')[0].trim();

            if (Buffer.isBuffer(req.body) && req.body.length > 0) {
                buffer = req.body;
            } else if (req.body && typeof req.body.image === 'string') {
                const match = req.body.image.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    resolvedMime = match[1];
                    buffer = Buffer.from(match[2], 'base64');
                } else {
                    resolvedMime = 'image/jpeg';
                    buffer = Buffer.from(req.body.image, 'base64');
                }
            }

            if (!buffer || buffer.length === 0) {
                return res.status(400).json({ ok: false, error: 'Dữ liệu hình ảnh/video trống' });
            }

            const saved = await mediaRepo.saveMedia(nodeId, buffer, {
                mediaType,
                mimeType: resolvedMime,
            });

            const networkState = stateManager.touchOnline(nodeId);
            if (networkState && io) {
                io.emit('network_update', networkState);
            }

            if (mediaType === 'image') {
                broadcastMjpegFrame(nodeId, buffer);
                if (io) {
                    io.to(`cam:${nodeId}`).emit('camera_frame', {
                        id: saved.id,
                        nodeId,
                        mediaType,
                        mimeType: resolvedMime,
                        image: `data:${resolvedMime};base64,${buffer.toString('base64')}`,
                        ts: saved.ts,
                        sizeBytes: saved.sizeBytes,
                    });
                }
            } else if (io) {
                io.to(`cam:${nodeId}`).emit('camera_video_uploaded', saved);
            }

            return res.json({ ok: true, ...saved });
        } catch (err) {
            console.error('[HTTP Camera] Lỗi upload:', err);
            return res.status(500).json({ ok: false, error: 'Lỗi lưu media vào PostgreSQL' });
        }
    });

    /**
     * GET /api/camera/:nodeId/stream
     * Luồng video HTTP MJPEG trực tiếp
     */
    router.get('/:nodeId/stream', (req, res) => {
        const { nodeId } = req.params;
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
        });

        if (!mjpegClients.has(nodeId)) mjpegClients.set(nodeId, new Set());
        mjpegClients.get(nodeId).add(res);

        req.on('close', () => {
            const set = mjpegClients.get(nodeId);
            if (set) set.delete(res);
        });
    });

    /**
     * GET /api/camera/:nodeId/latest
     * Lấy khung hình/video mới nhất từ PostgreSQL
     */
    router.get('/:nodeId/latest', async (req, res) => {
        try {
            const media = await mediaRepo.getLatestMedia(req.params.nodeId);
            if (!media) return res.status(404).json({ ok: false, error: 'Chưa có dữ liệu camera trong DB' });

            res.setHeader('Content-Type', media.mime_type);
            res.setHeader('Cache-Control', 'no-store');
            return res.send(media.binary_data);
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    /**
     * GET /api/camera/:nodeId/history?limit=20
     * Lấy danh sách lịch sử ảnh/video lưu trong PostgreSQL
     */
    router.get('/:nodeId/history', async (req, res) => {
        try {
            const items = await mediaRepo.listMedia(req.params.nodeId, req.query.limit);
            return res.json({ ok: true, count: items.length, items });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    /**
     * GET /api/camera/media/:id
     * Xem trực tiếp ảnh/video theo ID trong PostgreSQL
     */
    router.get('/media/:id', async (req, res) => {
        try {
            const media = await mediaRepo.getMediaById(Number(req.params.id));
            if (!media) return res.status(404).json({ ok: false, error: 'Không tìm thấy bản ghi' });

            res.setHeader('Content-Type', media.mime_type);
            return res.send(media.binary_data);
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
};

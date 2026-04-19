const { Plugin } = require('../../../js/core/plugin-base.js');
const { Events } = require('../../../js/core/events.js');
const WebSocket = require('ws');

class RemoteSyncPlugin extends Plugin {
    async onInit() {
        const config = this.context.getPluginConfig();
        this.port = config.port || 8080;
        this.password = config.password || 'admin';
        this.clients = new Set();
        
        this.startServer();
        this.setupEventListeners();
    }

    startServer() {
        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`[RemoteSync] WebSocket server started on port ${this.port}`);

        this.wss.on('connection', (ws) => {
            ws.isAlive = true;
            ws.authenticated = false;

            ws.on('pong', () => { ws.isAlive = true; });

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleClientMessage(ws, data);
                } catch (e) {
                    console.error('[RemoteSync] Failed to parse message:', e);
                }
            });

            ws.on('close', () => {
                this.clients.delete(ws);
            });
        });

        // 心跳检测
        this.heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    async handleClientMessage(ws, data) {
        // 鉴权
        if (data.type === 'auth') {
            if (data.password === this.password) {
                ws.authenticated = true;
                this.clients.add(ws);
                ws.send(JSON.stringify({ type: 'auth_success' }));
                console.log('[RemoteSync] Client authenticated');
            } else {
                ws.send(JSON.stringify({ type: 'auth_failed' }));
            }
            return;
        }

        if (!ws.authenticated) return;

        // 处理输入
        switch (data.type) {
            case 'text_input':
                console.log('[RemoteSync] Received text input:', data.text);
                await this.context.sendMessage(data.text);
                break;
            case 'audio_input':
                // 接收音频数据并处理
                if (data.audio) {
                    const audioBuffer = Buffer.from(data.audio, 'base64');
                    
                    // 使用 fetch 调用本地 ASR 服务
                    try {
                        const formData = new FormData();
                        // 将 buffer 转换为 blob
                        const blob = new Blob([audioBuffer], { type: 'audio/webm' });
                        formData.append('file', blob, 'recording.webm');

                        const response = await fetch('http://127.0.0.1:1000/v1/upload_audio', {
                            method: 'POST',
                            body: formData
                        });

                        if (response.ok) {
                            const result = await response.json();
                            if (result.text) {
                                await this.context.sendMessage(result.text);
                            }
                        } else {
                            console.error('[RemoteSync] ASR service error:', response.statusText);
                        }
                    } catch (err) {
                        console.error('[RemoteSync] Failed to call ASR service:', err);
                    }
                } else if (data.text) {
                    await this.context.sendMessage(data.text);
                }
                break;
        }
    }

    setupEventListeners() {
        // 监听 TTS 开始，同步音频和文本
        this.context.on(Events.TTS_START, async (data) => {
            let audioBase64 = null;
            if (data.audioBlob) {
                const buffer = await data.audioBlob.arrayBuffer();
                audioBase64 = Buffer.from(buffer).toString('base64');
            }
            this.broadcast({
                type: 'tts_start',
                text: data.text,
                audio: audioBase64
            });
        });

        // 监听 Live2D 动作
        this.context.on(Events.MODEL_MOTION, (data) => {
            this.broadcast({
                type: 'model_motion',
                group: data.group,
                index: data.index
            });
        });

        // 监听 Live2D 表情
        this.context.on(Events.MODEL_EXPRESSION, (data) => {
            this.broadcast({
                type: 'model_expression',
                id: data.id
            });
        });

        // 监听字幕显示
        this.context.on(Events.SUBTITLE_SHOW, (data) => {
            this.broadcast({
                type: 'subtitle_show',
                text: data.text,
                duration: data.duration
            });
        });
    }

    broadcast(data) {
        const message = JSON.stringify(data);
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    async onStop() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = RemoteSyncPlugin;

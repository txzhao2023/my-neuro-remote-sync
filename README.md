# My-Neuro 远程同步插件部署指南

访问：https://你的域名
debug：https://你的域名/?debug=1

教程视频：链接: https://yun.139.com/shareweb/#/w/i/2ur52qv7gHw9h

欢迎大佬们使用和自由修改！

为了实现这个插件的功能，您需要：

1. **VPS** (本文以 GCP VPS 为例，也就是Google的小机，国内的 *域名* 注意备案)
2. **自己的域名**（视频以 netcup 域名为例）
3. **一台能够运行 my-neuro 的电脑** (Windows PC，云端的没试过)
4. **善用 AI 工具**（包括但不限于 VSCode 的 Roocode）

---

## 🏗️ 架构核心逻辑

```
┌─────────────────────────────────────────────────────────────┐
│                     互联网 (Internet)                        │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS (443)
                         ▼
        ┌────────────────────────────────┐
        │   GCP VPS (云服务器)            │
        │  - Nginx 反向代理               │
        │  - 前端网页托管                 │
        │  - Live2D 模型文件              │
        │  - SSL 证书                     │
        └────────────────────────────────┘
                         │
                         │ FRP 穿透 (TCP 7000)
                         ▼
        ┌────────────────────────────────┐
        │   本地 Windows PC (肥牛)         │
        │  - AI 模型推理                  │
        │  - TTS/ASR 处理                 │
        │  - WebSocket 服务 (8080)        │
        └────────────────────────────────┘
```

**核心组件**：
- **云服务器**：负责抗住外网访问、提供安全的 HTTPS 链接、托管网页前端界面和 Live2D 模型文件
- **本地电脑 (Windows PC)**：真正的算力核心，跑动 AI 模型、提供语音/文字逻辑响应
- **FRP 内网穿透**：一条隐形的网线，把云服务器和您家里的电脑连在一起

> **前提条件**：修改 [`js/voice/tts-playback-engine.js`](../../js/voice/tts-playback-engine.js) 的第 78 行eventBus.emit(Events.TTS_START);为：
> ```javascript
> eventBus.emit(Events.TTS_START, { text: segmentText, audioBlob: audioBlob });
> ```

---

## 🌐 第一阶段：云端基建与网络打通

### 1. DNS 域名解析

**操作**：在域名服务商处，将您的主域名（如 `@` 和 `www`）的 A 记录，指向您 GCP 云服务器的公网 IP。

**避坑点**：
- 如果您使用了邮件转发服务（如 Forward Email），千万不要把主域名的 A 记录指到邮件服务器的 IP 上，否则会导致后续申请证书超时
- 主域名的 IP 必须且只能是您跑 Nginx 那台服务器的 IP

### 2. GCP 防火墙配置（至关重要）

如果端口没开，后面的一切都是白搭。

**操作**：进入 GCP 控制台 → VPC → 防火墙

**需要开放的端口**（全部为入站 Ingress，来源 `0.0.0.0/0`）：

| 端口 | 协议 | 用途 |
|------|------|------|
| TCP 22 | SSH | 远程登录服务器 |
| TCP 80 | HTTP | Let's Encrypt 证书验证 |
| TCP 443 | HTTPS | 网页访问 |
| TCP 7000 | TCP | FRP 客户端连接 |

### 3. 安装 Nginx 和 SSL 工具

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx -y
```

### 4. 申请 SSL 安全证书

**命令**：
```bash
sudo certbot --nginx -d 你的域名
# 例如：sudo certbot --nginx -d feiniu.com
```

**什么时候用**：当您的域名已经成功解析到服务器 IP（这个过程可能需要至少半小时的等待时间，运气好的话 30s 也行），且 80 端口已在 GCP 放行后使用。

**⚠️ 避坑点**：
- 如果提示 *Timeout during connect*，99% 是因为 GCP 的防火墙 80 端口没开，或者 DNS 还没生效
- 可以用 `nslookup 你的域名` 检查 DNS 是否生效

---

## 🌉 第二阶段：搭建 FRP 内网穿透桥梁

### 1. 云服务器端 (frps)

**下载与解压**：Linux x86_64 架构对应的后缀是 `linux_amd64`

```bash
cd ~
wget https://github.com/fatedier/frp/releases/download/v0.56.0/frp_0.56.0_linux_amd64.tar.gz
tar -zxvf frp_0.56.0_linux_amd64.tar.gz
cd frp_0.56.0_linux_amd64
```

**配置 frps.ini**：

```ini
[common]
bind_port = 7000
```

**后台运行配置 (Systemd)**：

```bash
sudo nano /etc/systemd/system/frps.service
```

填入配置（注意将 `laozhao` 替换为您真实的用户名）：

```ini
[Unit]
Description=FRP Server Service
After=network.target

[Service]
Type=simple
User=laozhao
Restart=on-failure
RestartSec=5s
ExecStart=/home/laozhao/frp_0.56.0_linux_amd64/frps -c /home/laozhao/frp_0.56.0_linux_amd64/frps.ini

[Install]
WantedBy=multi-user.target
```

**服务控制命令**：

```bash
sudo systemctl daemon-reload  # 修改了上面的文件后必须执行一次
sudo systemctl enable frps     # 设置开机自启，必做
sudo systemctl start frps      # 启动服务
sudo systemctl status frps     # 查看是否是绿色 running
```

### 2. 本地电脑端 (frpc)

**下载 FRP**：从 [GitHub Releases](https://github.com/fatedier/frp/releases) 下载 Windows 版本 (`frp_0.56.0_windows_amd64.zip`)

**配置 frpc.ini**：

```ini
[common]
server_addr = 您的GCP公网IP
server_port = 7000

[live2d_ws]
type = tcp
local_ip = 127.0.0.1
local_port = 8080
remote_port = 8081
```

**运行命令**：在 Windows 命令行中输入

```cmd
frpc.exe -c frpc.ini
```

看到 *start proxy success* 即代表穿透成功。如果报 *i/o timeout*，去检查：
- 云服务器的 frps 是否在运行：`sudo systemctl status frps`
- GCP 的 7000 端口是否放行

---

## 🚦 第三阶段：Nginx 流量调度中枢

这是整个系统最容易出错的地方。

**避坑点**：不要使用 nano 编辑器去粘贴大段代码，极容易造成大括号错乱和旧代码残留。

**一键配置 (使用 tee)**：在终端直接复制并执行整段命令，这会推平旧文件并写入最干净的配置：

```bash
sudo tee /etc/nginx/sites-available/default > /dev/null << 'EOF'
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    # 1. 网页前端目录
    location / {
        root /var/www/live2d;
        index index.html;
        autoindex off;
    }

    # 2. WebSocket AI 指令通道 (转发到 FRP 8081)
    location /ws {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

server {
    listen 80;
    server_name 你的域名;
    return 301 https://$host$request_uri;
}
EOF
```

**Nginx 调试**：
- 每次修改完必须执行：`sudo nginx -t`。如果报错，看提示的行数
- 如果显示 successful，执行热重载生效：`sudo systemctl reload nginx`
- 如果提示 not active，说明 Nginx 之前崩溃了，需要冷启动：`sudo systemctl start nginx`

---

## 📱 第四阶段：前端界面部署与模型文件上传

### 1. 准备前端文件

**修改 index.html**：修改该文件的 133 行的 `'肥牛2.3.model3.json'` 为你的目标皮套，纹理大小建议 2048 及以下，否则 iOS 系统可能因为内存溢出强制刷新。

```html
<input type="text" id="model-path" placeholder="Model JSON Path" value="./肥牛2.3.model3.json">
```

### 2. 创建 VPS 目录结构

在 GCP SSH 中执行：

```bash
sudo mkdir -p /var/www/live2d
sudo chown -R $USER:$USER /var/www/live2d
```

### 3. 上传文件到 VPS

通过 GCP SSH 页面右上角的"上传文件"功能，上传以下内容到 `~` 目录：

1. **前端文件**：`plugins/community/remote-sync/web/index.html`
2. **库文件**：整个 `libs` 文件夹（包含 PIXI.js、Live2D 库等）
3. **模型文件**：您的 Live2D 模型文件夹（例如 `2D/肥牛v2.3/` 中的所有文件）

### 4. 移动文件到正确位置

在 GCP SSH 中执行：

```bash
# 移动前端文件
mv ~/index.html /var/www/live2d/

# 移动库文件
mv ~/libs /var/www/live2d/

# 移动模型文件（假设模型文件夹名为 model）
mv ~/肥牛2.3.* /var/www/live2d/
mv ~/肥牛2.3 /var/www/live2d/
```

### 5. 验证文件结构

执行以下命令检查文件是否正确上传：

```bash
ls -la /var/www/live2d/
```

应该看到类似的结构：

```
/var/www/live2d/
├── index.html
├── libs/
│   ├── pixi.min.js
│   ├── live2d.min.js
│   ├── live2dcubismcore.min.js
│   └── pixi-live2d-display.min.js
├── 肥牛2.3.model3.json
├── 肥牛2.3.moc3
├── 肥牛2.3.physics3.json
└── 肥牛2.3.16384/
    └── texture_00.png
```

---

## 🍴 启动顺序

1. **启动 VPS 的 FRP 服务**：
   ```bash
   sudo systemctl start frps
   ```

2. **启动本地 PC 的 FRP 客户端（注意要在frp.exe的文件夹里面启动cmd）**：
   ```cmd
   frpc.exe -c frpc.ini
   ```

3. **启动 PC 端的肥牛主程序**

4. **访问网页**：在浏览器中打开 `https://你的域名`

---

## 🔐 安全配置

**⚠️ 默认密码为 `admin`，一定要自行修改！！！**

### 修改插件密码

1. 打开 [`plugins/community/remote-sync/index.js`](./index.js)
2. 修改第 9 行的 `'admin'` 为您的自定义密码
3. 或者修改 [`plugins/community/remote-sync/metadata.json`](./metadata.json) 中的 `password` 字段

### 启用插件

1. 将 `plugins/community/remote-sync` 文件夹放入项目的插件目录
2. 确保 PC 端安装了 `ws` 依赖：
   ```bash
   npm install ws
   ```
3. 重启肥牛主程序

---

## 🛠️ 故障排查

### 问题 1：无法连接到 WebSocket

**症状**：页面显示 "WebSocket 已断开"

**排查步骤**：
1. 检查 FRP 客户端是否运行：`frpc.exe -c frpc.ini`
2. 检查 FRP 服务端是否运行：`sudo systemctl status frps`
3. 检查 GCP 防火墙 7000 端口是否开放
4. 检查 Nginx 配置是否正确：`sudo nginx -t`

### 问题 2：模型加载失败 (404)

**症状**：页面显示 "❌ 模型加载失败"

**排查步骤**：
1. 检查文件是否上传到 `/var/www/live2d/`：
   ```bash
   ls -la /var/www/live2d/
   ```
2. 检查文件权限：
   ```bash
   sudo chown -R www-data:www-data /var/www/live2d
   ```
3. 检查 Nginx 日志：
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

### 问题 3：iOS 页面频繁刷新

**症状**：在 iPhone/iPad 上打开页面后不断刷新

**原因**：通常是内存溢出或纹理过大

**解决方案**：
1. 确保模型纹理大小 ≤ 2048px
2. 在 `index.html` 第 133 行修改模型路径为更小的模型
3. 清除浏览器缓存后重试

### 问题 4：音频无法播放

**症状**：TTS 消息收到但没有声音

**排查步骤**：
1. 检查浏览器是否允许音频自动播放
2. 尝试点击页面任意位置以解锁音频
3. 检查浏览器控制台是否有错误信息（按 F12）

---

## 🛠️ Linux 常用文件操作 Cheat Sheet

### 查看文件

```bash
ls                    # 简单查看
ls -la                # 查看详细信息包含隐藏文件（最常用）
cat 文件名            # 查看文件内容
```

### 修改需要权限的文件

前面必须加 `sudo`，否则报 *Permission denied*

```bash
sudo nano 文件名      # 编辑文件
sudo chown user:group 文件名  # 修改所有者
```

### 移动/重命名文件

```bash
sudo mv 源文件 目标位置/    # 切记末尾加斜杠 /，代表放入文件夹而不是重命名
sudo mv 旧名.json 新名.json # 重命名
```

### 批量移动（通配符 *）

```bash
sudo mv 肥牛* /var/www/live2d/     # 把所有"肥牛"开头的文件移走
sudo mv *.json /var/www/live2d/    # 把所有 json 文件移走
```

### 删除文件

```bash
sudo rm 坏掉的文件名           # 删除单文件
sudo rm -rf 文件夹名/          # 彻底删除整个文件夹及里面的内容（极其危险，慎用）
```

### 查看磁盘空间

```bash
df -h                 # 查看磁盘使用情况
du -sh /var/www/live2d/  # 查看特定目录大小
```

---

## 📞 获取帮助

如果遇到问题，请：

1. 检查 Nginx 和 FRP 的日志文件
2. 使用 AI 工具（如 VSCode Roocode）辅助诊断

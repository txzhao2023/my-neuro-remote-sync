# My-Neuro 远程同步插件部署指南 (Remote Sync)

为了实现这个插件的功能，您需要：
1. **VPS** (本文以 GCP VPS 为例，国内的 VPS 注意备案)
2. **自己的域名**（本文以 netcup 域名为例）
3. **一台能够运行 my-neuro 的电脑**
4. **善用AI工具，包括但不限于vscode的roocode**。
---

## 🏗️ 架构核心逻辑
*   **云服务器**：负责抗住外网访问、提供安全的 HTTPS 链接、托管网页前端界面。
*   **本地电脑 (Windows PC)**：真正的算力核心。跑动 AI 模型、提供语音/文字逻辑响应、存放 Live2D 动画。
*   **FRP 内网穿透**：一条隐形的网线，把云服务器和您家里的电脑连在一起。

> **前提：** 修改 `js/voice/tts-playback-engine.js` 的第 78 行为：
> `eventBus.emit(Events.TTS_START, { text: segmentText, audioBlob: audioBlob });`

---

## 🌐 第一阶段：云端基建与网络打通

### 1. DNS 域名解析
*   **操作**：在域名服务商处，将您的主域名（如 `@` 和 `www`）的 A 记录，指向您 GCP 云服务器的公网 IP。
*   **避坑点**：如果您使用了邮件转发服务（如 Forward Email），千万不要把主域名的 A 记录指到邮件服务器的 IP 上，否则会导致后续申请证书超时。主域名的 IP 必须且只能是您跑 Nginx 那台服务器的 IP。

### 2. GCP 防火墙配置（至关重要）
如果端口没开，后面的一切都是白搭。
*   **操作**：进入 GCP 控制台 -> VPC -> 防火墙。
*   **需要开放的端口**（全部为入站 Ingress，来源 `0.0.0.0/0`）：
    *   **TCP 22**：允许您通过浏览器/SSH 工具远程登录服务器。
    *   **TCP 80 和 TCP 443**：允许外网访问您的网页，以及让 Let's Encrypt 验证域名。
    *   **TCP 7000**：允许您本地的 FRP 客户端连接到云服务器。

### 3. 下载 Nginx
粘贴下列命令：
```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx -y
```

### 4. 申请 SSL 安全证书
*   **命令**：`sudo certbot --nginx -d 你的域名(例如：feiniu.com)`
*   **什么时候用**：当您的域名已经成功解析到服务器 IP（这个过程可能需要至少半小时的等待时间，运气好的话 30s 也行），且 80 端口已在 GCP 放行后使用。
*   **⚠️ 避坑点**：如果提示 *Timeout during connect*，99% 是因为 GCP 的防火墙 80 端口没开，或者 DNS 还没生效。

---

## 🌉 第二阶段：搭建 FRP 内网穿透桥梁

### 1. 云服务器端 (frps)
*   **下载与解压**：Linux x86_64 架构对应的后缀是 `linux_amd64`。
    ```bash
    wget https://github.com/fatedier/frp/releases/download/v0.56.0/frp_0.56.0_linux_amd64.tar.gz
    tar -zxvf frp_0.56.0_linux_amd64.tar.gz
    ```
*   **后台运行配置 (Systemd)**：
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
*   **服务控制命令**：
    ```bash
    sudo systemctl daemon-reload  # 修改了上面的文件后必须执行一次
    sudo systemctl enable frps     # 设置开机自启，必做
    sudo systemctl start frps      # 启动服务
    sudo systemctl status frps     # 查看是否是绿色 running
    ```

### 2. 本地电脑端 (frpc)
配置 `frpc.ini`：
```ini
[common]
server_addr = 您的GCP公网IP
server_port = 7000

[live2d_ws]
type = tcp
local_ip = 127.0.0.1
local_port = 8080  # 对接 AI 核心程序的 WebSocket
remote_port = 8081

[live2d_model]
type = tcp
local_ip = 127.0.0.1
local_port = 8082  # 本地模型文件服务端口
remote_port = 8082
```
*   **运行命令**：在 Windows 命令行中输入 `frpc.exe -c frpc.ini`。看到 *start proxy success* 即代表穿透成功。如果报 *i/o timeout*，去检查云服务器的 frps 是否在运行，或者 GCP 的 7000 端口是否放行。

---

## 🚦 第三阶段：Nginx 流量调度中枢
这是整个系统最容易出错的地方。
*   **避坑点**：不要使用 nano 编辑器去粘贴大段代码，极容易造成大括号错乱和旧代码残留。
*   **一键配置 (使用 tee)**：在终端直接复制并执行整段命令，这会推平旧文件并写入最干净的配置：
```bash
sudo tee /etc/nginx/sites-available/default > /dev/null << 'EOF'
server {
    listen 443 ssl;
    server_name 你的域名;

    # 证书必须有
    ssl_certificate /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    # 1. 网页前端目录 (放 index.html 的地方)
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

    # 3. 本地模型文件通道 (转发到 FRP 8082)
    # ⚠️ 注意这里最后的斜杠 /，缺少会导致 404！
    location /live2d/ {
        proxy_pass http://127.0.0.1:8082/;
        # 解决 Live2D 文件 MIME 类型问题
        types {
            application/json json;
            application/octet-stream moc3;
            application/octet-stream mtn;
        }
    }
}

server {
    listen 80;
    server_name 你的域名;
    return 301 https://$host$request_uri;
}
EOF
```
*   **Nginx 调试**：
    *   每次修改完必须执行：`sudo nginx -t`。如果报错，看提示的行数。
    *   如果显示 successful，执行热重载生效：`sudo systemctl reload nginx`。
    *   如果提示 not active，说明 Nginx 之前崩溃了，需要冷启动：`sudo systemctl start nginx`。

---

## 📱 第四阶段：前端界面部署与 Linux 文件管理
要让手机能访问密码框和麦克风，必须把前端代码上传到云端。
*   **修改index.html**: 修改该文件的133行的‘肥牛2.3.model3.json’为你的目标皮套，纹理大小建议2048及以下，否则ios系统可能因为内存溢出强制刷新。
*   **上传逻辑**：通过 GCP SSH 页面右上角的“上传文件”功能，将 `web` 文件夹下的 `index.html` 文件传到个人目录 (`~`)，然后再用命令移动。
*   **前端代码修改**：在上传前，必须把前端 JS 里的地址改成公网的。
    *   `ws://127...` -> `wss://你的域名/ws`
    *   `http://127...` -> `https://你的域名/live2d/`
*   **还要上传**：
    *   通过 GCP SSH 页面右上角的“上传文件”功能，把 GitHub 上下载的 live2d 文件根目录的 `libs` 文件夹及里面的所有内容放到 `/var/www/live2d/` 文件夹当中。
    *   最后把 live2d 文件放到 `/var/www/live2d/` 目录当中（只需要把 GitHub 上下载的 live2d 文件夹中的 `2D` 文件夹中的 `肥牛` 文件夹里面的所有内容直接放到 `/var/www/live2d/` 里面即可）。

---

## 🍴 食用顺序
1.  运行 VPS 的 frp。
2.  开启 PC 端的肥牛主程序。
3.  本地模型目录下运行：`npx http-server -p 8082 --cors`。
4.  访问网页。

**备注：默认密码为 `admin`，一定要自行修改！！！！！**
1.  将 `plugins/community/remote-sync` 文件夹放入项目的插件目录。
2.  修改 `metadata.json` 中的 `password` 或者 `index.js` 第九行的 `'admin'`。
3.  确保 PC 端安装了 `ws` 依赖：`npm install ws`。
4.  手机访问 `https://yourdomain.com`。
5.  输入插件配置的密码。

---

## 🛠️ Linux 常用文件操作 Cheat Sheet
*   **查看文件**：
    *   `ls` (简单查看)
    *   `ls -la` (查看详细信息包含隐藏文件，最常用)
*   **修改需要权限的文件**：前面必须加 `sudo`，否则报 *Permission denied*。
*   **移动/重命名单个文件**：
    *   `sudo mv demo.json /var/www/live2d/目标文件夹/` （切记末尾加斜杠 `/`，代表放入文件夹而不是重命名）。
*   **批量移动神器 (通配符 *)**：
    *   前缀匹配：`sudo mv 肥牛* /var/www/live2d/` (把所有“肥牛”开头的文件移走)
    *   后缀匹配：`sudo mv *.json /var/www/live2d/` (把所有 json 文件移走)
*   **删除文件**：
    *   `sudo rm 坏掉的文件名` (删除单文件)
    *   `sudo rm -rf 文件夹名/` (彻底删除整个文件夹及里面的内容，极其危险，慎用)

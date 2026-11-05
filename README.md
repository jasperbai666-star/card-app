# 卡牌等级系统

多人在线扑克牌等级展示程序：管理员可控制每位成员显示的卡牌，成员只能看到自己的牌，并通过建议/要求向管理员沟通。加入需邀请码，登录需账号密码。界面为炫酷黑色霓虹风格。

## 功能概览

- **牌面等级（高→低）**：大王、小王、K、Q、J、10、9、8、7、6、5、4、3、2、A
- **管理员**：查看/设置成员卡牌、等级排行、处理建议与要求、生成/撤销邀请码、停用或删除成员
- **成员**：仅查看自己的卡牌（服务端强制隔离）、提交建议或要求、查看自己的提交状态
- **实时推送**：WebSocket；管理员改牌后成员页面即时翻牌更新
- **邀请制注册**：每个邀请码唯一且一次性使用

## 技术栈

Node.js（≥22）+ PostgreSQL（`pg`，云端）/ SQLite（`node:sqlite`，本地）+ Express + WebSocket（`ws`）+ 原生前端（无构建步骤）

## 本地运行

```bash
cd card-app
npm install
npm start
```

默认监听 `http://0.0.0.0:3000`。

首次启动会自动创建管理员账号，凭证写入同目录：

```
ADMIN_CREDENTIALS.txt
```

可用环境变量覆盖：

| 变量 | 说明 |
|------|------|
| `PORT` | 端口，默认 3000 |
| `ADMIN_USERNAME` | 管理员用户名（与 `ADMIN_PASSWORD` 同时设置时生效） |
| `ADMIN_PASSWORD` | 管理员密码（不设则首次启动随机生成并写入凭证文件） |
| `DATABASE_URL` | 设置后使用 PostgreSQL，否则使用 SQLite |
| `SESSION_SECRET` | Session 密钥（生产环境建议固定设置） |
| `NODE_ENV` | 设为 `production` 时配合 `FORCE_HTTPS=1` 启用 Secure Cookie |

打开浏览器访问 `http://localhost:3000`，用 `ADMIN_CREDENTIALS.txt` 中的账号登录。在「邀请码」页生成邀请码，把码发给成员，成员访问「注册加入」填写邀请码完成注册。

## 让其他人访问

### 方式 A：同一局域网

1. 在你的电脑上 `npm start`
2. 查本机局域网 IP（如 `192.168.1.8`）
3. 其他人访问 `http://192.168.1.8:3000`（需同一 Wi-Fi，防火墙放行 3000 端口）

### 方式 B：Linux VPS + pm2（推荐长期运行）

```bash
# 上传解压项目后
cd card-app
npm install --omit=dev
npm install -g pm2
# 可选：固定密钥与端口
export PORT=3000
export SESSION_SECRET='请换成一串随机长字符'
pm2 start server.js --name card-app
pm2 save
pm2 startup
```

用 Nginx 反向代理并配置 HTTPS（示例）：

```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  # ssl_certificate ...;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

然后设置 `FORCE_HTTPS=1` 与 `NODE_ENV=production` 并重启。

### 方式 C：Render 免费托管（已适配）

程序检测到环境变量 `DATABASE_URL` 时自动改用 PostgreSQL（数据和登录状态都存进数据库，重启/休眠不丢）；没有时用本地 SQLite。

1. 把本项目推到 GitHub 仓库（`.gitignore` 已排除 `node_modules`、`data/`、凭证文件）
2. 在 Render 建一个免费 Postgres（建议 Singapore 区域）
3. 新建 Web Service（Node，免费套餐，同一区域）：
   - Build：`npm install --omit=dev`
   - Start：`npm start`
   - Health check：`/healthz`
4. 环境变量：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | Postgres 的 Internal Database URL |
| `SESSION_SECRET` | 随机长字符串 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员账号；每次启动都会按此同步密码 |
| `NODE_VERSION` | `22` |

也可以直接使用仓库里的 `render.yaml`（Blueprint）。

**免费套餐限制**：闲置约 15 分钟后休眠，再次访问需等约 50 秒唤醒；免费 Postgres 创建 30 天后到期（到期前需升级或导出数据）。

部署后可运行线上冒烟测试（会自动清理测试数据）：

```bash
BASE_URL=https://你的服务.onrender.com ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm run test:smoke
```

## 数据与备份

- 数据库文件：`data/app.db`
- 管理员凭证：`ADMIN_CREDENTIALS.txt`（勿提交到公开仓库）
- 备份：停止服务后复制整个 `data/` 目录即可

## 安全说明

- 密码使用 bcrypt 哈希存储
- Session Cookie 为 httpOnly
- 成员接口不会返回其他成员的卡牌；管理接口需管理员 Session
- 请妥善保管邀请码与管理员密码

## 开发脚本

```bash
npm start          # 启动服务
npm run setup      # 仅确保管理员存在
npm run test:e2e   # Playwright 端到端测试（需先安装浏览器）
```

## 牌面说明

普通牌需选择花色：♠ 黑桃、♥ 红心、♣ 梅花、♦ 方块。大王 / 小王无花色，样式单独渲染。

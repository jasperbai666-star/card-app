# 卡牌等级系统

多人在线扑克牌等级展示程序：管理员可控制每位成员显示的卡牌，成员只能看到自己的牌，并通过建议/要求向管理员沟通。加入需邀请码，登录需账号密码。界面为炫酷黑色霓虹风格。

## 功能概览

- **牌面等级（高→低）**：大王、小王、K、Q、J、10、9、8、7、6、5、4、3、2、A
- **管理员**：查看/设置成员卡牌、等级排行、处理建议与要求、生成/撤销邀请码、停用或删除成员
- **成员**：仅查看自己的卡牌（服务端强制隔离）、提交建议或要求、查看自己的提交状态、生成个人邀请码
- **匿名聊天室**：成员之间以随机代号互相对话，支持文字 / 表情 / 图片；互不可见真实身份。管理员可在后台对照真实身份、删消息、禁言、清空
- **实时推送**：WebSocket；管理员改牌后成员页面即时翻牌更新；聊天实时广播
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
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员账号；**只在第一次创建管理员时使用**，之后在网页「安全设置」里改的密码不会被覆盖 |
| `ADMIN_PASSWORD_FORCE_RESET` | 设为 `true` 时，下次启动把管理员密码重置为 `ADMIN_PASSWORD`、清除管理员 2FA，并踢下线所有管理员会话（忘记密码时用，用完请删除此变量） |
| `TRUST_PROXY_HOPS` / `CLIENT_IP_HEADER` | 取真实访客 IP 的方式。Render 上默认读 Cloudflare 的 `CF-Connecting-IP`；自建服务器按反向代理层数设 `TRUST_PROXY_HOPS`（默认 1） |
| `ALLOWED_ORIGINS` | 可选，额外允许的来源（逗号分隔，如自定义域名 `https://cards.example.com`） |
| `LOGIN_MAX_FAILS_PER_USER` / `LOGIN_MAX_FAILS_PER_IP` / `LOGIN_LOCK_MINUTES` | 可选，默认每账号 5 次、每 IP 10 次失败锁定 15 分钟 |
| `NODE_VERSION` | `22` |

也可以直接使用仓库里的 `render.yaml`（Blueprint）。

**免费套餐限制**：闲置约 15 分钟后休眠，再次访问需等约 50 秒唤醒；免费 Postgres 创建 30 天后到期（到期前需升级或导出数据）。

部署后可运行线上冒烟测试（会自动清理测试数据）：

```bash
BASE_URL=https://你的服务.onrender.com ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm run test:smoke
# 浏览器检查（XSS 不执行、无 CSP 报错）+ 安全页面截图到 screens/
BASE_URL=... ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/security-screens.js
```

## 数据与备份

- 数据库文件：`data/app.db`
- 管理员凭证：本地未设置环境变量时生成 `ADMIN_CREDENTIALS.txt`（勿提交到公开仓库）
- 备份：停止服务后复制整个 `data/` 目录即可

## 安全说明

**登录防护**
- 同一账号连续 5 次登录失败锁定 15 分钟；同一 IP 累计 10 次失败也会锁定 15 分钟（管理员可在「安全中心」解除某个账号的锁定）
- 错误提示统一为「账号或密码错误」，不暴露账号是否存在；不存在的账号也会走一遍 bcrypt，防止靠响应时间猜账号
- 注册接口每 IP 15 分钟最多 10 次；建议提交每人 10 分钟最多 10 条；改密码/2FA 操作也有限流

**两步验证（2FA，可选）**
1. 登录后点右上角「安全设置」→「两步验证」→「开始设置」
2. 用手机身份验证器（Google Authenticator / Microsoft Authenticator / 腾讯身份验证器等）扫码
3. 输入 App 里显示的 6 位数字确认，即开启；以后登录要输入密码 + 6 位验证码
4. 手机丢了：成员可让管理员在「成员与卡牌」里点「重置2FA」；管理员自己丢了：在 Render 环境变量里设 `ADMIN_PASSWORD_FORCE_RESET=true`（会同时重置密码和清除 2FA），重新部署登录后删掉该变量

**会话管理**
- 登录时更换 Session ID（防会话固定）；Cookie 为 HttpOnly + SameSite=Strict，线上自动 Secure
- 7 天无活动自动过期（有活动自动续期）
- 「安全中心」可看所有在线会话，一键「强制下线」；停用或删除成员会立刻踢掉其所有会话和实时连接
- 修改密码后，其他设备自动退出；「安全设置」里也可「退出其他所有设备」

**成员姓名**：管理员在「成员与卡牌」里点成员旁的「修改姓名」即可改显示的姓名（1–20 字，登录账号不变），成员页面实时更新，并记入审计日志；成员自己不能改

**审计日志**：「安全中心」显示最近 200 条登录记录（北京时间、账号、IP、设备、成功/失败原因），保留 90 天

**邀请码**：可设置有效期（1 天 / 3 天 / 7 天(默认) / 30 天 / 永久）和备注，过期自动失效

**其他**
- 密码 bcrypt（cost 12）哈希存储，最少 8 位
- helmet 安全响应头：严格 CSP（只允许本站脚本）、禁止被嵌入 iframe、HSTS、nosniff 等；字体本地托管，不依赖 Google
- CSRF 防护：所有写操作必须来自本站（校验 Origin/Referer）且为 JSON 请求；WebSocket 也校验来源
- 所有用户输入在页面上都会转义显示（防 XSS），并限制长度
## 开发脚本

```bash
npm start          # 启动服务
npm run setup      # 仅确保管理员存在
npm run test:e2e   # Playwright 端到端测试（需先安装浏览器）
```

## 牌面说明

普通牌需选择花色：♠ 黑桃、♥ 红心、♣ 梅花、♦ 方块。大王 / 小王无花色，样式单独渲染。

## 小游戏 · 跳一跳

成员页「小游戏 · 跳一跳」：按住蓄力、松手起跳，落台得分（圆心加分）。个人最佳入库；排行榜对成员只显示匿名代号，管理员可见真实姓名。提交有基础校验与限流。成就：跳一跳新手 / 跳一跳高手（≥50）。

## 公告栏与成就勋章

- **公告栏**：管理员可发布 / 编辑 / 置顶 / 删除公告（可选过期时间）。成员页顶部展示，未读有角标；发布后经已认证 WebSocket 实时推送。正文按纯文本转义，防 XSS。
- **成就勋章**（服务端判定，不信任客户端）：
  - 新成员报到 · 首次发言 · 图片达人 · 邀请先锋 · 人脉扩展 · 建言献策 · 高阶牌面（Q/K/小王/大王）
  - 启动时按现有邀请 / 建议 / 聊天 / 牌面数据回填；新解锁会实时通知成员。

## 跳一跳联机（微信式）

- 成员页「创建联机房间」→ 获得分享链接 `/jump/r/房间码`，一键复制文案发到微信群。

### 抓大鹅

微信同款多层堆叠三消（约 120 张、十余种图案）：牌层层叠压，只能点露出来的牌；7 格槽位三消，槽满失败。道具：移出 / 撤回 / 洗牌各 1 次。通关不易。成绩与成就写入服务端，排行榜对成员仅显示匿名代号。

### 成员页布局

移动端底部四栏：首页（卡牌+公告）/ 聊天 / 游戏（跳一跳+抓大鹅+多人）/ 我的（邀请·成就·建议）。桌面端左侧边栏。管理端增加「抓大鹅」成绩页签。
- 仅已登录的本站成员可加入（访客会先登录/邀请码注册，再回到房间）。
- 规则：共用同一张地图；轮到你时连续跳，踩空则本回合结束，换下一位从起点再跳；全员跳完后最高分获胜。
- 实时同步走已有认证 WebSocket；落点由服务端校验。


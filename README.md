# 订单助手（校园二手图书配送）

3 人共享使用的订单配送助手 + 可对外分享的顾客下单页。前端静态部署到 GitHub Pages，后端用 Cloudflare Workers + D1，靠轮询实现多端实时同步。当前已进入功能完整期，开发暂停，仅待腾讯 EdgeOne 迁移与价格体系两件事。

## 目录结构
```
frontend/                 # 前端（GitHub Actions 自动部署到 GitHub Pages）
  index.html              # 后台 SPA：区域配送/订单列表/新建/库存/求书/统计/历史/日志
  order-entry.html        # 顾客自助下单页（对外分享链接指向此页）
  wanted-entry.html       # 顾客求书登记页
  css/style.css
  js/app.js               # 后台逻辑（window.App 命名空间）
  js/vendor/xlsx.full.min.js  # Excel 导入导出
worker/                   # Cloudflare Workers 后端
  src/index.js            # API 路由（绑定 D1，绑定名 DB）
  wrangler.toml           # D1 配置
  schema.sql              # 建表初始化脚本（回收站/备份/日志表运行时自动创建）
functions/api/[[default]].js  # EdgeOne Pages (KV) 版后端，迁移备用，暂未启用
.github/workflows/        # pages.yml（前端）/ worker-deploy.yml（后端）/ d1-migrate.yml
.trae/documents/订单助手网站开发需求文档.md
```

## 功能清单
- **订单管理**：配送单 + 自提单（自提地点默认「师生活动中心」可改）、新建/编辑、滑动切状态（待配送 → 配送中 → 已完成）、多选批量操作、多级排序（进行中优先 → 配送/自提 → 同苑聚合 → 时间 → 楼号）、订单卡片一键拨号/复制联系方式。
- **库存管理**：Excel 导入/导出、三种弹窗模式（新增/编辑/补货）、超卖/缺货置顶高亮、模糊搜索。
- **求书登记**：顾客登记求书，找到后一键转库存；有待找到求书时导航红点提示。
- **统计**：按苑筛选、书名模糊搜索（分词 + 按序匹配）、缺货预警。
- **安全与运维**：后台密码鉴权（X-Admin-Key）、下单限频（同 IP+联系方式 10 分钟内 3 单）、下单 30 分钟内可自助取消（需核对联系方式）、回收站（软删除，7 天自动清理，可还原）、每日自动备份（保留 7 天，可下载/恢复）、操作日志（19 类操作，滚动保留 500 条，可修改署名）。
- **体验**：增量轮询（4 秒，减少流量）、时段在途订单提示、JS/CSS 带 `?v=` 版本号强刷缓存。

## 一、部署后端（Cloudflare Workers + D1）

1. 安装并登录 wrangler：
   ```bash
   npm i -g wrangler
   wrangler login
   ```
2. 创建 D1 数据库：
   ```bash
   cd worker
   wrangler d1 create order-assistant-db
   ```
   把命令输出的 `database_id` 填入 `wrangler.toml`。
3. 初始化表结构：
   ```bash
   wrangler d1 execute order-assistant-db --remote --file=./schema.sql
   ```
4. 配置后台密码（Secret）：
   ```bash
   wrangler secret put ADMIN_PASSWORD
   ```
   后台所有管理接口要求请求头 `X-Admin-Key = ADMIN_PASSWORD`，密码输错会记入操作日志。
5. 部署 Worker：
   ```bash
   wrangler deploy
   ```
   部署完成后会得到类似 `https://xxx.workers.dev` 的地址。

> 也可用 GitHub Actions 自动部署：仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN`（需 Workers 脚本编辑 + D1 编辑权限）和 `CLOUDFLARE_ACCOUNT_ID`，push 到 `worker/` 目录即自动发布。

## 二、配置并部署前端（GitHub Pages）

1. 打开 `frontend/js/app.js` 与 `frontend/order-entry.html`、`frontend/wanted-entry.html`，把顶部的
   ```js
   const WORKER_BASE = "https://your-worker.workers.dev";
   ```
   改成你上一步得到的 Worker 地址。（EdgeOne Pages 部署时前后端同域，无需修改。）
2. 把仓库推送到 GitHub 并将 Pages 来源设为 **GitHub Actions**，push 到 `frontend/` 目录即自动发布。
   - 后台地址：`你的站点/index.html`
   - 顾客下单链接：`你的站点/order-entry.html`（后台「分享下单链接」按钮一键复制）
   - 求书登记链接：`你的站点/wanted-entry.html`

## 三、使用说明
- 后台底部 Tab：区域配送（按苑分派，有待配送订单时红点提示）/ 订单列表 / 新建订单 / 库存 / 求书 / 统计 / 历史（含 📜 日志 入口）。
- 订单状态：待配送 → 配送中 → 已完成，滑动滑块切换；已完成置灰沉底，已取消删除线。
- 实时同步：页面每 4 秒增量拉取最新数据，三端共同更新。
- 配送清单：订单列表页「配送清单」按钮可打印按大苑分组的清单。
- 顾客下单：把下单链接发给同学，提交的订单自动进入订单列表；可查「我的订单」并在 30 分钟内自助取消。
- 求书：顾客在求书页登记，后台找到后可「转库存」。
- 修改前端 JS/CSS 后需更新引用处的 `?v=` 版本号，强制浏览器刷新缓存。

## 四、待办
- **EdgeOne Pages 迁移**：KV 访问权限审核中。通过后绑定 KV 命名空间（变量名必须为 `OA_DB`）→ 设环境变量 → 访问 `POST /api/migrate` 迁移 D1 数据。后端代码已就绪（`functions/api/[[default]].js`）。
- **价格体系**：待确认收费方式（定价卖 / 随缘 / 到付）后再开发。

## 五、注意事项
- 后台接口已启用密码鉴权，但 Worker 地址与前端地址仍为公开 URL；后台地址请勿外发，顾客下单页本就对外。
- 数据库 `database_id`、Cloudflare API Token、`ADMIN_PASSWORD` 均属敏感信息，切勿提交到仓库或外泄。

# 订单助手（校园二手图书配送）

3 人共享使用的订单配送助手 + 可对外分享的顾客下单页。前端静态部署到 GitHub Pages，后端用 Cloudflare Workers + D1，靠轮询实现多端实时同步。

## 目录结构
```
frontend/           # 前端（部署到 GitHub Pages）
  index.html        # 后台 SPA：区域配送/订单列表/新建/统计/历史
  order-entry.html  # 顾客自助下单页（对外分享链接指向此页）
  css/style.css
  js/app.js
worker/             # Cloudflare Workers 后端
  src/index.js      # API 路由（绑定 D1，绑定名 DB）
  wrangler.toml     # D1 配置
  schema.sql        # 建表初始化脚本
.trae/documents/订单助手网站开发需求文档.md   # 完整需求文档
```

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
4. 部署 Worker：
   ```bash
   wrangler deploy
   ```
   部署完成后会得到类似 `https://xxx.workers.dev` 的地址。

## 二、配置并部署前端（GitHub Pages）

1. 打开 `frontend/js/app.js` 与 `frontend/order-entry.html`，把顶部的
   ```js
   const WORKER_BASE = "https://your-worker.workers.dev";
   ```
   改成你上一步得到的 Worker 地址。
2. 把 `frontend` 目录推送到 GitHub 仓库并开启 Pages（或直接用任意静态托管）。
   - 后台地址：`你的站点/index.html`
   - 顾客下单链接：`你的站点/order-entry.html`（用后台「分享下单链接」按钮一键复制）

## 三、使用说明
- 后台底部 Tab：区域配送（按苑分派）/ 订单列表 / 新建订单 / 统计 / 历史。
- 订单状态：待配送 → 配送中 → 已完成；已完成自动置灰并排在最后。
- 其实时同步：页面每 4 秒自动拉取最新数据，三端共同更新。
- 配送清单：订单列表页「配送清单」按钮可打印按大苑分组的清单。
- 顾客下单：把下单链接发给同学，其提交的订单会自动进入你的订单列表。

## 四、注意事项
- 本项目无鉴权，Worker 地址与前端地址均为公开 URL。后台地址请勿外发，顾客下单页本就对外。
- 开发期数据库地址 `database_id` 请勿泄露。
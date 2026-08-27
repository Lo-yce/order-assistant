-- 订单助手 D1 初始化脚本
-- 用法：npx wrangler d1 execute order-assistant-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_building TEXT NOT NULL,
  sub_zone TEXT NOT NULL,
  deliver_time TEXT,
  contact TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_orders_deliver_time ON orders(deliver_time);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- 书籍库存（由后台导入 Excel 维护；剩余 = stock - 订单需求合计）
CREATE TABLE IF NOT EXISTS inventory (
  book_name TEXT PRIMARY KEY,
  stock INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
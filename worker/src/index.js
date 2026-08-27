/**
 * 订单助手 —— Cloudflare Worker API
 * 绑定 D1 数据库，绑定名：DB
 * 鉴权：后台管理接口要求请求头 X-Admin-Key = env.ADMIN_PASSWORD（在 Cloudflare 控制台配置 Secret）
 * 公开接口（无需密码）：顾客下单 POST /api/orders、书名联想 GET /api/book-names、查我的订单 GET /api/my-orders
 */
const BUILDINGS = ['大千苑18栋', '长江苑19栋', '大洲苑21栋', '培伦苑20栋'];
const STATUSES = ['pending', 'delivering', 'done'];

// 校验区域编号合法性：仅允许各苑对应的 4 个编号
function validSubZone(building, sub) {
  const map = {
    '大千苑18栋': ['18-1', '18-2', '18-3', '18-4'],
    '长江苑19栋': ['19-1', '19-2', '19-3', '19-4'],
    '大洲苑21栋': ['21-1', '21-2', '21-3', '21-4'],
    '培伦苑20栋': ['20-1', '20-2', '20-3', '20-4'],
  };
  return (map[building] || []).includes(sub);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function readBody(request) {
  return request.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({}));
}

// 是否公开接口（顾客可用，无需密码）
function isPublicPath(p, method) {
  return (
    (p === '/api/orders' && method === 'POST') ||
    (p === '/api/book-names' && method === 'GET') ||
    (p === '/api/my-orders' && method === 'GET')
  );
}

// 后台鉴权：X-Admin-Key 必须等于配置的密码（未配置则一律拒绝，fail-closed）
function checkAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '后台密码未配置：请在 Cloudflare 控制台为 Worker 设置 Secret 变量 ADMIN_PASSWORD', code: 'NO_PASSWORD' }, 401);
  }
  const key = request.headers.get('X-Admin-Key') || '';
  if (key !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '密码错误', code: 'UNAUTHORIZED' }, 401);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;
    const p = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // 后台接口统一鉴权（公开接口除外）
      if (!isPublicPath(p, method)) {
        const denied = checkAdmin(request, env);
        if (denied) return denied;
      }

      // 订单集合
      if (p === '/api/orders') {
        if (method === 'GET') return await getOrders(db, url);
        if (method === 'POST') {
          const body = await readBody(request);
          return await createOrder(db, body);
        }
      }

      // 统计 / 书名联想 / 清空已完成
      if (p === '/api/stats' && method === 'GET') return await getStats(db, url);
      if (p === '/api/book-names' && method === 'GET') return await getBookNames(db);
      if (p === '/api/clear-done' && method === 'POST') return await clearDone(db);

      // 库存
      if (p === '/api/inventory' && method === 'GET') return await getInventory(db);
      if (p === '/api/inventory' && method === 'POST') {
        const body = await readBody(request);
        return await importInventory(db, body);
      }

      // 查我的订单（顾客按联系方式）
      if (p === '/api/my-orders' && method === 'GET') return await getMyOrders(db, url);

      // 状态更新 /api/orders/:id/status
      let m = p.match(/^\/api\/orders\/(\d+)\/status$/);
      if (m && method === 'PATCH') {
        const body = await readBody(request);
        return await updateStatus(db, Number(m[1]), body);
      }

      // 单个订单 /api/orders/:id
      m = p.match(/^\/api\/orders\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (method === 'GET') return await getOrder(db, id);
        if (method === 'PUT') {
          const body = await readBody(request);
          return await updateOrder(db, id, body);
        }
        if (method === 'DELETE') return await delOrder(db, id);
      }

      return json({ ok: false, error: 'Not Found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'Server Error: ' + e.message }, 500);
    }
  },
};

async function getOrders(db, url) {
  const status = url.searchParams.get('status');
  // 排序：待/配送中按 deliver_time 空优先→升序；done 恒排最末
  const where = status ? 'WHERE status = ?' : '';
  const binds = status ? [status] : [];
  const sql = `SELECT * FROM orders ${where}
    ORDER BY (status='done') ASC,
             (deliver_time IS NULL OR deliver_time='') DESC,
             deliver_time ASC`;
  const { results: orders } = await db.prepare(sql).bind(...binds).all();
  const { results: items } = await db.prepare('SELECT * FROM order_items').all();
  const byOrder = {};
  for (const it of items) {
    (byOrder[it.order_id] = byOrder[it.order_id] || []).push({
      id: it.id, book_name: it.book_name, quantity: it.quantity,
    });
  }
  for (const o of orders) o.items = byOrder[o.id] || [];
  return json({ ok: true, data: orders });
}

async function getOrder(db, id) {
  const found = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  const { results: items } = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all();
  found.items = items;
  return json({ ok: true, data: found });
}

async function createOrder(db, body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);

  const now = new Date().toISOString();
  const t = db.prepare(
    'INSERT INTO orders (delivery_building, sub_zone, deliver_time, contact, remark, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(body.delivery_building, body.sub_zone, body.deliver_time || null, body.contact || '', body.remark || '', 'pending', now, now);
  const res = await t.run();

  await insertItems(db, res.meta.last_row_id, body.items);
  return json({ ok: true, data: { id: Number(res.meta.last_row_id) } });
}

async function updateOrder(db, id, body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);
  const found = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE orders SET delivery_building=?, sub_zone=?, deliver_time=?, contact=?, remark=?, updated_at=? WHERE id=?'
  ).bind(body.delivery_building, body.sub_zone, body.deliver_time || null, body.contact || '', body.remark || '', now, id).run();

  await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id).run();
  await insertItems(db, id, body.items);
  return json({ ok: true, data: { id } });
}

async function updateStatus(db, id, body) {
  if (!STATUSES.includes(body.status)) return json({ ok: false, error: '无效状态' }, 400);
  const found = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  const now = new Date().toISOString();
  await db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').bind(body.status, now, id).run();
  return json({ ok: true, data: { id, status: body.status } });
}

async function delOrder(db, id) {
  const found = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id).run();
  await db.prepare('DELETE FROM orders WHERE id = ?').bind(id).run();
  return json({ ok: true, data: { id } });
}

async function clearDone(db) {
  const before = await db.prepare('SELECT COUNT(*) as c FROM orders WHERE status=?').bind('done').first();
  await db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status=?)').bind('done').run();
  await db.prepare('DELETE FROM orders WHERE status=?').bind('done').run();
  return json({ ok: true, data: { deleted: before.c } });
}

// 统计：需求合计 + 库存 + 剩余；可选 ?building= 按苑筛选
async function getStats(db, url) {
  const building = url.searchParams.get('building');
  const aggSql = building
    ? `SELECT i.book_name, SUM(i.quantity) AS total_quantity, COUNT(DISTINCT i.order_id) AS order_count
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.delivery_building = ? GROUP BY i.book_name`
    : `SELECT book_name, SUM(quantity) AS total_quantity, COUNT(DISTINCT order_id) AS order_count
       FROM order_items GROUP BY book_name`;
  const binds = building ? [building] : [];
  const { results: agg } = await db.prepare(aggSql).bind(...binds).all();

  // 库存表：仅在未按苑筛选时纳入"只有库存、暂无订单"的书
  const { results: inv } = await db.prepare('SELECT book_name, stock FROM inventory').all();
  const invMap = {};
  for (const v of inv) invMap[v.book_name] = v.stock;

  const map = {};
  for (const r of agg) {
    map[r.book_name] = { book_name: r.book_name, total_quantity: r.total_quantity, order_count: r.order_count, stock: null, remaining: null };
  }
  if (!building) {
    for (const name of Object.keys(invMap)) {
      if (!map[name]) map[name] = { book_name: name, total_quantity: 0, order_count: 0, stock: null, remaining: null };
    }
  }
  const list = Object.values(map);
  for (const r of list) {
    if (r.book_name in invMap) {
      r.stock = invMap[r.book_name];
      r.remaining = r.stock - r.total_quantity;
    }
  }
  list.sort((a, b) => b.total_quantity - a.total_quantity || a.book_name.localeCompare(b.book_name, 'zh'));
  return json({ ok: true, data: list });
}

async function getBookNames(db) {
  const { results } = await db.prepare(
    'SELECT book_name, COUNT(*) as use_count FROM order_items GROUP BY book_name ORDER BY use_count DESC'
  ).all();
  return json({ ok: true, data: results.map((r) => r.book_name) });
}

async function getInventory(db) {
  const { results } = await db.prepare('SELECT book_name, stock, updated_at FROM inventory ORDER BY book_name').all();
  return json({ ok: true, data: results });
}

// 批量导入库存：{ items: [{book_name, stock}] }，同书名覆盖
async function importInventory(db, body) {
  const items = Array.isArray(body) ? body : body && body.items;
  if (!Array.isArray(items) || items.length === 0) return json({ ok: false, error: '请提供非空的 items 数组' }, 400);
  const clean = [];
  for (const it of items) {
    const name = it && it.book_name != null ? String(it.book_name).trim() : '';
    const stock = Number(it && it.stock);
    if (!name) return json({ ok: false, error: '存在空书名' }, 400);
    if (!Number.isFinite(stock) || stock < 0 || Math.round(stock) !== stock) return json({ ok: false, error: `「${name}」库存需为≥0的整数` }, 400);
    clean.push({ name, stock });
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO inventory (book_name, stock, updated_at) VALUES (?,?,?) ON CONFLICT(book_name) DO UPDATE SET stock=excluded.stock, updated_at=excluded.updated_at'
  );
  for (const c of clean) await stmt.bind(c.name, c.stock, now).run();
  return json({ ok: true, data: { imported: clean.length } });
}

// 顾客按联系方式查自己的订单（最多 20 条）
async function getMyOrders(db, url) {
  const contact = (url.searchParams.get('contact') || '').trim();
  if (!contact) return json({ ok: false, error: '请填写下单时的联系方式' }, 400);
  const { results: orders } = await db.prepare(
    `SELECT id, delivery_building, sub_zone, deliver_time, status, created_at FROM orders
     WHERE contact = ? ORDER BY created_at DESC LIMIT 20`
  ).bind(contact).all();
  const { results: items } = await db.prepare('SELECT * FROM order_items').all();
  const byOrder = {};
  for (const it of items) {
    (byOrder[it.order_id] = byOrder[it.order_id] || []).push({ book_name: it.book_name, quantity: it.quantity });
  }
  for (const o of orders) o.items = byOrder[o.id] || [];
  return json({ ok: true, data: orders });
}

async function insertItems(db, orderId, items) {
  const stmt = db.prepare('INSERT INTO order_items (order_id, book_name, quantity) VALUES (?,?,?)');
  for (const it of items) {
    await stmt.bind(orderId, it.book_name.trim(), Number(it.quantity)).run();
  }
}

function validateOrder(body) {
  if (!body || typeof body !== 'object') return '请求体缺失';
  if (!BUILDINGS.includes(body.delivery_building)) return '无效的大苑';
  if (!validSubZone(body.delivery_building, body.sub_zone)) return '无效的编号';
  if (!body.contact || !String(body.contact).trim()) return '请填写联系方式';
  if (!Array.isArray(body.items) || body.items.length === 0) return '请至少添加一行书';
  for (const it of body.items) {
    if (!it.book_name || !String(it.book_name).trim()) return '书名为空';
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) < 1) return '数量需为≥1的整数';
  }
  return null;
}

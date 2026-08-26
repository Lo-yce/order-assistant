/**
 * 订单助手 —— Cloudflare Worker API
 * 绑定 D1 数据库，绑定名：DB
 * 无鉴权（三人共享 + 顾客下单页共用此 API）
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function readBody(request) {
  return request.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({}));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;
    const p = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      } });
    }

    try {
      // 订单集合
      if (p === '/api/orders') {
        if (method === 'GET') return await getOrders(db, url);
        if (method === 'POST') {
          const body = await readBody(request);
          return await createOrder(db, body);
        }
      }

      // 统计 / 书名联想 / 清空已完成
      if (p === '/api/stats' && method === 'GET') return await getStats(db);
      if (p === '/api/book-names' && method === 'GET') return await getBookNames(db);
      if (p === '/api/clear-done' && method === 'POST') return await clearDone(db);

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

async function getStats(db) {
  const { results } = await db.prepare(
    'SELECT book_name, SUM(quantity) as total_quantity, COUNT(*) as order_count FROM order_items GROUP BY book_name ORDER BY total_quantity DESC'
  ).all();
  return json({ ok: true, data: results.map((r) => ({ book_name: r.book_name, total_quantity: r.total_quantity, order_count: r.order_count })) });
}

async function getBookNames(db) {
  const { results } = await db.prepare(
    'SELECT book_name, COUNT(*) as use_count FROM order_items GROUP BY book_name ORDER BY use_count DESC'
  ).all();
  return json({ ok: true, data: results.map((r) => r.book_name) });
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
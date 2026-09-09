/**
 * 订单助手 —— Cloudflare Worker API
 * 绑定 D1 数据库，绑定名：DB
 * 鉴权：后台管理接口要求请求头 X-Admin-Key = env.ADMIN_PASSWORD（在 Cloudflare 控制台配置 Secret）
 * 公开接口（无需密码）：顾客下单 POST /api/orders、书名联想 GET /api/book-names、查我的订单 GET /api/my-orders
 */
const BUILDINGS = ['大千苑18栋', '长江苑19栋', '大洲苑21栋', '培伦苑20栋'];
const STATUSES = ['pending', 'delivering', 'done'];
const METHODS = ['delivery', 'self_pickup']; // 配送 / 自提
const DEFAULT_PICKUP = '师生活动中心';

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
    (p === '/api/book-stock' && method === 'GET') ||
    (/^\/api\/orders\/\d+\/cancel$/.test(p) && method === 'POST') ||
    (p === '/api/my-orders' && method === 'GET') ||
    (p === '/api/wanted/public' && method === 'POST')
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
    return await handleRequest(request, env);
  },
  // Cloudflare Cron：每天 UTC 18:00（北京时间 2:00）自动备份
  async scheduled(event, env, ctx) {
    ctx.waitUntil(doBackup(env.DB).catch(() => {}));
  },
};

async function handleRequest(request, env) {
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
      if (p === '/api/book-stock' && method === 'GET') return await getBookStock(db);
      if (p === '/api/clear-done' && method === 'POST') return await clearDone(db);

      // 回收站（软删订单/求书：列表/还原/彻底删/清空）
      if (p === '/api/recycle' && method === 'GET') return await getRecycle(db);
      if (p === '/api/recycle/restore' && method === 'POST') return await recycleRestore(db, await readBody(request));
      if (p === '/api/recycle/item' && method === 'DELETE') return await recyclePurgeItem(db, await readBody(request));
      if (p === '/api/recycle/empty' && method === 'POST') return await recycleEmpty(db);

      // 备份（列表/下载/恢复/手动立即备份）
      if (p === '/api/backups' && method === 'GET') return await listBackups(db);
      if (p === '/api/backups/now' && method === 'POST') return json({ ok: true, data: await doBackup(db) });
      let bm = p.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2})\/restore$/);
      if (bm && method === 'POST') return await restoreBackup(db, bm[1]);
      bm = p.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2})$/);
      if (bm && method === 'GET') return await getBackup(db, bm[1]);

      // 库存
      if (p === '/api/inventory' && method === 'GET') return await getInventory(db);
      if (p === '/api/inventory' && method === 'POST') {
        const body = await readBody(request);
        return await importInventory(db, body);
      }
      if (p === '/api/inventory' && method === 'DELETE') return await clearInventory(db);
      if (p === '/api/inventory/item' && method === 'DELETE') return await deleteInventoryItem(db, await readBody(request));

      // 查我的订单（顾客按联系方式）
      if (p === '/api/my-orders' && method === 'GET') return await getMyOrders(db, url);

      // 需求书单（求书登记：有人需要但还没找到的书）
      if (p === '/api/wanted' && method === 'GET') return await getWanted(db, url);
      if (p === '/api/wanted' && method === 'POST') {
        const body = await readBody(request);
        return await createWanted(db, body);
      }

      // 顾客自助登记求书（公开接口，无需密码）
      if (p === '/api/wanted/public' && method === 'POST') {
        const body = await readBody(request);
        return await createWantedPublic(db, body);
      }

      // 状态更新 /api/orders/:id/status
      let m = p.match(/^\/api\/orders\/(\d+)\/status$/);
      if (m && method === 'PATCH') {
        const body = await readBody(request);
        return await updateStatus(db, Number(m[1]), body);
      }

      // 顾客自助取消（公开）
      m = p.match(/^\/api\/orders\/(\d+)\/cancel$/);
      if (m && method === 'POST') {
        const body = await readBody(request);
        return await cancelOrderPublic(db, Number(m[1]), body);
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

      // 需求书单状态 /api/wanted/:id/status
      m = p.match(/^\/api\/wanted\/(\d+)\/status$/);
      if (m && method === 'PATCH') {
        const body = await readBody(request);
        return await updateWantedStatus(db, Number(m[1]), body);
      }

      // 单条求书 /api/wanted/:id
      m = p.match(/^\/api\/wanted\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (method === 'PUT') {
          const body = await readBody(request);
          return await updateWanted(db, id, body);
        }
        if (method === 'DELETE') return await delWanted(db, id);
      }

      return json({ ok: false, error: 'Not Found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'Server Error: ' + e.message }, 500);
    }
}

async function getOrders(db, url) {
  const status = url.searchParams.get('status');
  // 每日惰性备份：当天还没有备份时顺手做一次（cron 失效的兜底）
  try { await ensureTodayBackup(db); } catch (e) {}
  // 排序（配送路线友好）：进行中在前；待配送>配送中；同苑聚合+楼号自然序；尽快优先；自提最后；软删不显示
  const where = status ? 'WHERE deleted_at IS NULL AND status = ?' : 'WHERE deleted_at IS NULL';
  const binds = status ? [status] : [];
  // 楼号自然序（"18-2" → 18, 2）：自提/空楼号统一 99999（已被自提分组隔开）
  // 苑内时间优先：尽快(空时间)在前 → 时间升序 → 同时间才按楼号
  const sql = `SELECT *,
             CASE WHEN sub_zone = '' OR sub_zone IS NULL THEN 99999 ELSE CAST(substr(sub_zone, 1, instr(sub_zone, '-') - 1) AS INTEGER) END AS _b,
             CASE WHEN sub_zone = '' OR sub_zone IS NULL THEN 99999 ELSE CAST(replace(substr(sub_zone, instr(sub_zone, '-') + 1), '-', '') AS INTEGER) END AS _u
             FROM orders ${where}
    ORDER BY ((status='done') OR (status='cancelled')) ASC,
             CASE status WHEN 'pending' THEN 0 WHEN 'delivering' THEN 1 ELSE 2 END ASC,
             CASE WHEN delivery_method = 'self_pickup' THEN 1 ELSE 0 END ASC,
             CASE delivery_building WHEN '大千苑18栋' THEN 0 WHEN '长江苑19栋' THEN 1 WHEN '大洲苑21栋' THEN 2 WHEN '培伦苑20栋' THEN 3 ELSE 4 END ASC,
             (deliver_time IS NULL OR deliver_time='') DESC,
             deliver_time ASC,
             _b ASC, _u ASC`;
  const { results: orders } = await db.prepare(sql).bind(...binds).all();
  const { results: items } = await db.prepare('SELECT * FROM order_items').all();
  const byOrder = {};
  for (const it of items) {
    (byOrder[it.order_id] = byOrder[it.order_id] || []).push({
      id: it.id, book_name: it.book_name, quantity: it.quantity,
    });
  }
  for (const o of orders) {
    o.items = byOrder[o.id] || [];
    delete o._b; delete o._u; // 排序临时列不返回
  }
  return json({ ok: true, data: orders });
}

async function getOrder(db, id) {
  const found = await db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  const { results: items } = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all();
  found.items = items;
  return json({ ok: true, data: found });
}

async function createOrder(db, body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);

  // 防刷单：同联系方式 10 分钟内最多 3 单
  const contact = String(body.contact || '').trim();
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { results: recent } = await db.prepare(
    'SELECT id FROM orders WHERE contact = ? AND created_at > ? AND deleted_at IS NULL LIMIT 3'
  ).bind(contact, cutoff).all();
  if (recent.length >= 3) {
    return json({ ok: false, error: '下单太频繁啦，请稍等几分钟再试（10 分钟内最多 3 单）' }, 429);
  }

  const method = normMethod(body);
  const now = new Date().toISOString();
  const t = db.prepare(
    'INSERT INTO orders (delivery_method, delivery_building, sub_zone, pickup_location, deliver_time, contact, remark, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(method, method === 'delivery' ? body.delivery_building : '', method === 'delivery' ? body.sub_zone : '', method === 'self_pickup' ? String(body.pickup_location || DEFAULT_PICKUP).trim() : '', body.deliver_time || null, contact, body.remark || '', 'pending', now, now);
  const res = await t.run();

  await insertItems(db, res.meta.last_row_id, body.items);
  return json({ ok: true, data: { id: Number(res.meta.last_row_id) } });
}

async function updateOrder(db, id, body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);
  const found = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);

  const method = normMethod(body);
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE orders SET delivery_method=?, delivery_building=?, sub_zone=?, pickup_location=?, deliver_time=?, contact=?, remark=?, updated_at=? WHERE id=?'
  ).bind(method, method === 'delivery' ? body.delivery_building : '', method === 'delivery' ? body.sub_zone : '', method === 'self_pickup' ? String(body.pickup_location || DEFAULT_PICKUP).trim() : '', body.deliver_time || null, body.contact || '', body.remark || '', now, id).run();

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
  // 软删除：进回收站，可还原
  const found = await db.prepare('SELECT id FROM orders WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  await db.prepare('UPDATE orders SET deleted_at=?, updated_at=? WHERE id=?')
    .bind(new Date().toISOString(), new Date().toISOString(), id).run();
  return json({ ok: true, data: { id } });
}

async function clearDone(db) {
  // 软删除：已完成/已取消整批进回收站
  const now = new Date().toISOString();
  const before = await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('done','cancelled') AND deleted_at IS NULL").first();
  await db.prepare("UPDATE orders SET deleted_at=?, updated_at=? WHERE status IN ('done','cancelled') AND deleted_at IS NULL").bind(now, now).run();
  return json({ ok: true, data: { deleted: before.c } });
}

// 统计：需求合计 + 库存 + 剩余；可选 ?building= 按苑筛选；已取消订单不计需求
async function getStats(db, url) {
  const building = url.searchParams.get('building');
  const aggSql = building
    ? `SELECT i.book_name, SUM(i.quantity) AS total_quantity, COUNT(DISTINCT i.order_id) AS order_count
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.delivery_building = ? AND o.status != 'cancelled' AND o.deleted_at IS NULL GROUP BY i.book_name`
    : `SELECT i.book_name, SUM(i.quantity) AS total_quantity, COUNT(DISTINCT i.order_id) AS order_count
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.status != 'cancelled' AND o.deleted_at IS NULL GROUP BY i.book_name`;
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

// 公开：书名 + 剩余库存（顾客下单联想用；remaining 为 null 表示未维护库存）
async function getBookStock(db) {
  const { results: items } = await db.prepare(
    `SELECT i.book_name, SUM(i.quantity) AS q FROM order_items i
     JOIN orders o ON o.id = i.order_id WHERE o.status != 'cancelled' AND o.deleted_at IS NULL GROUP BY i.book_name`
  ).all();
  const { results: inv } = await db.prepare('SELECT book_name, stock FROM inventory').all();
  const demand = {};
  for (const r of items) demand[r.book_name] = r.q;
  const list = [];
  const seen = {};
  for (const v of inv) {
    seen[v.book_name] = true;
    list.push({ book_name: v.book_name, remaining: v.stock - (demand[v.book_name] || 0) });
  }
  for (const n of Object.keys(demand)) {
    if (!seen[n]) list.push({ book_name: n, remaining: null }); // 只有订单没有库存记录
  }
  return json({ ok: true, data: list });
}

// 公开：顾客自助取消订单（仅待配送状态且下单 30 分钟内，联系方式需匹配）
async function cancelOrderPublic(db, id, body) {
  const contact = String((body && body.contact) || '').trim();
  if (!contact) return json({ ok: false, error: '缺少联系方式' }, 400);
  const found = await db.prepare('SELECT id, contact, status, created_at FROM orders WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!found) return json({ ok: false, error: '订单不存在' }, 404);
  if (found.contact !== contact) return json({ ok: false, error: '联系方式与订单不符，无法取消' }, 403);
  if (found.status !== 'pending') return json({ ok: false, error: '该订单已在处理中，无法自助取消，请直接联系我们' }, 400);
  const created = new Date(found.created_at).getTime();
  if (!Number.isFinite(created) || Date.now() - created > 30 * 60 * 1000) {
    return json({ ok: false, error: '下单已超过 30 分钟，无法自助取消，请直接联系我们' }, 400);
  }
  await db.prepare("UPDATE orders SET status='cancelled', updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), id).run();
  return json({ ok: true, data: { id } });
}

async function getInventory(db) {
  const { results } = await db.prepare('SELECT book_name, stock, updated_at FROM inventory ORDER BY book_name').all();
  return json({ ok: true, data: results });
}

// 清空全部库存（用于重新导入前重置）
async function clearInventory(db) {
  const { meta } = await db.prepare('DELETE FROM inventory').run();
  return json({ ok: true, data: { deleted: meta.changes || 0 } });
}

// 删除单条库存（库存改名时由前端组合使用）
async function deleteInventoryItem(db, body) {
  const name = body && body.book_name != null ? String(body.book_name).trim() : '';
  if (!name) return json({ ok: false, error: '缺少书名' }, 400);
  const { meta } = await db.prepare('DELETE FROM inventory WHERE book_name = ?').bind(name).run();
  return json({ ok: true, data: { deleted: meta.changes || 0 } });
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
    `SELECT id, delivery_method, delivery_building, sub_zone, pickup_location, deliver_time, status, created_at FROM orders
     WHERE contact = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`
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

// ===== 需求书单（求书登记） =====
const WANTED_STATUSES = ['open', 'found'];

async function getWanted(db, url) {
  const status = url.searchParams.get('status');
  const where = status ? 'WHERE deleted_at IS NULL AND status = ?' : 'WHERE deleted_at IS NULL';
  const binds = status ? [status] : [];
  // 待找到在前（先登的先找），已找到排后
  const { results } = await db.prepare(
    `SELECT * FROM wanted_books ${where}
     ORDER BY (status='found') ASC, created_at ASC`
  ).bind(...binds).all();
  return json({ ok: true, data: results });
}

async function createWanted(db, body) {
  const err = validateWanted(body);
  if (err) return json({ ok: false, error: err }, 400);
  const now = new Date().toISOString();
  const res = await db.prepare(
    'INSERT INTO wanted_books (book_name, quantity, contact, remark, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(String(body.book_name).trim(), Number(body.quantity), body.contact || '', body.remark || '', 'open', now, now).run();
  return json({ ok: true, data: { id: Number(res.meta.last_row_id) } });
}

async function updateWanted(db, id, body) {
  const err = validateWanted(body);
  if (err) return json({ ok: false, error: err }, 400);
  const found = await db.prepare('SELECT id FROM wanted_books WHERE id = ?').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE wanted_books SET book_name=?, quantity=?, contact=?, remark=?, updated_at=? WHERE id=?'
  ).bind(String(body.book_name).trim(), Number(body.quantity), body.contact || '', body.remark || '', now, id).run();
  return json({ ok: true, data: { id } });
}

async function updateWantedStatus(db, id, body) {
  if (!WANTED_STATUSES.includes(body.status)) return json({ ok: false, error: '无效状态' }, 400);
  const found = await db.prepare('SELECT id FROM wanted_books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  const now = new Date().toISOString();
  await db.prepare('UPDATE wanted_books SET status=?, updated_at=? WHERE id=?').bind(body.status, now, id).run();
  return json({ ok: true, data: { id, status: body.status } });
}

async function delWanted(db, id) {
  // 软删除：进回收站，可还原
  const found = await db.prepare('SELECT id FROM wanted_books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  await db.prepare('UPDATE wanted_books SET deleted_at=?, updated_at=? WHERE id=?')
    .bind(new Date().toISOString(), new Date().toISOString(), id).run();
  return json({ ok: true, data: { id } });
}

function validateWanted(body) {
  if (!body || typeof body !== 'object') return '请求体缺失';
  if (!body.book_name || !String(body.book_name).trim()) return '书名为空';
  if (!Number.isInteger(Number(body.quantity)) || Number(body.quantity) < 1) return '数量需为≥1的整数';
  return null;
}

// ===== 回收站（软删数据：7 天后彻底清理） =====
const RECYCLE_TTL = 7 * 24 * 60 * 60 * 1000;

// 惰性清理：读取回收站时顺手彻底删除超 7 天的软删数据
async function recycleSweep(db) {
  const cutoff = new Date(Date.now() - RECYCLE_TTL).toISOString();
  await db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE deleted_at IS NOT NULL AND deleted_at < ?)').bind(cutoff).run();
  await db.prepare('DELETE FROM orders WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff).run();
  await db.prepare('DELETE FROM wanted_books WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff).run();
}

async function getRecycle(db) {
  await recycleSweep(db);
  const { results: orders } = await db.prepare(
    'SELECT * FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all();
  const { results: items } = await db.prepare('SELECT * FROM order_items').all();
  const byOrder = {};
  for (const it of items) {
    (byOrder[it.order_id] = byOrder[it.order_id] || []).push({ book_name: it.book_name, quantity: it.quantity });
  }
  for (const o of orders) o.items = byOrder[o.id] || [];
  const { results: wanted } = await db.prepare(
    'SELECT * FROM wanted_books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all();
  return json({ ok: true, data: { orders, wanted } });
}

async function recycleRestore(db, body) {
  const type = body && body.type;
  const id = Number(body && body.id);
  if (!['order', 'wanted'].includes(type) || !Number.isInteger(id)) return json({ ok: false, error: '参数无效' }, 400);
  const now = new Date().toISOString();
  if (type === 'order') {
    const r = await db.prepare('UPDATE orders SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL').bind(now, id).run();
    if (!r.meta.changes) return json({ ok: false, error: '记录不存在' }, 404);
  } else {
    const r = await db.prepare('UPDATE wanted_books SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL').bind(now, id).run();
    if (!r.meta.changes) return json({ ok: false, error: '记录不存在' }, 404);
  }
  return json({ ok: true, data: { id } });
}

async function recyclePurgeItem(db, body) {
  const type = body && body.type;
  const id = Number(body && body.id);
  if (!['order', 'wanted'].includes(type) || !Number.isInteger(id)) return json({ ok: false, error: '参数无效' }, 400);
  if (type === 'order') {
    await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id).run();
    await db.prepare('DELETE FROM orders WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run();
  } else {
    await db.prepare('DELETE FROM wanted_books WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run();
  }
  return json({ ok: true, data: { id } });
}

async function recycleEmpty(db) {
  await db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE deleted_at IS NOT NULL)').run();
  const o = await db.prepare('DELETE FROM orders WHERE deleted_at IS NOT NULL').run();
  const w = await db.prepare('DELETE FROM wanted_books WHERE deleted_at IS NOT NULL').run();
  return json({ ok: true, data: { deleted: (o.meta.changes || 0) + (w.meta.changes || 0) } });
}

// ===== 每日自动备份（保留近 7 天，可下载/恢复） =====
async function doBackup(db) {
  // 幂等建表（备份表不在 schema 里，避免旧库报错）
  await db.prepare('CREATE TABLE IF NOT EXISTS backups (day TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)').run();
  const day = new Date().toISOString().slice(0, 10);
  const { results: orders } = await db.prepare('SELECT * FROM orders').all();
  const { results: order_items } = await db.prepare('SELECT * FROM order_items').all();
  const { results: inventory } = await db.prepare('SELECT * FROM inventory').all();
  const { results: wanted_books } = await db.prepare('SELECT * FROM wanted_books').all();
  const payload = JSON.stringify({ version: 1, day, orders, order_items, inventory, wanted_books });
  await db.prepare(
    'INSERT INTO backups (day, payload, created_at) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at'
  ).bind(day, payload, new Date().toISOString()).run();
  // 只保留最近 7 天
  await db.prepare('DELETE FROM backups WHERE day NOT IN (SELECT day FROM backups ORDER BY day DESC LIMIT 7)').run();
  return { day, bytes: payload.length };
}

// 惰性备份：当天没有备份时补一次
async function ensureTodayBackup(db) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare('SELECT day FROM backups WHERE day = ?').bind(day).first();
  if (!row) await doBackup(db);
}

// 备份列表（摘要）
async function listBackups(db) {
  const { results } = await db.prepare('SELECT day, created_at, LENGTH(payload) AS bytes FROM backups ORDER BY day DESC').all();
  return json({ ok: true, data: results });
}

// 下载某天备份 JSON
async function getBackup(db, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: '日期格式无效' }, 400);
  const row = await db.prepare('SELECT payload FROM backups WHERE day = ?').bind(day).first();
  if (!row) return json({ ok: false, error: '备份不存在' }, 404);
  return new Response(row.payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${day}.json"`,
      ...corsHeaders(),
    },
  });
}

// 从某天备份恢复（覆盖当前全部数据，原子执行）
async function restoreBackup(db, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: '日期格式无效' }, 400);
  const row = await db.prepare('SELECT payload FROM backups WHERE day = ?').bind(day).first();
  if (!row) return json({ ok: false, error: '备份不存在' }, 404);
  let data;
  try { data = JSON.parse(row.payload); } catch (e) { return json({ ok: false, error: '备份文件损坏' }, 500); }
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const items = Array.isArray(data.order_items) ? data.order_items : [];
  const inv = Array.isArray(data.inventory) ? data.inventory : [];
  const wanted = Array.isArray(data.wanted_books) ? data.wanted_books : [];

  const stmts = [];
  stmts.push(db.prepare('DELETE FROM order_items'));
  stmts.push(db.prepare('DELETE FROM orders'));
  stmts.push(db.prepare('DELETE FROM inventory'));
  stmts.push(db.prepare('DELETE FROM wanted_books'));
  for (const o of orders) {
    stmts.push(db.prepare(
      'INSERT INTO orders (id, delivery_method, delivery_building, sub_zone, pickup_location, deliver_time, contact, remark, status, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(o.id, o.delivery_method || 'delivery', o.delivery_building || '', o.sub_zone || '', o.pickup_location || '', o.deliver_time || null, o.contact || '', o.remark || '', o.status || 'pending', o.created_at, o.updated_at || o.created_at, o.deleted_at || null));
  }
  for (const it of items) {
    stmts.push(db.prepare('INSERT INTO order_items (id, order_id, book_name, quantity) VALUES (?,?,?,?)')
      .bind(it.id, it.order_id, it.book_name, it.quantity));
  }
  for (const v of inv) {
    stmts.push(db.prepare('INSERT INTO inventory (book_name, stock, updated_at) VALUES (?,?,?)')
      .bind(v.book_name, v.stock, v.updated_at || new Date().toISOString()));
  }
  for (const w of wanted) {
    stmts.push(db.prepare(
      'INSERT INTO wanted_books (id, book_name, quantity, contact, remark, status, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(w.id, w.book_name, w.quantity, w.contact || '', w.remark || '', w.status || 'open', w.created_at, w.updated_at || w.created_at, w.deleted_at || null));
  }
  // 单次 batch = 单事务：任一失败全部回滚，不会出现清空后没插回的中间态
  await db.batch(stmts);
  return json({ ok: true, data: { day, orders: orders.length, items: items.length, inventory: inv.length, wanted: wanted.length } });
}

// 顾客自助登记求书：必须留联系方式，数量限制 1~99 防滥用
async function createWantedPublic(db, body) {
  const err = validateWanted(body);
  if (err) return json({ ok: false, error: err }, 400);
  const contact = String(body.contact || '').trim();
  if (!contact) return json({ ok: false, error: '请填写联系方式' }, 400);
  if (Number(body.quantity) > 99) return json({ ok: false, error: '数量需≤99' }, 400);
  const now = new Date().toISOString();
  const res = await db.prepare(
    'INSERT INTO wanted_books (book_name, quantity, contact, remark, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(String(body.book_name).trim(), Number(body.quantity), contact, body.remark || '', 'open', now, now).run();
  return json({ ok: true, data: { id: Number(res.meta.last_row_id) } });
}

// 配送方式归一：缺省按 delivery（兼容旧数据/旧客户端）
function normMethod(body) {
  const m = body && body.delivery_method;
  return m === 'self_pickup' ? 'self_pickup' : 'delivery';
}

function validateOrder(body) {
  if (!body || typeof body !== 'object') return '请求体缺失';
  if (normMethod(body) === 'self_pickup') {
    // 自提：不需要大苑/楼号；自提地点可改，为空则默认
    if (body.pickup_location && !String(body.pickup_location).trim()) return '自提地点无效';
  } else {
    if (!BUILDINGS.includes(body.delivery_building)) return '无效的大苑';
    if (!validSubZone(body.delivery_building, body.sub_zone)) return '无效的编号';
  }
  if (!body.contact || !String(body.contact).trim()) return '请填写联系方式';
  if (!Array.isArray(body.items) || body.items.length === 0) return '请至少添加一行书';
  for (const it of body.items) {
    if (!it.book_name || !String(it.book_name).trim()) return '书名为空';
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) < 1) return '数量需为≥1的整数';
  }
  return null;
}

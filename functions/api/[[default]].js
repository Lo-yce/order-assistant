/**
 * 订单助手 —— EdgeOne Pages Functions API（KV 存储版）
 * 部署要求：
 *   1. 控制台「KV 存储」绑定命名空间，运行时变量名固定为：OA_DB
 *   2. 项目「环境变量」设置 ADMIN_PASSWORD（后台密码）
 * 数据结构（KV key 仅允许数字/字母/下划线）：
 *   orders    → JSON 数组：订单（含 items）
 *   inventory → JSON 数组：库存
 *   wanted    → JSON 数组：求书登记
 *   seq       → { order: 下一个订单id, wanted: 下一个求书id, item: 书籍行id }
 * 注意：KV 最终一致性最长 60s，多人同时编辑极端情况下可能互相覆盖（小团队场景可接受）。
 */
const BUILDINGS = ['大千苑18栋', '长江苑19栋', '大洲苑21栋', '培伦苑20栋'];
const STATUSES = ['pending', 'delivering', 'done'];
const WANTED_STATUSES = ['open', 'found'];
const METHODS = ['delivery', 'self_pickup']; // 配送 / 自提
const DEFAULT_PICKUP = '师生活动中心';

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
    (p === '/api/my-orders' && method === 'GET') ||
    (p === '/api/wanted/public' && method === 'POST')
  );
}

// 后台鉴权：X-Admin-Key 必须等于环境变量 ADMIN_PASSWORD（fail-closed）
function checkAdmin(request, env) {
  if (!env || !env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '后台密码未配置：请在 EdgeOne Pages 项目设置环境变量 ADMIN_PASSWORD', code: 'NO_PASSWORD' }, 401);
  }
  const key = request.headers.get('X-Admin-Key') || '';
  if (key !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '密码错误', code: 'UNAUTHORIZED' }, 401);
  }
  return null;
}

/* ---------- KV 读写 ---------- */
function kv() {
  const k = globalThis.OA_DB;
  if (!k) throw new Error('KV 未绑定：请在控制台为项目绑定命名空间，变量名 OA_DB');
  return k;
}

const DEFAULTS = {
  orders: [],
  inventory: [],
  wanted: [],
  seq: { order: 1, wanted: 1, item: 1 },
};

async function load(key) {
  const raw = await kv().get(key);
  if (raw == null) return JSON.parse(JSON.stringify(DEFAULTS[key]));
  try { return JSON.parse(raw); } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS[key])); }
}

async function save(key, val) {
  await kv().put(key, JSON.stringify(val));
}

/* ---------- 入口路由 ---------- */
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

  try {
    if (!isPublicPath(p, method)) {
      const denied = checkAdmin(request, env);
      if (denied) return denied;
    }

    // ===== 订单集合 =====
    if (p === '/api/orders') {
      if (method === 'GET') return await getOrders(url);
      if (method === 'POST') return await createOrder(await readBody(request));
    }

    // ===== 统计 / 书名联想 / 清空已完成 =====
    if (p === '/api/stats' && method === 'GET') return await getStats(url);
    if (p === '/api/book-names' && method === 'GET') return await getBookNames();
    if (p === '/api/clear-done' && method === 'POST') return await clearDone();

    // ===== 库存 =====
    if (p === '/api/inventory') {
      if (method === 'GET') return await getInventory();
      if (method === 'POST') return await importInventory(await readBody(request));
      if (method === 'DELETE') return await clearInventory();
    }

    // ===== 顾客按联系方式查单 =====
    if (p === '/api/my-orders' && method === 'GET') return await getMyOrders(url);

    // ===== 求书登记 =====
    if (p === '/api/wanted') {
      if (method === 'GET') return await getWanted(url);
      if (method === 'POST') return await createWanted(await readBody(request));
    }
    if (p === '/api/wanted/public' && method === 'POST') return await createWantedPublic(await readBody(request));

    // ===== 订单状态更新 =====
    let m = p.match(/^\/api\/orders\/(\d+)\/status$/);
    if (m && method === 'PATCH') return await updateStatus(Number(m[1]), await readBody(request));

    // ===== 单个订单 =====
    m = p.match(/^\/api\/orders\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'GET') return await getOrder(id);
      if (method === 'PUT') return await updateOrder(id, await readBody(request));
      if (method === 'DELETE') return await delOrder(id);
    }

    // ===== 求书状态 / 单条 =====
    m = p.match(/^\/api\/wanted\/(\d+)\/status$/);
    if (m && method === 'PATCH') return await updateWantedStatus(Number(m[1]), await readBody(request));

    m = p.match(/^\/api\/wanted\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') return await updateWanted(id, await readBody(request));
      if (method === 'DELETE') return await delWanted(id);
    }

    // ===== 一次性数据迁移（从 Cloudflare 版导入旧数据；管理员接口） =====
    if (p === '/api/migrate' && method === 'POST') return await migrateData(await readBody(request));

    return json({ ok: false, error: 'Not Found' }, 404);
  } catch (e) {
    return json({ ok: false, error: 'Server Error: ' + (e && e.message) }, 500);
  }
}

/* ---------- 排序：待/配送中按 deliver_time 空优先→升序；done 恒排最末 ---------- */
function sortOrders(list) {
  return [...list].sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
    const ta = a.deliver_time || '', tb = b.deliver_time || '';
    if (!ta && tb) return -1;
    if (ta && !tb) return 1;
    if (ta && tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
    return 0;
  });
}

async function getOrders(url) {
  const status = url.searchParams.get('status');
  let list = await load('orders');
  if (status) list = list.filter((o) => o.status === status);
  return json({ ok: true, data: sortOrders(list) });
}

async function getOrder(id) {
  const list = await load('orders');
  const found = list.find((o) => o.id === id);
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  return json({ ok: true, data: found });
}

async function createOrder(body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);

  const now = new Date().toISOString();
  const list = await load('orders');
  const seq = await load('seq');
  const id = seq.order++;
  const method = normMethod(body);

  const order = {
    id,
    delivery_method: method,
    delivery_building: method === 'delivery' ? body.delivery_building : '',
    sub_zone: method === 'delivery' ? body.sub_zone : '',
    pickup_location: method === 'self_pickup' ? String(body.pickup_location || DEFAULT_PICKUP).trim() : '',
    deliver_time: body.deliver_time || null,
    contact: body.contact || '',
    remark: body.remark || '',
    status: 'pending',
    created_at: now,
    updated_at: now,
    items: body.items.map((it) => ({ id: seq.item++, book_name: String(it.book_name).trim(), quantity: Number(it.quantity) })),
  };
  list.push(order);
  await save('orders', list);
  await save('seq', seq);
  return json({ ok: true, data: { id } });
}

async function updateOrder(id, body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);
  const list = await load('orders');
  const idx = list.findIndex((o) => o.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);

  const seq = await load('seq');
  const method = normMethod(body);
  list[idx] = {
    ...list[idx],
    delivery_method: method,
    delivery_building: method === 'delivery' ? body.delivery_building : '',
    sub_zone: method === 'delivery' ? body.sub_zone : '',
    pickup_location: method === 'self_pickup' ? String(body.pickup_location || DEFAULT_PICKUP).trim() : '',
    deliver_time: body.deliver_time || null,
    contact: body.contact || '',
    remark: body.remark || '',
    updated_at: new Date().toISOString(),
    items: body.items.map((it) => ({ id: seq.item++, book_name: String(it.book_name).trim(), quantity: Number(it.quantity) })),
  };
  await save('orders', list);
  await save('seq', seq);
  return json({ ok: true, data: { id } });
}

async function updateStatus(id, body) {
  if (!STATUSES.includes(body.status)) return json({ ok: false, error: '无效状态' }, 400);
  const list = await load('orders');
  const idx = list.findIndex((o) => o.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list[idx].status = body.status;
  list[idx].updated_at = new Date().toISOString();
  await save('orders', list);
  return json({ ok: true, data: { id, status: body.status } });
}

async function delOrder(id) {
  const list = await load('orders');
  const idx = list.findIndex((o) => o.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list.splice(idx, 1);
  await save('orders', list);
  return json({ ok: true, data: { id } });
}

async function clearDone() {
  const list = await load('orders');
  const deleted = list.filter((o) => o.status === 'done').length;
  await save('orders', list.filter((o) => o.status !== 'done'));
  return json({ ok: true, data: { deleted } });
}

/* ---------- 统计：需求合计 + 库存 + 剩余；可选 ?building= ---------- */
async function getStats(url) {
  const building = url.searchParams.get('building');
  const orders = await load('orders');
  const inventory = await load('inventory');

  const map = {};
  for (const o of orders) {
    if (building && o.delivery_building !== building) continue;
    for (const it of o.items || []) {
      const m = (map[it.book_name] = map[it.book_name] || { book_name: it.book_name, total_quantity: 0, order_count: 0, stock: null, remaining: null });
      m.total_quantity += it.quantity;
      m.order_count += 1;
    }
  }
  // 库存表：仅在未按苑筛选时纳入"只有库存、暂无订单"的书
  if (!building) {
    for (const v of inventory) {
      if (!map[v.book_name]) map[v.book_name] = { book_name: v.book_name, total_quantity: 0, order_count: 0, stock: null, remaining: null };
    }
  }
  const invMap = {};
  for (const v of inventory) invMap[v.book_name] = v.stock;
  const list = Object.values(map);
  for (const r of list) {
    if (r.book_name in invMap) {
      r.stock = invMap[r.book_name];
      r.remaining = r.stock - r.total_quantity;
    }
  }
  list.sort((a, b) => b.total_quantity - a.total_quantity || (a.book_name < b.book_name ? -1 : 1));
  return json({ ok: true, data: list });
}

async function getBookNames() {
  const orders = await load('orders');
  const use = {};
  for (const o of orders) for (const it of o.items || []) use[it.book_name] = (use[it.book_name] || 0) + 1;
  return json({ ok: true, data: Object.keys(use).sort((a, b) => use[b] - use[a]) });
}

async function getInventory() {
  const list = await load('inventory');
  list.sort((a, b) => (a.book_name < b.book_name ? -1 : 1));
  return json({ ok: true, data: list });
}

async function clearInventory() {
  const list = await load('inventory');
  await save('inventory', []);
  return json({ ok: true, data: { deleted: list.length } });
}

async function importInventory(body) {
  const items = Array.isArray(body) ? body : body && body.items;
  if (!Array.isArray(items) || items.length === 0) return json({ ok: false, error: '请提供非空的 items 数组' }, 400);
  const clean = [];
  for (const it of items) {
    const name = it && it.book_name != null ? String(it.book_name).trim() : '';
    const stock = Number(it && it.stock);
    if (!name) return json({ ok: false, error: '存在空书名' }, 400);
    if (!Number.isFinite(stock) || stock < 0 || Math.round(stock) !== stock) return json({ ok: false, error: `「${name}」库存需为≥0的整数` }, 400);
    clean.push({ book_name: name, stock, updated_at: new Date().toISOString() });
  }
  const list = await load('inventory');
  const map = {};
  for (const v of list) map[v.book_name] = v;
  for (const c of clean) map[c.book_name] = c;
  await save('inventory', Object.values(map));
  return json({ ok: true, data: { imported: clean.length } });
}

/* ---------- 顾客按联系方式查单（最多 20 条） ---------- */
async function getMyOrders(url) {
  const contact = (url.searchParams.get('contact') || '').trim();
  if (!contact) return json({ ok: false, error: '请填写下单时的联系方式' }, 400);
  const orders = await load('orders');
  const list = orders
    .filter((o) => o.contact === contact)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 20)
    .map((o) => ({
      id: o.id, delivery_method: o.delivery_method, delivery_building: o.delivery_building, sub_zone: o.sub_zone,
      pickup_location: o.pickup_location, deliver_time: o.deliver_time, status: o.status, created_at: o.created_at,
      items: (o.items || []).map((it) => ({ book_name: it.book_name, quantity: it.quantity })),
    }));
  return json({ ok: true, data: list });
}

/* ---------- 求书登记 ---------- */
async function getWanted(url) {
  const status = url.searchParams.get('status');
  let list = await load('wanted');
  if (status) list = list.filter((w) => w.status === status);
  // 待找到在前（先登的先找），已找到排后
  list = [...list].sort((a, b) => {
    if ((a.status === 'found') !== (b.status === 'found')) return a.status === 'found' ? 1 : -1;
    return a.created_at < b.created_at ? -1 : 1;
  });
  return json({ ok: true, data: list });
}

async function insertWanted(body, extraCheck) {
  const err = validateWanted(body);
  if (err) return { err: json({ ok: false, error: err }, 400) };
  if (extraCheck) {
    const denied = extraCheck(body);
    if (denied) return { err: denied };
  }
  const now = new Date().toISOString();
  const list = await load('wanted');
  const seq = await load('seq');
  const id = seq.wanted++;
  list.push({
    id,
    book_name: String(body.book_name).trim(),
    quantity: Number(body.quantity),
    contact: body.contact || '',
    remark: body.remark || '',
    status: 'open',
    created_at: now,
    updated_at: now,
  });
  await save('wanted', list);
  await save('seq', seq);
  return { id };
}

async function createWanted(body) {
  const r = await insertWanted(body);
  if (r.err) return r.err;
  return json({ ok: true, data: { id: r.id } });
}

// 顾客自助登记：必须留联系方式，数量限制 1~99 防滥用
async function createWantedPublic(body) {
  const contact = String((body && body.contact) || '').trim();
  if (!contact) return json({ ok: false, error: '请填写联系方式' }, 400);
  const r = await insertWanted(body, (b) => (Number(b.quantity) > 99 ? json({ ok: false, error: '数量需≤99' }, 400) : null));
  if (r.err) return r.err;
  return json({ ok: true, data: { id: r.id } });
}

async function updateWanted(id, body) {
  const err = validateWanted(body);
  if (err) return json({ ok: false, error: err }, 400);
  const list = await load('wanted');
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list[idx] = {
    ...list[idx],
    book_name: String(body.book_name).trim(),
    quantity: Number(body.quantity),
    contact: body.contact || '',
    remark: body.remark || '',
    updated_at: new Date().toISOString(),
  };
  await save('wanted', list);
  return json({ ok: true, data: { id } });
}

async function updateWantedStatus(id, body) {
  if (!WANTED_STATUSES.includes(body.status)) return json({ ok: false, error: '无效状态' }, 400);
  const list = await load('wanted');
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list[idx].status = body.status;
  list[idx].updated_at = new Date().toISOString();
  await save('wanted', list);
  return json({ ok: true, data: { id, status: body.status } });
}

async function delWanted(id) {
  const list = await load('wanted');
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list.splice(idx, 1);
  await save('wanted', list);
  return json({ ok: true, data: { id } });
}

/* ---------- 一次性迁移：整体导入旧数据（会覆盖现有 KV 数据） ---------- */
async function migrateData(body) {
  if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体缺失' }, 400);
  const orders = Array.isArray(body.orders) ? body.orders : null;
  const inventory = Array.isArray(body.inventory) ? body.inventory : null;
  const wanted = Array.isArray(body.wanted) ? body.wanted : null;
  if (!orders || !inventory || !wanted) return json({ ok: false, error: '需提供 orders / inventory / wanted 三个数组' }, 400);

  // 重算自增序号
  const seq = { order: 1, wanted: 1, item: 1 };
  for (const o of orders) {
    if (o.id >= seq.order) seq.order = o.id + 1;
    for (const it of o.items || []) if (it.id >= seq.item) seq.item = it.id + 1;
  }
  for (const w of wanted) if (w.id >= seq.wanted) seq.wanted = w.id + 1;

  await save('orders', orders);
  await save('inventory', inventory);
  await save('wanted', wanted);
  await save('seq', seq);
  return json({ ok: true, data: { orders: orders.length, inventory: inventory.length, wanted: wanted.length } });
}

/* ---------- 校验 ---------- */
function validateWanted(body) {
  if (!body || typeof body !== 'object') return '请求体缺失';
  if (!body.book_name || !String(body.book_name).trim()) return '书名为空';
  if (!Number.isInteger(Number(body.quantity)) || Number(body.quantity) < 1) return '数量需为≥1的整数';
  return null;
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

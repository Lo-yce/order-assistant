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
    (p === '/api/book-stock' && method === 'GET') ||
    (/^\/api\/orders\/\d+\/cancel$/.test(p) && method === 'POST') ||
    (p === '/api/my-orders' && method === 'GET') ||
    (p === '/api/wanted/public' && method === 'POST')
  );
}

// 后台鉴权：X-Admin-Key 必须等于环境变量 ADMIN_PASSWORD（fail-closed）
async function checkAdmin(request, env) {
  if (!env || !env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '后台密码未配置：请在 EdgeOne Pages 项目设置环境变量 ADMIN_PASSWORD', code: 'NO_PASSWORD' }, 401);
  }
  const key = request.headers.get('X-Admin-Key') || '';
  if (key !== env.ADMIN_PASSWORD) {
    try { await logAudit(request, 'login.fail', '', '密码错误，拒绝访问'); } catch (e) {}
    return json({ ok: false, error: '密码错误', code: 'UNAUTHORIZED' }, 401);
  }
  return null;
}

// ===== 操作日志（KV 版：audits key，滚动保留 500 条） =====
async function logAudit(request, action, target, detail, actorOverride) {
  try {
    const audits = await load('audits');
    const operator = request.headers.get('X-Operator') || '';
    const key = request.headers.get('X-Admin-Key') || '';
    const tail = key ? key.slice(-4) : '';
    const actor = actorOverride || operator || (tail ? `未署名(${tail})` : '未知');
    audits.unshift({ at: new Date().toISOString(), actor, ip: '', action, target: target || '', detail: detail || '' });
    await save('audits', audits.slice(0, 500));
  } catch (e) { /* 日志失败不影响主流程 */ }
}

async function getAudit() {
  return json({ ok: true, data: (await load('audits')).slice(0, 200) });
}

// 书名改名/合并：from 的订单需求全部并入 to；库存若 to 已存在则删 from（保留 to 的库存），否则改名为 to
async function renameBook(body) {
  const from = String((body && body.from) || '').trim();
  const to = String((body && body.to) || '').trim();
  if (!from || !to) return json({ ok: false, error: '请填写原书名和新书名' }, 400);
  if (from === to) return json({ ok: false, error: '新书名不能与原书名相同' }, 400);

  let ordersChanged = 0;
  const orders = await load('orders');
  for (const o of orders) {
    for (const it of o.items || []) {
      if (it.book_name === from) { it.book_name = to; ordersChanged++; }
    }
  }
  await save('orders', orders);

  let invNote = '无库存记录';
  const inv = await load('inventory');
  const idxFrom = inv.findIndex((v) => v.book_name === from);
  if (idxFrom >= 0) {
    if (inv.some((v) => v.book_name === to)) {
      invNote = `目标已有库存 ${inv.find((v) => v.book_name === to).stock} 本，保留并删除旧库存 ${inv[idxFrom].stock} 本`;
      inv.splice(idxFrom, 1);
    } else {
      invNote = `库存 ${inv[idxFrom].stock} 本已随改名`;
      inv[idxFrom].book_name = to;
      inv[idxFrom].updated_at = new Date().toISOString();
    }
    await save('inventory', inv);
  }
  return json({ ok: true, data: { from, to, orders: ordersChanged, invNote } });
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
  backups: [],
  audits: [],
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
      const denied = await checkAdmin(request, env);
      if (denied) return denied;
    }

    // ===== 订单集合 =====
    if (p === '/api/orders') {
      if (method === 'GET') return await getOrders(url);
      if (method === 'POST') {
        const body = await readBody(request);
        const place = normMethod(body) === 'self_pickup' ? `自提·${String(body.pickup_location || '').trim() || '默认'}` : `${body.delivery_building} ${body.sub_zone}`;
        await logAudit(request, 'order.create', '', `${place}，${(body.items || []).length} 本书`, '顾客');
        return await createOrder(body);
      }
    }

    // ===== 统计 / 书名联想 / 清空已完成 =====
    if (p === '/api/stats' && method === 'GET') return await getStats(url);
    if (p === '/api/book-names' && method === 'GET') return await getBookNames();
    if (p === '/api/book-stock' && method === 'GET') return await getBookStock();
    if (p === '/api/clear-done' && method === 'POST') {
      await logAudit(request, 'order.clearDone', '', '已完成/已取消订单移入回收站');
      return await clearDone();
    }

    // ===== 回收站（软删订单/求书：列表/还原/彻底删/清空） =====
    if (p === '/api/recycle' && method === 'GET') return await getRecycle();
    if (p === '/api/recycle/restore' && method === 'POST') {
      const body = await readBody(request);
      await logAudit(request, 'recycle.restore', `${body && body.type === 'order' ? '订单' : '求书'}#${body && body.id}`, '从回收站还原');
      return await recycleRestore(body);
    }
    if (p === '/api/recycle/item' && method === 'DELETE') {
      const body = await readBody(request);
      await logAudit(request, 'recycle.purge', `${body && body.type === 'order' ? '订单' : '求书'}#${body && body.id}`, '彻底删除');
      return await recyclePurgeItem(body);
    }
    if (p === '/api/recycle/empty' && method === 'POST') {
      await logAudit(request, 'recycle.empty', '', '清空回收站');
      return await recycleEmpty();
    }

    // ===== 库存 =====
    if (p === '/api/inventory') {
      if (method === 'GET') return await getInventory();
      if (method === 'POST') {
        const body = await readBody(request);
        const items = (body && body.items) || body || [];
        await logAudit(request, 'inventory.set', items.length > 1 ? `${items.length} 本书` : (items[0] && items[0].book_name) || '', items.map((i) => `${i.book_name}=${i.stock}`).join('、').slice(0, 200));
        return await importInventory(body);
      }
      if (method === 'DELETE') {
        await logAudit(request, 'inventory.clear', '', '清空库存');
        return await clearInventory();
      }
    }
    if (p === '/api/inventory/item' && method === 'DELETE') {
      const body = await readBody(request);
      await logAudit(request, 'inventory.delete', (body && body.book_name) || '', '删除库存记录');
      return await deleteInventoryItem(body);
    }

    // ===== 顾客按联系方式查单 =====
    if (p === '/api/my-orders' && method === 'GET') return await getMyOrders(url);

    // ===== 求书登记 =====
    if (p === '/api/wanted') {
      if (method === 'GET') return await getWanted(url);
      if (method === 'POST') {
        const body = await readBody(request);
        await logAudit(request, 'wanted.create', String((body && body.book_name) || '').trim(), `×${Number(body && body.quantity) || ''}`);
        return await createWanted(body);
      }
    }
    if (p === '/api/wanted/public' && method === 'POST') {
      const body = await readBody(request);
      await logAudit(request, 'wanted.create', String((body && body.book_name) || '').trim(), `×${Number(body && body.quantity) || ''}`, '顾客');
      return await createWantedPublic(body);
    }

    // ===== 订单状态更新 =====
    let m = p.match(/^\/api\/orders\/(\d+)\/status$/);
    if (m && method === 'PATCH') {
      const body = await readBody(request);
      await logAudit(request, 'order.status', `#${m[1]}`, `状态 → ${body && body.status}`);
      return await updateStatus(Number(m[1]), body);
    }

    // ===== 顾客自助取消（公开） =====
    m = p.match(/^\/api\/orders\/(\d+)\/cancel$/);
    if (m && method === 'POST') {
      const body = await readBody(request);
      await logAudit(request, 'order.cancel', `#${m[1]}`, '顾客自助取消', '顾客');
      return await cancelOrderPublic(Number(m[1]), body);
    }

    // ===== 单个订单 =====
    m = p.match(/^\/api\/orders\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'GET') return await getOrder(id);
      if (method === 'PUT') {
        const body = await readBody(request);
        const place = normMethod(body) === 'self_pickup' ? `自提·${String(body.pickup_location || '').trim() || '默认'}` : `${body.delivery_building} ${body.sub_zone}`;
        await logAudit(request, 'order.update', `#${id}`, `改为 ${place}，${(body.items || []).length} 本书`);
        return await updateOrder(id, body);
      }
      if (method === 'DELETE') {
        await logAudit(request, 'order.delete', `#${id}`, '移入回收站');
        return await delOrder(id);
      }
    }

    // ===== 求书状态 / 单条 =====
    m = p.match(/^\/api\/wanted\/(\d+)\/status$/);
    if (m && method === 'PATCH') {
      const body = await readBody(request);
      await logAudit(request, 'wanted.status', `#${m[1]}`, `状态 → ${body && body.status}`);
      return await updateWantedStatus(Number(m[1]), body);
    }

    m = p.match(/^\/api\/wanted\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const body = await readBody(request);
        await logAudit(request, 'wanted.update', `#${id}`, `${String((body && body.book_name) || '').trim()} ×${Number(body && body.quantity) || ''}`);
        return await updateWanted(id, body);
      }
      if (method === 'DELETE') {
        await logAudit(request, 'wanted.delete', `#${id}`, '移入回收站');
        return await delWanted(id);
      }
    }

    // ===== 备份（列表/下载/恢复/手动立即备份） =====
    if (p === '/api/backups' && method === 'GET') return await listBackups();
    if (p === '/api/backups/now' && method === 'POST') {
      const r = await doBackup();
      await logAudit(request, 'backup.create', r.day, `手动备份 ${Math.round(r.bytes / 1024)} KB`);
      return json({ ok: true, data: r });
    }
    let bm = p.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2})\/restore$/);
    if (bm && method === 'POST') {
      await logAudit(request, 'backup.restore', bm[1], '恢复备份');
      return await restoreBackup(bm[1]);
    }
    bm = p.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2})$/);
    if (bm && method === 'GET') return await getBackup(bm[1]);

    // ===== 操作日志查询 =====
    if (p === '/api/audit' && method === 'GET') return await getAudit();

    // ===== 书名管理：改名/合并 =====
    if (p === '/api/book-names/rename' && method === 'POST') {
      const body = await readBody(request);
      const from = String((body && body.from) || '').trim();
      const to = String((body && body.to) || '').trim();
      await logAudit(request, 'book.rename', from, `改名为「${to}」`);
      return await renameBook(body);
    }

    // ===== 一次性数据迁移（从 Cloudflare 版导入旧数据；管理员接口） =====
    if (p === '/api/migrate' && method === 'POST') return await migrateData(await readBody(request));

    return json({ ok: false, error: 'Not Found' }, 404);
  } catch (e) {
    return json({ ok: false, error: 'Server Error: ' + (e && e.message) }, 500);
  }
}

/* ---------- 排序（配送路线 + 时效兼顾）----------
 * 进行中在前；待配送 > 配送中；配送单在前自提最后；同苑聚合；
 * 苑内时间优先（尽快 > 预定时间早的）；同时间才按楼号自然序 */
const BUILDING_ORDER = ['大千苑18栋', '长江苑19栋', '大洲苑21栋', '培伦苑20栋'];

function subKey(o) {
  const m = String(o.sub_zone || '').match(/(\d+)-(\d+)/);
  if (!m) return [9999, 9999];
  return [Number(m[1]), Number(m[2])];
}

function sortOrders(list) {
  return [...list].sort((a, b) => {
    const ended = (o) => o.status === 'done' || o.status === 'cancelled';
    if (ended(a) !== ended(b)) return ended(a) ? 1 : -1;

    const stRank = (o) => (o.status === 'pending' ? 0 : o.status === 'delivering' ? 1 : 2);
    if (stRank(a) !== stRank(b)) return stRank(a) - stRank(b);

    const pickRank = (o) => (o.delivery_method === 'self_pickup' ? 1 : 0);
    if (pickRank(a) !== pickRank(b)) return pickRank(a) - pickRank(b);

    const bc = BUILDING_ORDER.indexOf(a.delivery_building) - BUILDING_ORDER.indexOf(b.delivery_building);
    if (bc !== 0) return bc;

    // 苑内时间优先：尽快 > 早的预定时间；同时间才看楼号
    if (!a.deliver_time && b.deliver_time) return -1;
    if (a.deliver_time && !b.deliver_time) return 1;
    const tc = String(a.deliver_time || '').localeCompare(String(b.deliver_time || ''));
    if (tc !== 0) return tc;

    const [ab, au] = subKey(a), [bb, bu] = subKey(b);
    if (ab !== bb) return ab - bb;
    return au - bu;
  });
}

async function getOrders(url) {
  const status = url.searchParams.get('status');
  // 每日惰性备份：当天还没有备份时顺手做一次（cron 失效的兜底）
  try { await ensureTodayBackup(); } catch (e) {}
  let list = await load('orders');
  list = list.filter((o) => !o.deleted_at); // 软删不显示
  if (status) list = list.filter((o) => o.status === status);
  return json({ ok: true, data: sortOrders(list) });
}

async function getOrder(id) {
  const list = await load('orders');
  const found = list.find((o) => o.id === id && !o.deleted_at);
  if (!found) return json({ ok: false, error: 'Not Found' }, 404);
  return json({ ok: true, data: found });
}

async function createOrder(body) {
  const err = validateOrder(body);
  if (err) return json({ ok: false, error: err }, 400);

  // 防刷单：同联系方式 10 分钟内最多 3 单
  const contact = String(body.contact || '').trim();
  const all = await load('orders');
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recent = all.filter((o) => o.contact === contact && !o.deleted_at && o.created_at > cutoff);
  if (recent.length >= 3) {
    return json({ ok: false, error: '下单太频繁啦，请稍等几分钟再试（10 分钟内最多 3 单）' }, 429);
  }

  const now = new Date().toISOString();
  const list = all;
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
    contact,
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
  // 软删除：进回收站，可还原
  const list = await load('orders');
  const idx = list.findIndex((o) => o.id === id && !o.deleted_at);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list[idx].deleted_at = new Date().toISOString();
  list[idx].updated_at = list[idx].deleted_at;
  await save('orders', list);
  return json({ ok: true, data: { id } });
}

async function clearDone() {
  // 软删除：已完成/已取消整批进回收站
  const list = await load('orders');
  const now = new Date().toISOString();
  let deleted = 0;
  for (const o of list) {
    if ((o.status === 'done' || o.status === 'cancelled') && !o.deleted_at) {
      o.deleted_at = now;
      o.updated_at = now;
      deleted++;
    }
  }
  await save('orders', list);
  return json({ ok: true, data: { deleted } });
}

/* ---------- 统计：需求合计 + 库存 + 剩余；可选 ?building= ---------- */
async function getStats(url) {
  const building = url.searchParams.get('building');
  const orders = await load('orders');
  const inventory = await load('inventory');

  const map = {};
  for (const o of orders) {
    if (o.status === 'cancelled' || o.deleted_at) continue; // 已取消/已删除订单不计入需求统计
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

/* 公开：书名 + 剩余库存（顾客下单联想用；remaining 为 null 表示未维护库存） */
async function getBookStock() {
  const orders = await load('orders');
  const inventory = await load('inventory');
  const demand = {};
  for (const o of orders) {
    if (o.status === 'cancelled' || o.deleted_at) continue; // 已取消/已删除订单不计需求
    for (const it of o.items || []) demand[it.book_name] = (demand[it.book_name] || 0) + it.quantity;
  }
  const list = [];
  const seen = {};
  for (const v of inventory) {
    seen[v.book_name] = true;
    list.push({ book_name: v.book_name, remaining: v.stock - (demand[v.book_name] || 0) });
  }
  for (const n of Object.keys(demand)) {
    if (!seen[n]) list.push({ book_name: n, remaining: null }); // 只有订单没有库存记录
  }
  return json({ ok: true, data: list });
}

/* 公开：顾客自助取消订单（仅待配送状态且下单 30 分钟内，联系方式需匹配） */
async function cancelOrderPublic(id, body) {
  const contact = String((body && body.contact) || '').trim();
  if (!contact) return json({ ok: false, error: '缺少联系方式' }, 400);
  const list = await load('orders');
  const idx = list.findIndex((o) => o.id === id && !o.deleted_at);
  if (idx < 0) return json({ ok: false, error: '订单不存在' }, 404);
  const o = list[idx];
  if (o.contact !== contact) return json({ ok: false, error: '联系方式与订单不符，无法取消' }, 403);
  if (o.status !== 'pending') return json({ ok: false, error: '该订单已在处理中，无法自助取消，请直接联系我们' }, 400);
  const created = new Date(o.created_at).getTime();
  if (!Number.isFinite(created) || Date.now() - created > 30 * 60 * 1000) {
    return json({ ok: false, error: '下单已超过 30 分钟，无法自助取消，请直接联系我们' }, 400);
  }
  o.status = 'cancelled';
  o.updated_at = new Date().toISOString();
  await save('orders', list);
  return json({ ok: true, data: { id } });
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

// 删除单条库存（库存改名时由前端组合使用）
async function deleteInventoryItem(body) {
  const name = body && body.book_name != null ? String(body.book_name).trim() : '';
  if (!name) return json({ ok: false, error: '缺少书名' }, 400);
  const list = await load('inventory');
  const keep = list.filter((v) => v.book_name !== name);
  await save('inventory', keep);
  return json({ ok: true, data: { deleted: list.length - keep.length } });
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
    .filter((o) => o.contact === contact && !o.deleted_at)
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
  list = list.filter((w) => !w.deleted_at); // 软删不显示
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
  // 软删除：进回收站，可还原
  const list = await load('wanted');
  const idx = list.findIndex((w) => w.id === id && !w.deleted_at);
  if (idx < 0) return json({ ok: false, error: 'Not Found' }, 404);
  list[idx].deleted_at = new Date().toISOString();
  list[idx].updated_at = list[idx].deleted_at;
  await save('wanted', list);
  return json({ ok: true, data: { id } });
}

/* ---------- 回收站（软删数据：7 天后彻底清理） ---------- */
const RECYCLE_TTL = 7 * 24 * 60 * 60 * 1000;

// 惰性清理：读取回收站时顺手彻底删除超 7 天的软删数据
async function recycleSweep() {
  const cutoff = new Date(Date.now() - RECYCLE_TTL).toISOString();
  const orders = await load('orders');
  const keepO = orders.filter((o) => !o.deleted_at || o.deleted_at >= cutoff);
  if (keepO.length !== orders.length) await save('orders', keepO);
  const wanted = await load('wanted');
  const keepW = wanted.filter((w) => !w.deleted_at || w.deleted_at >= cutoff);
  if (keepW.length !== wanted.length) await save('wanted', keepW);
}

async function getRecycle() {
  await recycleSweep();
  const orders = (await load('orders')).filter((o) => o.deleted_at);
  const wanted = (await load('wanted')).filter((w) => w.deleted_at);
  return json({ ok: true, data: { orders, wanted } });
}

async function recycleRestore(body) {
  const type = body && body.type;
  const id = Number(body && body.id);
  if (!['order', 'wanted'].includes(type) || !Number.isInteger(id)) return json({ ok: false, error: '参数无效' }, 400);
  if (type === 'order') {
    const list = await load('orders');
    const item = list.find((o) => o.id === id && o.deleted_at);
    if (!item) return json({ ok: false, error: '记录不存在' }, 404);
    item.deleted_at = null;
    await save('orders', list);
  } else {
    const list = await load('wanted');
    const item = list.find((w) => w.id === id && w.deleted_at);
    if (!item) return json({ ok: false, error: '记录不存在' }, 404);
    item.deleted_at = null;
    await save('wanted', list);
  }
  return json({ ok: true, data: { id } });
}

async function recyclePurgeItem(body) {
  const type = body && body.type;
  const id = Number(body && body.id);
  if (!['order', 'wanted'].includes(type) || !Number.isInteger(id)) return json({ ok: false, error: '参数无效' }, 400);
  if (type === 'order') {
    const list = await load('orders');
    const keep = list.filter((o) => !(o.id === id && o.deleted_at));
    if (keep.length === list.length) return json({ ok: false, error: '记录不存在' }, 404);
    await save('orders', keep);
  } else {
    const list = await load('wanted');
    const keep = list.filter((w) => !(w.id === id && w.deleted_at));
    if (keep.length === list.length) return json({ ok: false, error: '记录不存在' }, 404);
    await save('wanted', keep);
  }
  return json({ ok: true, data: { id } });
}

async function recycleEmpty() {
  const orders = await load('orders');
  const keepO = orders.filter((o) => !o.deleted_at);
  const wanted = await load('wanted');
  const keepW = wanted.filter((w) => !w.deleted_at);
  await save('orders', keepO);
  await save('wanted', keepW);
  return json({ ok: true, data: { deleted: orders.length - keepO.length + wanted.length - keepW.length } });
}

/* ---------- 每日自动备份（保留近 7 天，可下载/恢复） ---------- */
async function doBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const orders = await load('orders');
  const inventory = await load('inventory');
  const wanted = await load('wanted');
  const payload = JSON.stringify({ version: 1, day, orders, inventory, wanted });
  const backups = await load('backups');
  const idx = backups.findIndex((b) => b.day === day);
  const entry = { day, payload, created_at: new Date().toISOString() };
  if (idx >= 0) backups[idx] = entry; else backups.unshift(entry);
  await save('backups', backups.slice(0, 7)); // 只保留最近 7 天
  return { day, bytes: payload.length };
}

// 惰性备份：当天没有备份时补一次
async function ensureTodayBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const backups = await load('backups');
  if (!backups.some((b) => b.day === day)) await doBackup();
}

async function listBackups() {
  const backups = await load('backups');
  return json({ ok: true, data: backups.map((b) => ({ day: b.day, created_at: b.created_at, bytes: b.payload.length })) });
}

function findBackup(backups, day) {
  return backups.find((b) => b.day === day);
}

async function getBackup(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: '日期格式无效' }, 400);
  const b = findBackup(await load('backups'), day);
  if (!b) return json({ ok: false, error: '备份不存在' }, 404);
  return new Response(b.payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${day}.json"`,
      ...corsHeaders(),
    },
  });
}

// 从某天备份恢复（覆盖当前全部数据）
async function restoreBackup(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: '日期格式无效' }, 400);
  const b = findBackup(await load('backups'), day);
  if (!b) return json({ ok: false, error: '备份不存在' }, 404);
  let data;
  try { data = JSON.parse(b.payload); } catch (e) { return json({ ok: false, error: '备份文件损坏' }, 500); }
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const inventory = Array.isArray(data.inventory) ? data.inventory : [];
  const wanted = Array.isArray(data.wanted) ? data.wanted : [];

  await save('orders', orders);
  await save('inventory', inventory);
  await save('wanted', wanted);

  // 重算自增序号（避免恢复后新记录 id 冲突）
  const seq = { order: 1, wanted: 1, item: 1 };
  for (const o of orders) {
    if (o.id >= seq.order) seq.order = o.id + 1;
    for (const it of o.items || []) if (it.id >= seq.item) seq.item = it.id + 1;
  }
  for (const w of wanted) if (w.id >= seq.wanted) seq.wanted = w.id + 1;
  await save('seq', seq);
  return json({ ok: true, data: { day, orders: orders.length, inventory: inventory.length, wanted: wanted.length } });
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

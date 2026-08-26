/* ===== 订单助手 后台逻辑 ===== */
/* 部署时把 WORKER_BASE 改成你的 Cloudflare Workers 地址 */
const WORKER_BASE = "https://your-worker.workers.dev";

const BUILDINGS = {
  "大千苑18栋": ["18-1", "18-2", "18-3", "18-4"],
  "长江苑19栋": ["19-1", "19-2", "19-3", "19-4"],
  "大洲苑21栋": ["21-1", "21-2", "21-3", "21-4"],
  "培伦苑20栋": ["20-1", "20-2", "20-3", "20-4"],
};
const BUILD_ICONS = {
  "大千苑18栋": "bi-building",
  "长江苑19栋": "bi-building-columns",
  "大洲苑21栋": "bi-houses",
  "培伦苑20栋": "bi-p-square",
};
const STATUS = {
  pending: { name: "待配送", cls: "pending" },
  delivering: { name: "配送中", cls: "delivering" },
  done: { name: "已完成", cls: "done" },
};

const state = {
  orders: [],
  bookNames: [],
  stats: [],
  currentTab: "dashboard",
  building: null, // 区域配送进入时的苑过滤
  sub: null,      // 编号过滤
  statusFilter: "all",
};

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);

function fmtTime(iso) {
  if (!iso) return "尽快配送";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` +
    (sameDay ? "（今天）" : "");
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(val) {
  if (!val) return "";
  const d = new Date(val);
  return isNaN(d) ? "" : d.toISOString();
}

/* ---------- API ---------- */
async function api(path, method = "GET", body) {
  const res = await fetch(WORKER_BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data.data;
}

async function loadOrders() {
  try { state.orders = await api("/api/orders"); } catch (e) { toast(e.message); }
}
async function loadBookNames() {
  try { state.bookNames = await api("/api/book-names"); } catch (e) {}
}
async function loadStats() {
  try { state.stats = await api("/api/stats"); renderStats(); } catch (e) { toast(e.message); }
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- 弹窗确认 ---------- */
function confirmModal(title, text, onOk) {
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  $("#modalMask").classList.add("show");
  window._modalOk = onOk;
}
window.closeModal = function () { $("#modalMask").classList.remove("show"); };
window.confirmGo = function () {
  const fn = window._modalOk;
  window.closeModal();
  if (fn) fn();
};
$("#modalOk").onclick = window.confirmGo;

/* ---------- 路由 ---------- */
function parseHash() {
  let h = location.hash || "#/dashboard";
  if (h === "#") h = "#/dashboard";
  const qIdx = h.indexOf("?");
  const path = (qIdx >= 0 ? h.slice(0, qIdx) : h).replace(/^#/, "");
  const params = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : "");
  let tab = "dashboard";
  if (path.startsWith("/orders")) tab = "orders";
  else if (path.startsWith("/new")) tab = "new";
  else if (path.startsWith("/edit")) tab = "edit";
  else if (path.startsWith("/stats")) tab = "stats";
  else if (path.startsWith("/history")) tab = "history";
  return {
    tab,
    building: params.get("b"),
    sub: params.get("s"),
    editId: path.startsWith("/edit") ? Number(params.get("id")) : null,
  };
}

function navigate(tab, params) {
  let p = "/" + (tab === "new" ? "new" : tab === "edit" ? "edit" : tab);
  if (tab === "dashboard") p = "/dashboard";
  else if (tab === "orders") p = "/orders";
  const q = [];
  if (params) {
    if (params.building) q.push("b=" + encodeURIComponent(params.building));
    if (params.sub) q.push("s=" + encodeURIComponent(params.sub));
    if (params.id != null) q.push("id=" + params.id);
  }
  location.hash = p + (q.length ? "?" + q.join("&") : "");
}

window.addEventListener("hashchange", render);
window.addEventListener("hashchange", setNavActive);

/* ---------- 导航激活 ---------- */
function setNavActive() {
  const r = parseHash();
  const map = { dashboard: "dashboard", orders: "orders", new: "new", edit: "new", stats: "stats", history: "history" };
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === map[r.tab]);
  });
}

/* ---------- 渲染入口 ---------- */
function render() {
  const r = parseHash();
  state.currentTab = r.tab;
  state.building = r.building;
  state.sub = r.sub;
  state.statusFilter = "all";

  document.querySelectorAll(".page").forEach((pg) => pg.classList.remove("active"));
  setNavActive();

  if (r.tab === "dashboard") { showPage("dashboard"); renderDashboard(); return; }
  if (r.tab === "orders") { showPage("orders"); renderOrders(); return; }
  if (r.tab === "new") { showPage("form"); renderForm(null); return; }
  if (r.tab === "edit") {
    const order = state.orders.find((o) => o.id === r.editId);
    showPage("form");
    renderForm(order || null);
    return;
  }
  if (r.tab === "stats") { showPage("stats"); loadStats(); return; }
  if (r.tab === "history") { showPage("history"); renderHistory(); return; }
}
function showPage(id) { $("#page-" + id).classList.add("active"); }

/* ---------- 区域配送（首页） ---------- */
function renderDashboard() {
  const pendingCount = (b) => state.orders.filter((o) => o.delivery_building === b && o.status !== "done").length;
  const totalPending = state.orders.filter((o) => o.status === "pending").length;
  $("#topSub").textContent = `共 ${state.orders.length} 单 · ${totalPending} 单待配送`;

  let html = '<h2 style="margin:6px 0 14px">选择配送区域</h2>';
  for (const b of Object.keys(BUILDINGS)) {
    const c = pendingCount(b);
    html += `<a class="building-card" href="#/orders?b=${encodeURIComponent(b)}">
      <div class="icon"><i class="bi ${BUILD_ICONS[b]}"></i></div>
      <div>
        <div class="name">${b}</div>
        <div class="meta">${c} 单待配送 / 配送中</div>
      </div>
      ${c > 0 ? `<div class="badge">${c}</div>` : ""}
    </a>`;
  }
  $("#dashboardInner").innerHTML = html;
}

/* ---------- 订单列表 ---------- */
function renderOrders() {
  const r = parseHash();
  $("#topSub").textContent = r.building ? `${r.building} 订单` : "全部订单";

  // 状态 chips + 区域/编号筛选
  let chips = `<button class="chip all ${state.statusFilter === "all" ? "active" : ""}" onclick="App.setStatusFilter('all')">全部</button>
    <button class="chip ${state.statusFilter === "pending" ? "active" : ""}" onclick="App.setStatusFilter('pending')">待配送</button>
    <button class="chip ${state.statusFilter === "delivering" ? "active" : ""}" onclick="App.setStatusFilter('delivering')">配送中</button>
    <button class="chip ${state.statusFilter === "done" ? "active" : ""}" onclick="App.setStatusFilter('done')">已完成</button>`;

  let subChips = "";
  let building = state.building;
  if (building) {
    const zones = BUILDINGS[building];
    subChips = `<div class="chips" style="margin-top:4px">
      <button class="chip all ${!state.sub ? "active" : ""}" onclick="App.setSub('')">本苑全部</button>
      ${zones.map((z) => `<button class="chip ${state.sub === z ? "active" : ""}" onclick="App.setSub('${z}')">${z}</button>`).join("")}
    </div>`;
  }
  $("#orderChips").innerHTML = chips + subChips;

  let orders = state.orders;
  if (building) orders = orders.filter((o) => o.delivery_building === building);
  if (state.sub) orders = orders.filter((o) => o.sub_zone === state.sub);
  if (state.statusFilter !== "all") orders = orders.filter((o) => o.status === state.statusFilter);

  // 排序：尽快优先 → 时间升序 → done 最末
  orders.sort((a, b) => {
    if (a.status === "done" && b.status !== "done") return 1;
    if (a.status !== "done" && b.status === "done") return -1;
    const ta = a.deliver_time || "0000", tb = b.deliver_time || "0000";
    if (!a.deliver_time && b.deliver_time) return -1;
    if (a.deliver_time && !b.deliver_time) return 1;
    return ta.localeCompare(tb);
  });

  $("#orderList").innerHTML = orders.length ? orders.map(orderCard).join("") : '<div class="empty">暂无订单</div>';
}

function orderCard(o) {
  const s = STATUS[o.status];
  const items = o.items.map((it) =>
    `<div class="row"><span>${esc(it.book_name)}</span><span class="qty">×${it.quantity}</span></div>`).join("");
  const time = `<span class="order-time"><i class="bi bi-clock"></i> ${fmtTime(o.deliver_time)}</span>`;

  const actions = `
    <div class="order-actions">
      ${o.status !== "pending" ? `<button class="btn ghost sm" onclick="App.setStatus(${o.id},'pending')">待配送</button>` : ""}
      ${o.status !== "delivering" ? `<button class="btn warn sm" onclick="App.setStatus(${o.id},'delivering')">配送中</button>` : ""}
      ${o.status !== "done" ? `<button class="btn primary sm" onclick="App.setStatus(${o.id},'done')">已完成</button>` : ""}
      <button class="btn ghost sm" onclick="App.editOrder(${o.id})"><i class="bi bi-pencil"></i> 编辑</button>
      <button class="btn ghost sm" onclick="App.delOrder(${o.id})"><i class="bi bi-trash3"></i> 删除</button>
    </div>`;

  return `<div class="card ${o.status === "done" ? "done" : ""}">
    <div class="order-head">
      <span class="zone">${esc(o.delivery_building)} ${esc(o.sub_zone)}</span>
      <span class="tag ${s.cls}">${s.name}</span>
    </div>
    <div class="order-meta">
      ${time}<br>
      <i class="bi bi-person"></i> ${esc(o.contact || "无联系方式")}
      ${o.remark ? `<br><i class="bi bi-chat-left"></i> ${esc(o.remark)}` : ""}
    </div>
    <div class="order-items">${items}</div>
    ${o.status === "done" ? "" : actions}
  </div>`;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 订单表单（新建/编辑） ---------- */
function itemRowHtml(book, qty) {
  return `<div class="item-row">
    <input class="input item-book" list="bookNamesList" placeholder="书名" value="${esc(book || "")}" />
    <input class="input item-qty" type="number" min="1" step="1" placeholder="数量" value="${qty || 1}" />
    <button type="button" class="trash" onclick="App.delItemRow(this)"><i class="bi bi-x-lg"></i></button>
  </div>`;
}

function renderForm(order) {
  const editing = !!order;
  $("#topSub").textContent = editing ? `编辑订单 #${order.id}` : "新建订单";

  const building = editing ? order.delivery_building : "";
  const subMap = building ? BUILDINGS[building] : [];
  const sub = editing ? order.sub_zone : "";

  let itemRows = "";
  if (editing && order.items.length) {
    for (const it of order.items) itemRows += itemRowHtml(it.book_name, it.quantity);
  } else {
    itemRows = itemRowHtml();
  }

  const datalist = `<datalist id="bookNamesList">
    ${state.bookNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}
  </datalist>`;

  const html = `
    <div class="card">
      ${datalist}
      <div class="field">
        <label>配送区域 <span class="req">*</span></label>
        <select class="input building" onchange="App.syncZone(this)">
          <option value="">选择大苑</option>
          ${Object.keys(BUILDINGS).map((b) => `<option value="${b}" ${b === building ? "selected" : ""}>${b}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>编号 <span class="req">*</span></label>
        <select class="input zone">
          <option value="">选择编号</option>
          ${subMap.map((z) => `<option value="${z}" ${z === sub ? "selected" : ""}>${z}</option>`).join("")}
        </select>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>预定配送时间</label>
          <input class="input time" type="datetime-local" value="${editing ? toLocalInput(order.deliver_time) : ""}" />
        </div>
        <div class="field">
          <label>联系方式 <span class="req">*</span></label>
          <input class="input contact" id="formContact" placeholder="手机号 / QQ / 微信" value="${esc(editing ? order.contact : "")}" />
        </div>
      </div>
      <div class="field">
        <label>备注</label>
        <input class="input remark" id="formRemark" placeholder="如：放门口、到了打电话" value="${esc(editing ? order.remark : "")}" />
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:16px;margin-bottom:10px">书单 <span class="req">*</span></h3>
      <div class="items-box" id="itemBox">${itemRows}</div>
      <button class="btn ghost sm row-add" onclick="App.addItemRow()"><i class="bi bi-plus-lg"></i> 添加书籍</button>
    </div>
    <button class="btn primary block" id="formSaveBtn">${editing ? "保存修改" : "提交订单"}</button>
  `;
  $("#formInner").innerHTML = html;
  window._editingId = editing ? order.id : null;
  $("#formSaveBtn").onclick = submitForm;
}

window.App = {
  syncZone(sel) {
    const zone = sel.closest(".card").querySelector(".zone");
    const zones = BUILDINGS[sel.value] || [];
    zone.innerHTML = '<option value="">选择编号</option>' +
      zones.map((z) => `<option value="${z}">${z}</option>`).join("");
  },
  addItemRow() {
    $("#itemBox").insertAdjacentHTML("beforeend", itemRowHtml());
  },
  delItemRow(btn) {
    const box = document.getElementById("itemBox");
    if (box.children.length <= 1) { toast("至少保留一行书"); return; }
    btn.closest(".item-row").remove();
  },
  editOrder(id) {
    state.currentTab = "edit";
    navigate("edit", { id });
  },
};

/* ---------- 提交表单 ---------- */
async function submitForm() {
  const root = $("#formInner");
  const building = root.querySelector(".building").value;
  const zone = root.querySelector(".zone").value;
  const time = fromLocalInput(root.querySelector(".time").value);
  const contact = root.querySelector(".contact").value.trim();
  const remark = root.querySelector(".remark").value.trim();

  const rows = root.querySelectorAll(".item-row");
  const items = [];
  rows.forEach((r) => {
    const name = r.querySelector(".item-book").value.trim();
    const qty = parseInt(r.querySelector(".item-qty").value, 10);
    if (name && qty >= 1) items.push({ book_name: name, quantity: qty });
  });

  if (!building || !zone) return toast("请选择配送区域和编号");
  if (!contact) return toast("请填写联系方式");
  if (!items.length) return toast("请至少填写一行有效书籍");

  const btn = $("#formSaveBtn");
  btn.disabled = true;
  try {
    if (window._editingId) {
      await api(`/api/orders/${window._editingId}`, "PUT", { delivery_building: building, sub_zone: zone, deliver_time: time, contact, remark, items });
      toast("已保存修改");
      navigate("orders");
    } else {
      await api("/api/orders", "POST", { delivery_building: building, sub_zone: zone, deliver_time: time, contact, remark, items });
      toast("下单成功");
      // 重置表单方便连续录入
      renderForm(null);
    }
    await loadOrders();
    await loadBookNames();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

/* ---------- 状态 / 删除 ---------- */
window.App.setStatus = async function (id, status) {
  try {
    await api(`/api/orders/${id}/status`, "PATCH", { status });
    await loadOrders();
    render();
  } catch (e) { toast(e.message); }
};
window.App.delOrder = function (id) {
  confirmModal("删除订单", "确定删除该订单吗？删除后不可恢复。", async () => {
    try {
      await api(`/api/orders/${id}`, "DELETE");
      await loadOrders();
      render();
      toast("已删除");
    } catch (e) { toast(e.message); }
  });
};
window.App.setStatusFilter = function (k) { state.statusFilter = k; render(); };
window.App.loadStats = loadStats;
window.App.setSub = function (s) {
  state.sub = s || null;
  navigate("orders", { building: state.building, sub: state.sub || undefined });
};
window.App.closeModal = window.closeModal;

/* ---------- 统计 ---------- */
window.App.renderStats = function () {
  const kw = ($("#statSearch").value || "").trim().toLowerCase();
  const list = state.stats.filter((s) => !kw || s.book_name.toLowerCase().includes(kw));
  $("#statsInner").innerHTML = list.length
    ? `<div class="stat-list">${list.map((s) => `
      <div class="stat-card">
        <div class="cnt">${s.total_quantity}</div>
        <div class="name">${esc(s.book_name)}</div>
        <div class="sub">${s.order_count} 个订单</div>
      </div>`).join("")}</div>`
    : '<div class="empty">暂无统计</div>';
};

/* ---------- 历史订单 ---------- */
function renderHistory() {
  $("#topSub").textContent = "历史订单（已完成）";
  const done = state.orders.filter((o) => o.status === "done");
  $("#historyInner").innerHTML = done.length
    ? done.map(orderCard).join("")
    : '<div class="empty">暂无已完成订单</div>';
}
window.App.clearDone = function () {
  confirmModal("清空已完成订单", "将删除所有已完成订单及其书单，不可恢复。确定继续？", async () => {
    try {
      const res = await api("/api/clear-done", "POST");
      await loadOrders();
      render();
      toast(`已清空 ${res.deleted} 条已完成订单`);
    } catch (e) { toast(e.message); }
  });
};

/* ---------- 分享下单链接 ---------- */
window.App.shareLink = async function () {
  const url = new URL("order-entry.html", location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    toast("下单链接已复制");
  } catch (e) {
    prompt("复制下单链接", url);
  }
};

/* ---------- 配送清单（打印 / 导出 CSV） ---------- */
window.App.exportManifest = function () {
  const active = state.orders.filter((o) => o.status !== "done");
  if (!active.length) { toast("当前没有待配送订单"); return; }
  const byB = {};
  active.forEach((o) => (byB[o.delivery_building] = byB[o.delivery_building] || []).push(o));

  let html = '<h2 style="text-align:center">配送清单</h2>' +
    `<p style="text-align:center;color:var(--muted)">${new Date().toLocaleString("zh-CN")} · 共 ${active.length} 单</p>`;
  for (const b of Object.keys(byB)) {
    html += `<div class="building-zone">${b}（${byB[b].length} 单）</div>`;
    for (const o of byB[b]) {
      const items = o.items.map((it) => `${it.book_name} ×${it.quantity}`).join("、");
      html += `<div class="card" style="box-shadow:none">
        <div><b>${esc(o.sub_zone)}</b> · ${fmtTime(o.deliver_time)} · ${esc(o.contact)}</div>
        <div class="order-meta">${esc(items)}</div>
        ${o.remark ? `<div class="order-meta">备注：${esc(o.remark)}</div>` : ""}
      </div>`;
    }
  }
  $("#printArea").innerHTML = html;
  const orig = document.title;
  document.title = "配送清单";
  window.print();
  document.title = orig;
};

/* ---------- 启动 ---------- */
async function init() {
  await Promise.all([loadOrders(), loadBookNames()]);
  render();
  // 每 4 秒静默轮询
  setInterval(async () => {
    await Promise.all([loadOrders(), loadBookNames()]);
    // 正在编辑表单时不打断重绘
    if (state.currentTab === "new" || state.currentTab === "edit") return;
    render();
  }, 4000);
}
init();
/* ===== 订单助手 后台逻辑 ===== */
/* API 地址：EdgeOne Pages 部署时前后端同域走相对路径；GitHub Pages 部署时走 Cloudflare Worker */
const WORKER_BASE = location.hostname.endsWith("edgeone.app") ? "" : "https://order-assistant-worker.loyce.workers.dev";

const BUILDINGS = {
  "大千苑18栋": ["18-1", "18-2", "18-3", "18-4"],
  "长江苑19栋": ["19-1", "19-2", "19-3", "19-4"],
  "大洲苑21栋": ["21-1", "21-2", "21-3", "21-4"],
  "培伦苑20栋": ["20-1", "20-2", "20-3", "20-4"],
};
const BUILD_ICONS = {
  "大千苑18栋": "bi-building",
  "长江苑19栋": "bi-water",
  "大洲苑21栋": "bi-houses",
  "培伦苑20栋": "bi-book",
};
/* 配送排序用：苑的固定顺序（与 BUILDINGS 键序一致） */
const BUILDING_ORDER = Object.keys(BUILDINGS);
const STATUS = {
  pending: { name: "待配送", cls: "pending" },
  delivering: { name: "配送中", cls: "delivering" },
  done: { name: "已完成", cls: "done" },
  cancelled: { name: "已取消", cls: "done" },
};

const state = {
  orders: [],
  bookNames: [],
  stats: [],
  statsBuilding: "", // 统计 Tab 按苑筛选（"" = 全部）
  wanted: [],        // 求书登记列表
  wantedFilter: "open", // open=待找到 / found=已找到 / all
  currentTab: "dashboard",
  building: null, // 区域配送进入时的苑过滤
  sub: null,      // 楼号过滤
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

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/* ---------- 后台密码 ---------- */
function getPwd() { return localStorage.getItem("adminPwd") || ""; }
let _pwdPromise = null; // 当前未完成的密码弹窗（防止轮询重复弹窗吞输入）
function askPwd(msg) {
  // 弹窗已打开：只更新提示文案，复用同一个 Promise，不清空用户输入
  if (_pwdPromise) {
    $("#pwdText").textContent = msg || "请输入团队共享密码，输入一次后本机记住。";
    return _pwdPromise;
  }
  _pwdPromise = new Promise((resolve) => {
    $("#pwdText").textContent = msg || "请输入团队共享密码，输入一次后本机记住。";
    $("#pwdInput").value = "";
    $("#pwdMask").classList.add("show");
    window._pwdResolve = (v) => { _pwdPromise = null; resolve(v); };
    setTimeout(() => { try { $("#pwdInput").focus(); } catch (e) {} }, 60);
  });
  return _pwdPromise;
}
function closePwd() {
  $("#pwdMask").classList.remove("show");
  const r = window._pwdResolve; window._pwdResolve = null;
  if (r) r(null);
}
function submitPwd() {
  const v = $("#pwdInput").value.trim();
  // 空密码不关闭弹窗，避免轮询反复重弹吞掉输入
  if (!v) { toast("请输入密码"); $("#pwdInput").focus(); return; }
  localStorage.setItem("adminPwd", v);
  $("#pwdMask").classList.remove("show");
  const r = window._pwdResolve; window._pwdResolve = null;
  if (r) r(v);
}
$("#pwdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitPwd(); });

/* ---------- API ---------- */
async function api(path, method = "GET", body, _retried) {
  const headers = { "Content-Type": "application/json" };
  const pwd = getPwd();
  if (pwd) headers["X-Admin-Key"] = pwd;
  const res = await fetch(WORKER_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !_retried) {
    const pwd2 = await askPwd("请输入正确密码进入后台");
    if (pwd2) return api(path, method, body, true);
  }
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data.data;
}

async function loadOrders() {
  try { state.orders = await api("/api/orders"); } catch (e) { toast(e.message); }
  updateNavDot(); // 订单变化后同步底部导航红点
}
async function loadBookNames() {
  try { state.bookNames = await api("/api/book-names"); } catch (e) {}
}
async function loadStats() {
  try {
    const q = state.statsBuilding ? `?building=${encodeURIComponent(state.statsBuilding)}` : "";
    state.stats = await api("/api/stats" + q);
    App.renderStats();
  } catch (e) { toast(e.message); }
}
async function loadWanted() {
  try { state.wanted = await api("/api/wanted"); } catch (e) {}
  updateWantedDot(); // 求书变化后同步底部导航红点
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
  else if (path.startsWith("/wanted")) tab = "wanted";
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
  const map = { dashboard: "dashboard", orders: "orders", new: "new", edit: "new", stats: "stats", wanted: "wanted", history: "history" };
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === map[r.tab]);
  });
  updateNavDot();
  updateWantedDot();
}

/* 底部导航「区域配送」红点：存在待配送订单时亮起 */
function updateNavDot() {
  const hasPending = state.orders.some((o) => o.status === "pending");
  const tab = document.querySelector('.nav a[data-tab="dashboard"]');
  if (tab) tab.classList.toggle("has-pending", hasPending);
}

/* 底部导航「求书」红点：存在待找到的求书时亮起 */
function updateWantedDot() {
  const hasOpen = state.wanted.some((w) => w.status === "open");
  const tab = document.querySelector('.nav a[data-tab="wanted"]');
  if (tab) tab.classList.toggle("has-open", hasOpen);
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
  if (r.tab === "wanted") { showPage("wanted"); renderWanted(); return; }
  if (r.tab === "history") { showPage("history"); renderHistory(); return; }
}
function showPage(id) { $("#page-" + id).classList.add("active"); }

/* ---------- 区域配送（首页） ---------- */
function renderDashboard() {
  // 只统计待配送/配送中（已取消的不算）
  const active = (o) => o.status === "pending" || o.status === "delivering";
  const pendingCount = (b) => state.orders.filter((o) => o.delivery_building === b && active(o)).length;
  const totalPending = state.orders.filter((o) => o.status === "pending").length;
  const validCount = state.orders.filter((o) => o.status !== "cancelled").length;
  $("#topSub").textContent = `共 ${validCount} 单 · ${totalPending} 单待配送`;

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

  // 状态 chips + 区域/楼号筛选 + 自提快捷筛（仅全部订单视图）
  let chips = `<button class="chip all ${state.statusFilter === "all" ? "active" : ""}" onclick="App.setStatusFilter('all')">全部</button>
    <button class="chip ${state.statusFilter === "pending" ? "active" : ""}" onclick="App.setStatusFilter('pending')">待配送</button>
    <button class="chip ${state.statusFilter === "delivering" ? "active" : ""}" onclick="App.setStatusFilter('delivering')">配送中</button>
    <button class="chip ${state.statusFilter === "done" ? "active" : ""}" onclick="App.setStatusFilter('done')">已完成</button>
    <button class="chip ${state.statusFilter === "cancelled" ? "active" : ""}" onclick="App.setStatusFilter('cancelled')">已取消</button>
    <button class="chip ${state.statusFilter === "pickup" ? "active" : ""}" onclick="App.setStatusFilter('pickup')"><i class="bi bi-shop"></i> 自提</button>`;

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
  if (state.statusFilter === "pickup") orders = orders.filter((o) => o.delivery_method === "self_pickup");
  else if (state.statusFilter !== "all") orders = orders.filter((o) => o.status === state.statusFilter);

  // 排序（配送路线友好）：
  // 1. 进行中的在前，已完成/已取消最末
  // 2. 待配送 > 配送中（先看到要送的）
  // 3. 同苑聚合 + 楼号自然序（18-1 < 18-2 …，不出现 19-1 夹在 18 栋中间）
  // 4. 尽快(无时间) > 指定时间早的在前
  // 5. 自提单按地点排最后（等顾客上门，不参与跑楼）
  orders.sort((a, b) => {
    const ended = (o) => o.status === "done" || o.status === "cancelled";
    if (ended(a) !== ended(b)) return ended(a) ? 1 : -1;

    const stRank = (o) => (o.status === "pending" ? 0 : o.status === "delivering" ? 1 : 2);
    if (stRank(a) !== stRank(b)) return stRank(a) - stRank(b);

    const pickRank = (o) => (o.delivery_method === "self_pickup" ? 1 : 0);
    if (pickRank(a) !== pickRank(b)) return pickRank(a) - pickRank(b);

    // 楼号自然序：18-2 → 苑名 "18"、号 2
    const subKey = (o) => {
      const m = String(o.sub_zone || "").match(/(\d+)-(\d+)/);
      if (!m) return [9999, 9999];
      return [Number(m[1]), Number(m[2])];
    };
    if (!building) {
      const bc = BUILDING_ORDER.indexOf(a.delivery_building) - BUILDING_ORDER.indexOf(b.delivery_building);
      if (bc !== 0) return bc;
    }
    const [ab, au] = subKey(a), [bb, bu] = subKey(b);
    if (ab !== bb) return ab - bb;
    if (au !== bu) return au - bu;

    if (!a.deliver_time && b.deliver_time) return -1;
    if (a.deliver_time && !b.deliver_time) return 1;
    return String(a.deliver_time).localeCompare(String(b.deliver_time));
  });

  $("#orderList").innerHTML = orders.length ? orders.map(orderCard).join("") : '<div class="empty">暂无订单</div>';
  bindSwipeButtons();
}

/* ===== 滑动确认交互（外卖式）===== */
function bindSwipeButtons() {
  document.querySelectorAll(".swipe-btn").forEach((btn) => {
    const knob = btn.querySelector(".swipe-knob");
    const card = btn.closest(".order-card");
    const maxLeft = () => btn.clientWidth - knob.offsetWidth - 8; // 4px 边距 x2
    let startX = 0, knobStart = 0, dragging = false;

    const setKnob = (x) => { knob.style.left = Math.max(4, Math.min(x, maxLeft())) + "px"; };
    const progress = () => Math.min(1, ((parseFloat(knob.style.left) || 4) - 4) / (maxLeft() - 4));
    const activate = (on) => {
      btn.classList.toggle("activated", on);
      const ratio = progress();
      btn.querySelector(".swipe-track").style.opacity = ratio > 0.05 ? ratio : 0;
      // 整卡随滑动进度向目标状态色渐变（opacity 遮罩）
      if (card) card.style.setProperty("--tint", String(ratio));
    };

    const onDown = (e) => {
      dragging = true;
      startX = e.clientX ?? (e.touches && e.touches[0].clientX) ?? 0;
      knobStart = parseFloat(knob.style.left) || 4;
      knob.style.transition = "none";
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const x = e.clientX ?? (e.touches && e.touches[0].clientX) ?? 0;
      setKnob(knobStart + (x - startX));
      activate(true);
    };
    const onUp = async () => {
      if (!dragging) return;
      dragging = false;
      const reached = (parseFloat(knob.style.left) || 4) >= maxLeft() - 6;
      knob.style.transition = "left .25s cubic-bezier(.2,.8,.3,1)";
      if (reached) {
        // 滑满：触发状态切换
        const id = Number(btn.dataset.orderId);
        const next = btn.dataset.nextStatus;
        setKnob(4);
        activate(false);
        if (card) card.style.removeProperty("--tint");
        await App.setStatus(id, next, true);
      } else {
        // 未滑满：回弹
        setKnob(4);
        activate(false);
        if (card) setTimeout(() => card.style.removeProperty("--tint"), 200);
      }
    };

    btn.addEventListener("mousedown", onDown);
    btn.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  });
}

/* 滑动确认按钮 HTML（外卖式） */
function swipeBtnHtml(o) {
  if (o.status === "pending") {
    return `<div class="swipe-btn" style="--swipe-color: var(--warn)" data-order-id="${o.id}" data-next-status="delivering">
      <div class="swipe-track"></div>
      <div class="swipe-label">滑动开始配送 →</div>
      <div class="swipe-knob"><i class="bi bi-truck"></i></div>
    </div>`;
  }
  if (o.status === "delivering") {
    return `<div class="swipe-btn" style="--swipe-color: var(--pri)" data-order-id="${o.id}" data-next-status="done">
      <div class="swipe-track"></div>
      <div class="swipe-label">滑动确认送达 →</div>
      <div class="swipe-knob"><i class="bi bi-check2"></i></div>
    </div>`;
  }
  return "";
}

function orderCard(o) {
  const s = STATUS[o.status];
  const items = o.items.map((it) =>
    `<div class="row"><span>${esc(it.book_name)}</span><span class="qty">×${it.quantity}</span></div>`).join("");
  const time = `<span class="order-time"><i class="bi bi-clock"></i> ${fmtTime(o.deliver_time)}</span>`;
  // 取书方式：自提显示地点，配送显示苑+楼号（旧数据无字段按配送处理）
  const isPickup = o.delivery_method === "self_pickup";
  const place = isPickup
    ? `<span class="zone"><i class="bi bi-shop"></i> 自提 · ${esc(o.pickup_location || "师生活动中心")}</span>`
    : `<span class="zone">${esc(o.delivery_building)} ${esc(o.sub_zone)}</span>`;

  // 已取消/已完成：置灰、无操作按钮（已取消可用「清空已完成」批量清理）
  const isEnded = o.status === "done" || o.status === "cancelled";

  const actions = `
    <div class="order-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${o.status !== "pending" ? `<button class="btn ghost sm" onclick="App.setStatus(${o.id},'pending')" title="退回待配送"><i class="bi bi-arrow-counterclockwise"></i> 退回</button>` : ""}
      <button class="btn ghost sm" onclick="App.editOrder(${o.id})"><i class="bi bi-pencil"></i> 编辑</button>
      <button class="btn ghost sm" onclick="App.delOrder(${o.id})"><i class="bi bi-trash3"></i> 删除</button>
    </div>
    ${swipeBtnHtml(o)}`;

  return `<div class="card order-card card-status-${o.status} ${isEnded ? "done" : ""}">
    <div class="order-head">
      ${place}
      <span class="tag ${s.cls}">${s.name}</span>
    </div>
    <div class="order-meta">
      ${time}<br>
      <i class="bi bi-person"></i> ${esc(o.contact || "无联系方式")}
      ${o.remark ? `<br><i class="bi bi-chat-left"></i> ${esc(o.remark)}` : ""}
    </div>
    <div class="order-items">${items}</div>
    ${isEnded ? "" : actions}
  </div>`;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 订单表单（新建/编辑） ---------- */
function itemRowHtml(book, qty) {
  return `<div class="item-row">
    <div class="book-suggest" style="position:relative;flex:1">
      <input class="input item-book" placeholder="书名（支持模糊搜索）" value="${esc(book || "")}" autocomplete="off"
        oninput="App.onBookInput(this)" onfocus="App.onBookInput(this)"
        onblur="App.hideBookSuggest(this)" />
      <div class="book-suggest-list"></div>
    </div>
    <input class="input item-qty" type="number" min="1" step="1" placeholder="数量" value="${qty || 1}" style="width:86px;flex:none" />
    <button type="button" class="trash" onclick="App.delItemRow(this)"><i class="bi bi-x-lg"></i></button>
  </div>`;
}

/* 书名模糊联想：输入时按 fuzzyMatchBook 过滤历史书名，点选填充 */
function onBookInput(input) {
  const box = input.parentElement.querySelector(".book-suggest-list");
  if (!box) return;
  const kw = input.value.trim();
  const list = kw
    ? state.bookNames.filter((n) => fuzzyMatchBook(n, kw)).slice(0, 12)
    : state.bookNames.slice(0, 8);
  if (!list.length) { box.innerHTML = ""; box.style.display = "none"; return; }
  box.innerHTML = list.map((n) =>
    `<div class="book-suggest-item" onmousedown="App.pickBook(this,'${esc(n).replace(/'/g, "\\'")}')">${esc(n)}</div>`
  ).join("");
  box.style.display = "block";
}
function hideBookSuggest(input) {
  const box = input.parentElement.querySelector(".book-suggest-list");
  if (box) setTimeout(() => { box.style.display = "none"; }, 150); // 延迟以让 mousedown 先触发
}
function pickBook(item, name) {
  const input = item.closest(".book-suggest").querySelector(".item-book");
  input.value = name;
  const box = item.parentElement;
  box.style.display = "none";
}

function renderForm(order) {
  const editing = !!order;
  $("#topSub").textContent = editing ? `编辑订单 #${order.id}` : "新建订单";

  const building = editing ? order.delivery_building : "";
  const subMap = building ? BUILDINGS[building] : [];
  const sub = editing ? order.sub_zone : "";
  const isPickup = editing ? order.delivery_method === "self_pickup" : false;
  const pickup = editing ? (order.pickup_location || "师生活动中心") : "师生活动中心";

  let itemRows = "";
  if (editing && order.items.length) {
    for (const it of order.items) itemRows += itemRowHtml(it.book_name, it.quantity);
  } else {
    itemRows = itemRowHtml();
  }

  const html = `
    <div class="card">
      <div class="field">
        <label>取书方式 <span class="req">*</span></label>
        <div class="method-toggle">
          <button type="button" class="mt-btn ${isPickup ? "" : "active"}" id="formMDelivery" onclick="App.setFormMethod('delivery')"><i class="bi bi-bicycle"></i> 配送到宿舍</button>
          <button type="button" class="mt-btn ${isPickup ? "active" : ""}" id="formMPickup" onclick="App.setFormMethod('self_pickup')"><i class="bi bi-shop"></i> 到点自提</button>
        </div>
      </div>
      <div id="formDeliveryFields" style="${isPickup ? "display:none" : ""}">
        <div class="field">
          <label>配送区域 <span class="req">*</span></label>
          <select class="input building" onchange="App.syncZone(this)">
            <option value="">选择大苑</option>
            ${Object.keys(BUILDINGS).map((b) => `<option value="${b}" ${b === building ? "selected" : ""}>${b}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>楼号 <span class="req">*</span></label>
          <select class="input zone">
            <option value="">选择楼号</option>
            ${subMap.map((z) => `<option value="${z}" ${z === sub ? "selected" : ""}>${z}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="formPickupFields" style="${isPickup ? "" : "display:none"}">
        <div class="field">
          <label>自提地点</label>
          <input class="input pickup" id="formPickup" value="${esc(pickup)}" placeholder="默认师生活动中心，可修改" />
        </div>
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
  window._formMethod = isPickup ? "self_pickup" : "delivery";
  $("#formSaveBtn").onclick = submitForm;
}

window.App = {
  syncZone(sel) {
    const zone = sel.closest(".card").querySelector(".zone");
    const zones = BUILDINGS[sel.value] || [];
    zone.innerHTML = '<option value="">选择楼号</option>' +
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
  // 表单取书方式切换：配送 ⇄ 自提
  setFormMethod(m) {
    window._formMethod = m;
    const d = document.getElementById("formMDelivery");
    const p = document.getElementById("formMPickup");
    if (d) d.classList.toggle("active", m === "delivery");
    if (p) p.classList.toggle("active", m === "self_pickup");
    const df = document.getElementById("formDeliveryFields");
    const pf = document.getElementById("formPickupFields");
    if (df) df.style.display = m === "delivery" ? "" : "none";
    if (pf) pf.style.display = m === "self_pickup" ? "" : "none";
  },
  closePwd,
  submitPwd,
  onBookInput,
  hideBookSuggest,
  pickBook,
  logout() {
    localStorage.removeItem("adminPwd");
    toast("已退出，正在刷新…");
    setTimeout(() => location.reload(), 800);
  },
};

/* ---------- 提交表单 ---------- */
async function submitForm() {
  const root = $("#formInner");
  const method = window._formMethod || "delivery";
  const building = root.querySelector(".building").value;
  const zone = root.querySelector(".zone").value;
  const pickup = ($("#formPickup").value.trim() || "师生活动中心");
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

  if (method === "delivery" && (!building || !zone)) return toast("请选择配送区域和楼号");
  if (!contact) return toast("请填写联系方式");
  if (!items.length) return toast("请至少填写一行有效书籍");

  const btn = $("#formSaveBtn");
  btn.disabled = true;
  try {
    const payload = { delivery_method: method, delivery_building: building, sub_zone: zone, pickup_location: pickup, deliver_time: time, contact, remark, items };
    if (window._editingId) {
      await api(`/api/orders/${window._editingId}`, "PUT", payload);
      toast("已保存修改");
      navigate("orders");
    } else {
      await api("/api/orders", "POST", payload);
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
window.App.setStatus = function (id, status, skipConfirm) {
  const doChange = async () => {
    try {
      await api(`/api/orders/${id}/status`, "PATCH", { status });
      await loadOrders();
      render();
      const toName = STATUS[status] ? STATUS[status].name : status;
      toast(`#${id} 已切换为「${toName}」`);
    } catch (e) { toast(e.message); }
  };
  // 滑动确认本身即确认动作，跳过弹窗
  if (skipConfirm) return doChange();
  const o = state.orders.find((x) => x.id === id);
  const fromName = o ? STATUS[o.status].name : "未知";
  const toName = STATUS[status] ? STATUS[status].name : status;
  const isPickupOrder = o && o.delivery_method === "self_pickup";
  const texts = {
    delivering: isPickupOrder ? `确定开始备货该自提订单吗？` : `确定开始配送该订单吗？`,
    done: isPickupOrder ? `确定顾客已取到书了吗？完成后订单将置灰并排到列表末尾。` : `确定该订单已完成配送吗？完成后订单将置灰并排到列表末尾。`,
    pending: `确定把该订单退回「待配送」状态吗？`,
  };
  confirmModal(
    `状态切换：${fromName} → ${toName}`,
    `订单 #${id}（${o ? (o.delivery_method === "self_pickup" ? "自提 · " + esc(o.pickup_location || "师生活动中心") : esc(o.delivery_building) + " " + esc(o.sub_zone)) : ""}）\n${texts[status] || ""}`,
    doChange
  );
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
function renderStatChips() {
  const cur = state.statsBuilding || "";
  $("#statBuildingChips").innerHTML =
    `<button class="chip all ${!cur ? "active" : ""}" onclick="App.setStatsBuilding('')">全部</button>` +
    Object.keys(BUILDINGS).map((b) =>
      `<button class="chip ${cur === b ? "active" : ""}" onclick="App.setStatsBuilding('${b}')">${b}</button>`
    ).join("");
}
window.App.setStatsBuilding = function (b) { state.statsBuilding = b || ""; loadStats(); };

/* 模糊匹配书名：支持空格分词（每词都需命中）+ 字符按顺序子序列匹配
   例：搜「高数 下」可命中「高等数学（下册）」，搜「gdsx」不可 */
function fuzzyMatchBook(name, kw) {
  if (!kw) return true;
  const n = name.toLowerCase();
  const terms = kw.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  // 每个词都需命中（子串，或按序字符子序列）
  return terms.every((t) =>
    n.includes(t) || isSubsequence(t, n)
  );
}
// 子序列：t 的每个字符按顺序出现在 n 中（允许跳过中间字符）
function isSubsequence(t, n) {
  let i = 0;
  for (const ch of n) {
    if (ch === t[i]) i++;
    if (i === t.length) return true;
  }
  return false;
}

window.App.renderStats = function () {
  renderStatChips();
  const kw = ($("#statSearch").value || "").trim();
  const list = state.stats.filter((s) => fuzzyMatchBook(s.book_name, kw));
  // 排序：超卖最前（缺得越多越靠前）→ 已用完 → 普通；同组按需求数降序
  const prio = (s) => (s.stock != null && s.remaining < 0) ? 0 : (s.stock != null && s.remaining === 0) ? 1 : 2;
  list.sort((a, b) => prio(a) - prio(b) || b.total_quantity - a.total_quantity);
  if (!list.length) { $("#statsInner").innerHTML = '<div class="empty">暂无统计</div>'; return; }
  $("#statsInner").innerHTML = `<div class="stat-list">${list.map((s) => {
    // 库存耗尽/超卖时卡片整体变色 + 角标，便于快速区分
    let cls = "", flag = "";
    if (s.stock != null && s.remaining < 0) { cls = "oversold"; flag = "超卖"; }
    else if (s.stock != null && s.remaining === 0) { cls = "stock-out"; flag = "已用完"; }
    let invHtml = "";
    if (s.stock != null) {
      const rem = s.remaining < 0
        ? `<span style="color:var(--danger);font-weight:700">${s.remaining}（超卖）</span>`
        : `<span style="color:${s.remaining === 0 ? "var(--warn)" : "var(--pri)"};font-weight:700">${s.remaining}</span>`;
      invHtml = `<div class="sub">库存 ${s.stock} · 剩余 ${rem}</div>`;
    }
    return `<div class="stat-card ${cls}">
      ${flag ? `<span class="stock-flag">${flag}</span>` : ""}
      <div class="cnt">${s.total_quantity}</div>
      <div class="name">${esc(s.book_name)}</div>
      <div class="sub">${s.order_count} 个订单</div>
      ${invHtml}
      <button class="btn ghost sm stock-edit-btn no-print" onclick="App.editStock('${esc(s.book_name).replace(/'/g, "\\'")}', ${s.stock == null ? "null" : s.stock})">
        <i class="bi bi-pencil-square"></i> ${s.stock == null ? "设库存" : "改库存"}
      </button>
    </div>`;
  }).join("")}</div>`;
};

/* ---------- 库存快捷编辑 ---------- */
window.App.editStock = function (bookName, currentStock) {
  const initVal = currentStock == null ? 0 : currentStock;
  $("#invEditBook").textContent = bookName;
  const input = $("#invEditInput");
  input.value = initVal;
  window._invEditName = bookName;
  $("#invEditMask").classList.add("show");
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 60);
};
window.App.invEditStep = function (d) {
  const input = $("#invEditInput");
  const v = parseInt(input.value, 10) || 0;
  input.value = Math.max(0, v + d);
};
window.App.closeInvEdit = function () {
  $("#invEditMask").classList.remove("show");
  window._invEditWantedId = null; // 取消时不同步求书状态
};
window.App.saveInvEdit = async function () {
  const name = window._invEditName;
  const v = parseInt($("#invEditInput").value, 10);
  if (!name) return;
  if (!Number.isFinite(v) || v < 0) { toast("库存需为≥0的整数"); return; }
  try {
    await api("/api/inventory", "POST", { items: [{ book_name: name, stock: v }] });
    $("#invEditMask").classList.remove("show");
    // 从求书页「找到了，入库」进入：保存库存后把该求书标记为已找到
    const wantedId = window._invEditWantedId;
    window._invEditWantedId = null;
    if (wantedId) {
      try { await api(`/api/wanted/${wantedId}/status`, "PATCH", { status: "found" }); } catch (e) {}
      await loadWanted();
      if (state.currentTab === "wanted") renderWanted();
      toast(`「${name}」已入库 ${v} 本并标记为已找到`);
    } else {
      toast(`「${name}」库存已设为 ${v}`);
    }
    loadStats();
  } catch (e) { toast(e.message); }
};
// 库存编辑弹窗：回车保存（脚本在 body 末尾加载，元素已就绪）
(() => {
  const inp = document.getElementById("invEditInput");
  if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") window.App.saveInvEdit(); });
})();

/* ---------- 统计导出 CSV ---------- */
window.App.exportStatsCsv = function () {
  if (!state.stats.length) { toast("暂无统计数据"); return; }
  const rows = [["书名", "需求数量", "订单数", "库存", "剩余"]];
  for (const s of state.stats) {
    rows.push([s.book_name, s.total_quantity, s.order_count, s.stock == null ? "" : s.stock, s.remaining == null ? "" : s.remaining]);
  }
  const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `库存统计_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ---------- Excel 库存导入 ---------- */
window.App.importInventory = async function (input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (typeof XLSX === "undefined") { toast("Excel 组件未加载，请刷新页面重试"); return; }
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    // 若首行含"书名/库存"表头字样则跳过
    let start = 0;
    if (rows.length) {
      const first = (rows[0] || []).map((c) => String(c).trim());
      if (first.some((c) => c.includes("书名")) || first.some((c) => c.includes("库存"))) start = 1;
    }
    const items = [];
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      const name = String(row[0] == null ? "" : row[0]).trim();
      if (!name) continue;
      const stock = Number(row[1]);
      if (!Number.isFinite(stock) || stock < 0) { toast(`第 ${i + 1} 行「${name}」库存无效（需为≥0的数字）`); return; }
      items.push({ book_name: name, stock: Math.round(stock) });
    }
    if (!items.length) { toast("未解析到有效数据（第1列书名、第2列库存）"); return; }
    confirmModal("导入库存", `共解析到 ${items.length} 条库存记录，同书名将覆盖现有库存。确定导入？`, async () => {
      try {
        const res = await api("/api/inventory", "POST", { items });
        toast(`已导入 ${res.imported} 条库存`);
        loadStats();
      } catch (e) { toast(e.message); }
    });
  } catch (e) {
    toast("解析 Excel 失败：" + e.message);
  }
};

/* 清空全部库存（重新导入前重置） */
window.App.clearInventory = function () {
  confirmModal("清空库存", "将删除全部库存记录（订单和统计不受影响），清空后需重新导入 Excel。确定清空？", async () => {
    try {
      const res = await api("/api/inventory", "DELETE");
      toast(`已清空 ${res.deleted} 条库存记录`);
      loadStats();
    } catch (e) { toast(e.message); }
  });
};

/* ---------- 求书登记（未找到但有人需要的书） ---------- */
window.App.loadWanted = async function () {
  await loadWanted();
  if (state.currentTab === "wanted") renderWanted();
};

function renderWanted() {
  $("#topSub").textContent = "求书登记（需要但未找到的书）";
  const openN = state.wanted.filter((w) => w.status === "open").length;
  const foundN = state.wanted.length - openN;
  $("#wantedChips").innerHTML = `
    <button class="chip ${state.wantedFilter === "open" ? "active" : ""}" onclick="App.setWantedFilter('open')">待找到${openN ? ` (${openN})` : ""}</button>
    <button class="chip ${state.wantedFilter === "found" ? "active" : ""}" onclick="App.setWantedFilter('found')">已找到${foundN ? ` (${foundN})` : ""}</button>
    <button class="chip all ${state.wantedFilter === "all" ? "active" : ""}" onclick="App.setWantedFilter('all')">全部</button>`;
  const kw = ($("#wantedSearch").value || "").trim();
  let list = state.wanted.filter((w) => state.wantedFilter === "all" || w.status === state.wantedFilter);
  if (kw) list = list.filter((w) => fuzzyMatchBook(w.book_name, kw));
  $("#wantedInner").innerHTML = list.length ? list.map(wantedCard).join("") : '<div class="empty">暂无求书登记</div>';
}
window.App.renderWanted = renderWanted;
window.App.setWantedFilter = function (f) { state.wantedFilter = f; renderWanted(); };

function wantedCard(w) {
  const isOpen = w.status === "open";
  return `<div class="card wanted-card ${isOpen ? "open" : "found"}">
    <div class="order-head">
      <span class="zone">${esc(w.book_name)}</span>
      <span class="tag ${isOpen ? "pending" : "done"}">${isOpen ? "待找到" : "已找到"}</span>
    </div>
    <div class="order-meta">
      需要 <b style="color:var(--pri)">${w.quantity}</b> 本
      ${w.remark ? ` · ${esc(w.remark)}` : ""}
      <br><i class="bi bi-person"></i> ${esc(w.contact || "未留联系方式")}
      <span style="margin-left:10px"><i class="bi bi-clock"></i> ${fmtDate(w.created_at)}</span>
    </div>
    <div class="order-actions">
      ${isOpen ? `
        <button class="btn primary sm" onclick="App.foundWanted(${w.id})"><i class="bi bi-book-half"></i> 找到了，入库</button>
        <button class="btn ghost sm" onclick="App.editWanted(${w.id})"><i class="bi bi-pencil"></i> 编辑</button>` : `
        <button class="btn ghost sm" onclick="App.reopenWanted(${w.id})"><i class="bi bi-arrow-counterclockwise"></i> 恢复待找</button>`}
      <button class="btn ghost sm" onclick="App.delWanted(${w.id})"><i class="bi bi-trash3"></i> 删除</button>
    </div>
  </div>`;
}

window.App.openWantedModal = function () {
  window._editingWantedId = null;
  $("#wantedModalTitle").textContent = "登记求书";
  $("#wantedName").value = "";
  $("#wantedQty").value = 1;
  $("#wantedContact").value = "";
  $("#wantedRemark").value = "";
  $("#wantedMask").classList.add("show");
  setTimeout(() => { try { $("#wantedName").focus(); } catch (e) {} }, 60);
};
window.App.closeWantedModal = function () {
  $("#wantedMask").classList.remove("show");
};
window.App.editWanted = function (id) {
  const w = state.wanted.find((x) => x.id === id);
  if (!w) return;
  window._editingWantedId = id;
  $("#wantedModalTitle").textContent = "编辑求书";
  $("#wantedName").value = w.book_name;
  $("#wantedQty").value = w.quantity;
  $("#wantedContact").value = w.contact || "";
  $("#wantedRemark").value = w.remark || "";
  $("#wantedMask").classList.add("show");
};
window.App.submitWanted = async function () {
  const name = $("#wantedName").value.trim();
  const qty = parseInt($("#wantedQty").value, 10);
  const contact = $("#wantedContact").value.trim();
  const remark = $("#wantedRemark").value.trim();
  if (!name) return toast("请填写书名");
  if (!Number.isInteger(qty) || qty < 1) return toast("数量需为≥1的整数");
  try {
    if (window._editingWantedId) {
      await api(`/api/wanted/${window._editingWantedId}`, "PUT", { book_name: name, quantity: qty, contact, remark });
      toast("已保存修改");
    } else {
      await api("/api/wanted", "POST", { book_name: name, quantity: qty, contact, remark });
      toast("已登记求书");
    }
    window.App.closeWantedModal();
    await loadWanted();
    if (state.currentTab === "wanted") renderWanted();
  } catch (e) { toast(e.message); }
};
window.App.delWanted = function (id) {
  confirmModal("删除求书", "确定删除该求书记录吗？删除后不可恢复。", async () => {
    try {
      await api(`/api/wanted/${id}`, "DELETE");
      await loadWanted();
      if (state.currentTab === "wanted") renderWanted();
      toast("已删除");
    } catch (e) { toast(e.message); }
  });
};
// 找到了：复用库存编辑弹窗，保存库存后自动标记为已找到
window.App.foundWanted = function (id) {
  const w = state.wanted.find((x) => x.id === id);
  if (!w) return;
  window._invEditWantedId = id;
  const cur = state.stats.find((s) => s.book_name === w.book_name);
  window.App.editStock(w.book_name, cur && cur.stock != null ? cur.stock : 0);
};
window.App.reopenWanted = function (id) {
  confirmModal("恢复待找", "确定把该书恢复为「待找到」吗？", async () => {
    try {
      await api(`/api/wanted/${id}/status`, "PATCH", { status: "open" });
      await loadWanted();
      if (state.currentTab === "wanted") renderWanted();
      toast("已恢复为待找到");
    } catch (e) { toast(e.message); }
  });
};
// 求书弹窗：回车保存
(() => {
  const ids = ["wantedName", "wantedQty", "wantedContact", "wantedRemark"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") window.App.submitWanted(); });
  }
})();

/* ---------- 历史订单 ---------- */
function renderHistory() {
  $("#topSub").textContent = "历史订单（已完成）";
  const done = state.orders.filter((o) => o.status === "done");
  $("#historyInner").innerHTML = done.length
    ? done.map(orderCard).join("")
    : '<div class="empty">暂无已完成订单</div>';
}
window.App.clearDone = function () {
  confirmModal("清空已完成订单", "将删除所有已完成和已取消的订单及其书单，不可恢复。确定继续？", async () => {
    try {
      const res = await api("/api/clear-done", "POST");
      await loadOrders();
      render();
      toast(`已清空 ${res.deleted} 条订单`);
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

/* ---------- 分享求书链接（顾客自助登记求书） ---------- */
window.App.shareWantedLink = async function () {
  const url = new URL("wanted-entry.html", location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    toast("求书链接已复制，发给顾客即可自助登记");
  } catch (e) {
    prompt("复制求书链接", url);
  }
};

/* ---------- 配送清单（打印 / 导出 CSV） ---------- */
window.App.exportManifest = function () {
  const active = state.orders.filter((o) => o.status !== "done" && o.status !== "cancelled"); // 已取消不进清单
  if (!active.length) { toast("当前没有待配送订单"); return; }
  // 自提单独立分组，配送单按大苑分组
  const pickups = active.filter((o) => o.delivery_method === "self_pickup");
  const deliveries = active.filter((o) => o.delivery_method !== "self_pickup");
  const byB = {};
  deliveries.forEach((o) => (byB[o.delivery_building] = byB[o.delivery_building] || []).push(o));

  let html = '<h2 style="text-align:center">配送清单</h2>' +
    `<p style="text-align:center;color:var(--muted)">${new Date().toLocaleString("zh-CN")} · 共 ${active.length} 单</p>`;
  if (pickups.length) {
    // 按自提地点分组
    const byP = {};
    pickups.forEach((o) => (byP[o.pickup_location || "师生活动中心"] = byP[o.pickup_location || "师生活动中心"] || []).push(o));
    for (const loc of Object.keys(byP)) {
      html += `<div class="building-zone">自提 · ${esc(loc)}（${byP[loc].length} 单）</div>`;
      for (const o of byP[loc]) {
        const items = o.items.map((it) => `${it.book_name} ×${it.quantity}`).join("、");
        html += `<div class="card" style="box-shadow:none">
          <div><b>#${o.id}</b> · ${fmtTime(o.deliver_time)} · ${esc(o.contact)}</div>
          <div class="order-meta">${esc(items)}</div>
          ${o.remark ? `<div class="order-meta">备注：${esc(o.remark)}</div>` : ""}
        </div>`;
      }
    }
  }
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
  await Promise.all([loadOrders(), loadBookNames(), loadWanted()]);
  render();
  // 每 4 秒静默轮询
  setInterval(async () => {
    await Promise.all([loadOrders(), loadBookNames(), loadWanted()]);
    // 正在编辑表单时不打断重绘
    if (state.currentTab === "new" || state.currentTab === "edit") return;
    render();
  }, 4000);
}
init();
// ============================================================================
// admin.js — Dashboard สำหรับ Admin/หน่วยกู้ภัย (ต้องล็อกอินด้วย Firebase Auth)
//
// สิทธิ์:
//   - rescue: เห็นแท็บ "ภาพรวมปัจจุบัน" อย่างเดียว (ข้อมูลกรองด้วย clearedAt)
//   - admin : เห็นทุกแท็บ รวม "ประวัติ/Log" (ไม่กรอง clearedAt) และ "จัดการผู้ใช้"
// ============================================================================

import { FALLBACK_LOCATION, showToast } from "./utils.js";
import {
  db, auth, firebaseConfig, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  onSnapshot, query, where, updateDoc, serverTimestamp, writeBatch,
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "./config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth as getSecondaryAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let map;
const sosMarkers = new Map();
const zoneMarkers = new Map();
const reportMarkers = new Map();
let watchersStarted = false;
let currentRole = null;
let currentUid = null;
let clearedAtMillis = 0;

// เก็บ snapshot ล่าสุดของแต่ละ collection ไว้ในตัวแปร เพื่อ re-render ใหม่ได้ทันที
// เมื่อ clearedAt เปลี่ยน (ไม่ต้องรอ Firestore ยิง event ใหม่)
let latestSOSDocs = [];
let latestReportDocs = [];
let latestSafeDocs = [];

// -------------------------------------------------------------- ล็อกอิน + บทบาท
function initAuthUI() {
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const loginScreen = document.getElementById("login-screen");
  const dashScreen = document.getElementById("dashboard-screen");
  const logoutBtn = document.getElementById("btn-logout");
  const whoami = document.getElementById("whoami");
  const roleBadge = document.getElementById("role-badge");

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.style.display = "none";
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const submitBtn = loginForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "กำลังเข้าสู่ระบบ...";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      loginError.textContent = translateAuthError(err.code);
      loginError.style.display = "block";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "เข้าสู่ระบบ";
    }
  });

  logoutBtn.addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      loginScreen.style.display = "flex";
      dashScreen.style.display = "none";
      currentRole = null;
      currentUid = null;
      return;
    }

    // เช็คบทบาทจากคอลเลกชัน roles/{uid} — ถ้าไม่มี แปลว่ายังไม่ได้รับสิทธิ์ใช้งาน
    const roleSnap = await getDoc(doc(db, "roles", user.uid));
    if (!roleSnap.exists() || !["admin", "rescue"].includes(roleSnap.data().role)) {
      loginError.textContent = "บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแลระบบ";
      loginError.style.display = "block";
      await signOut(auth);
      return;
    }

    currentRole = roleSnap.data().role;
    currentUid = user.uid;

    loginScreen.style.display = "none";
    dashScreen.style.display = "block";
    whoami.textContent = user.email;
    roleBadge.textContent = currentRole === "admin" ? "👑 Admin" : "🚑 หน่วยกู้ภัย";

    applyRoleVisibility();

    if (!watchersStarted) {
      watchersStarted = true;
      startDashboard();
    }
  });
}

function applyRoleVisibility() {
  const adminOnlyEls = document.querySelectorAll(".admin-only");
  adminOnlyEls.forEach((el) => {
    el.style.display = currentRole === "admin" ? "" : "none";
  });
}

function translateAuthError(code) {
  const map = {
    "auth/invalid-credential": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    "auth/wrong-password": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    "auth/user-not-found": "ไม่พบบัญชีผู้ใช้นี้",
    "auth/invalid-email": "รูปแบบอีเมลไม่ถูกต้อง",
    "auth/email-already-in-use": "อีเมลนี้มีผู้ใช้งานแล้ว",
    "auth/weak-password": "รหัสผ่านสั้นเกินไป (อย่างน้อย 6 ตัวอักษร)",
    "auth/too-many-requests": "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่"
  };
  return map[code] || "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
}

// -------------------------------------------------------------- แท็บ
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      ["current", "history", "users"].forEach((t) => {
        document.getElementById(`tab-${t}`).style.display = t === tab ? "block" : "none";
      });
      if (tab === "history") loadHistory();
      if (tab === "users") loadUserList();
    });
  });
}

// -------------------------------------------------------------- Dashboard หลัก
function startDashboard() {
  initTabs();
  initMap();
  watchClearedAt();
  watchSOS();
  watchZones();
  watchRequests();
  watchSafePeople();
  watchReports();
  wireClearDashboard();
  wireAddUserForm();
  setInterval(tickClock, 1000);
  tickClock();
}

function initMap() {
  map = L.map("map").setView([FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
}

function statusLabel(status) {
  const map = {
    trapped: "ติดอยู่ ออกไม่ได้",
    injured_severe: "บาดเจ็บ เดินไม่ได้",
    injured_minor: "บาดเจ็บเล็กน้อย",
    helping: "กำลังช่วยผู้อื่น",
    safe: "ปลอดภัยดี",
    unsafe: "ไม่ปลอดภัย ต้องการความช่วยเหลือ",
    unknown: "ไม่แน่ใจ/กำลังประเมินสถานการณ์"
  };
  return map[status] || status;
}

function badgeColor(status) {
  const map = {
    trapped: "#E5484D", injured_severe: "#F5A623", injured_minor: "#E5C85A", helping: "#3E7CB1",
    safe: "#2FB380", unsafe: "#E5484D", unknown: "#F5A623"
  };
  return map[status] || "#94A3B8";
}

function reportPinClass(status) {
  const map = { safe: "helping", unsafe: "trapped", unknown: "injured_minor" };
  return map[status] || "injured_minor";
}

function toMillis(ts) {
  return ts?.toMillis?.() ?? 0;
}

// -------------------------------------------------------------- clearedAt (สถานะเคลียร์ Dashboard)
function watchClearedAt() {
  onSnapshot(doc(db, "system", "dashboard_state"), (snap) => {
    clearedAtMillis = snap.exists() ? toMillis(snap.data().clearedAt) : 0;
    const info = document.getElementById("last-cleared-info");
    if (info) {
      info.textContent = clearedAtMillis
        ? `เคลียร์ล่าสุด: ${new Date(clearedAtMillis).toLocaleString("th-TH")}`
        : "ยังไม่เคยเคลียร์ข้อมูล";
    }
    renderSOSCurrent();
    renderReportsCurrent();
    renderSafeCurrent();
  });
}

function wireClearDashboard() {
  const btn = document.getElementById("btn-clear-dashboard");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (currentRole !== "admin") return;
    const ok = confirm(
      "ยืนยันเคลียร์ Dashboard?\n\n" +
      "จุดทั้งหมดบน Dashboard สาธารณะและมุมมอง 'ภาพรวมปัจจุบัน' จะถูกล้าง\n" +
      "ข้อมูลเต็มรูปแบบยังเก็บไว้ดูย้อนหลังได้ในแท็บ 'ประวัติ/Log'"
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = "กำลังเคลียร์...";
    try {
      await bulkDeleteCollection("public_pins");
      await bulkDeleteCollection("zone_state");
      await setDoc(doc(db, "system", "dashboard_state"), {
        clearedAt: serverTimestamp(),
        clearedBy: currentUid
      });
      showToast("🧹 เคลียร์ Dashboard สำเร็จ");
    } catch (err) {
      console.error(err);
      showToast("เคลียร์ไม่สำเร็จ: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "เคลียร์ข้อมูลตอนนี้";
    }
  });
}

async function bulkDeleteCollection(name) {
  const snap = await getDocs(collection(db, name));
  const docs = snap.docs;
  // Firestore batch เขียนได้สูงสุด 500 รายการต่อครั้ง เลยแบ่งเป็นชุดๆ
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// -------------------------------------------------------------- SOS (เต็มรูปแบบ)
function watchSOS() {
  const q = query(collection(db, "sos_alerts"), where("resolved", "==", false));
  onSnapshot(
    q,
    (snap) => {
      latestSOSDocs = snap.docs;
      renderSOSCurrent();
    },
    (err) => {
      console.error("watchSOS error:", err);
      document.getElementById("sos-list").innerHTML =
        `<div style="color:#E5484D;font-size:0.8rem">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
    }
  );

  document.getElementById("sos-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const ref = doc(db, "sos_alerts", id);
    if (btn.dataset.action === "resolve") {
      await updateDoc(ref, { resolved: true, resolvedAt: serverTimestamp() });
      await updateDoc(doc(db, "public_pins", id), { resolved: true, status: "resolved" }).catch(() => {});
    } else {
      await updateDoc(ref, { acknowledged: true });
      btn.textContent = "✓ รับเรื่องแล้ว";
      btn.disabled = true;
    }
  });
}

function renderSOSCurrent() {
  const list = document.getElementById("sos-list");
  if (!list) return;
  list.innerHTML = "";

  const docs = latestSOSDocs
    .filter((d) => toMillis(d.data().createdAt) > clearedAtMillis)
    .sort((a, b) => toMillis(b.data().createdAt) - toMillis(a.data().createdAt));

  const currentIds = new Set();
  docs.forEach((docSnap) => {
    const d = docSnap.data();
    const id = docSnap.id;
    currentIds.add(id);

    if (!sosMarkers.has(id)) {
      const marker = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: "", html: `<div class="sos-pin ${d.status}">🆘</div>`, iconSize: [28, 28] })
      }).addTo(map);
      sosMarkers.set(id, marker);
    }
    sosMarkers.get(id).bindPopup(
      `<b>${d.userName || "ไม่ระบุชื่อ"}</b><br>${statusLabel(d.status)}<br>แบต ${d.battery ?? "ไม่ทราบ"}%` +
      (d.userPhone ? `<br>โทร ${d.userPhone}` : "")
    );

    const item = document.createElement("div");
    item.className = "sos-list-item";
    item.innerHTML = `
      <div class="top-row">
        <b>${d.userName || "ไม่ระบุชื่อ"}</b>
        <span class="tag" style="background:${badgeColor(d.status)}">แบต ${d.battery ?? "N/A"}%</span>
      </div>
      <div style="font-size:0.8rem;color:#B8790A;margin-top:2px">${statusLabel(d.status)}</div>
      <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">
        ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)} ${d.userPhone ? " · โทร " + d.userPhone : ""}
      </div>
      <div class="actions">
        <button class="primary" data-action="ack" data-id="${id}">รับเรื่องแล้ว</button>
        <button data-action="resolve" data-id="${id}">✅ ปลอดภัยแล้ว</button>
      </div>
    `;
    list.appendChild(item);
  });

  sosMarkers.forEach((marker, id) => {
    if (!currentIds.has(id)) {
      map.removeLayer(marker);
      sosMarkers.delete(id);
    }
  });

  document.getElementById("stat-sos-pending").textContent = docs.length;
  if (docs.length === 0) {
    list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีคำขอ SOS ที่ค้างอยู่ในขณะนี้</div>';
  }
}

// -------------------------------------------------------------- ความจุจุดปลอดภัย
function watchZones() {
  onSnapshot(collection(db, "zone_state"), (snap) => {
    let totalPeople = 0;
    const currentIds = new Set();

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const id = docSnap.id;
      currentIds.add(id);
      totalPeople += d.currentCount || 0;

      const ratio = (d.currentCount || 0) / (d.capacity || 1);
      const cls = ratio > 0.85 ? "full" : ratio > 0.5 ? "mid" : "ok";

      if (zoneMarkers.has(id)) map.removeLayer(zoneMarkers.get(id));
      const marker = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: "", html: `<div class="zone-pin ${cls}"><span>🏕️</span></div>`, iconSize: [26, 26] })
      })
        .addTo(map)
        .bindPopup(`<b>${d.name}</b><br>${d.currentCount || 0}/${d.capacity} คน`);
      zoneMarkers.set(id, marker);
    });

    zoneMarkers.forEach((marker, id) => {
      if (!currentIds.has(id)) { map.removeLayer(marker); zoneMarkers.delete(id); }
    });

    document.getElementById("stat-total-people").textContent = totalPeople;
  });
}

// -------------------------------------------------------------- สถิติคำขอ/เช็คอิน
function watchRequests() {
  onSnapshot(collection(db, "safe_requests"), (snap) => {
    const docs = snap.docs.filter((d) => toMillis(d.data().createdAt) > clearedAtMillis);
    const totalRequests = docs.length;
    let totalCheckins = 0;
    docs.forEach((d) => { if (d.data().checkedIn) totalCheckins++; });

    document.getElementById("stat-requests").textContent = totalRequests;
    document.getElementById("stat-checkins").textContent = totalCheckins;
    document.getElementById("stat-not-arrived").textContent = Math.max(0, totalRequests - totalCheckins);
  });
}

// -------------------------------------------------------------- รายชื่อผู้ปลอดภัย
function watchSafePeople() {
  const q = query(collection(db, "safe_requests"), where("checkedIn", "==", true));
  onSnapshot(q, (snap) => {
    latestSafeDocs = snap.docs;
    renderSafeCurrent();
  }, (err) => console.error("watchSafePeople error:", err));
}

function renderSafeCurrent() {
  const list = document.getElementById("safe-list");
  if (!list) return;

  const docs = latestSafeDocs
    .filter((d) => toMillis(d.data().checkInTime) > clearedAtMillis)
    .sort((a, b) => toMillis(b.data().checkInTime) - toMillis(a.data().checkInTime));

  if (docs.length === 0) {
    list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ยังไม่มีใครเช็คอินปลอดภัย</div>';
    return;
  }

  list.innerHTML = "";
  docs.slice(0, 50).forEach((docSnap) => {
    const d = docSnap.data();
    const item = document.createElement("div");
    item.className = "sos-list-item";
    item.innerHTML = `
      <div class="top-row">
        <b>${d.userName || "ไม่ระบุชื่อ"}</b>
        <span class="tag" style="background:#2FB380">✅ ปลอดภัย</span>
      </div>
      <div style="font-size:0.8rem;color:#6B7A8F;margin-top:2px">📍 ${d.recommendedZoneName || "-"}</div>
      ${d.userPhone ? `<div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:2px">โทร ${d.userPhone}</div>` : ""}
    `;
    list.appendChild(item);
  });
}

// -------------------------------------------------------------- รายงานตนเอง
function watchReports() {
  onSnapshot(collection(db, "status_reports"), (snap) => {
    latestReportDocs = snap.docs;
    renderReportsCurrent();
  }, (err) => console.error("watchReports error:", err));
}

function renderReportsCurrent() {
  const list = document.getElementById("report-list");
  if (!list) return;

  const docs = latestReportDocs
    .filter((d) => toMillis(d.data().createdAt) > clearedAtMillis)
    .sort((a, b) => toMillis(b.data().createdAt) - toMillis(a.data().createdAt));

  reportMarkers.forEach((m) => map.removeLayer(m));
  reportMarkers.clear();

  if (docs.length === 0) {
    list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ยังไม่มีรายงานพิกัด/สถานะจากผู้ใช้</div>';
    return;
  }

  list.innerHTML = "";
  docs.slice(0, 50).forEach((docSnap) => {
    const d = docSnap.data();
    const id = docSnap.id;

    const marker = L.marker([d.lat, d.lng], {
      icon: L.divIcon({ className: "", html: `<div class="sos-pin ${reportPinClass(d.status)}">📍</div>`, iconSize: [26, 26] })
    }).addTo(map).bindPopup(`<b>${d.userName || "ไม่ระบุชื่อ"}</b><br>${statusLabel(d.status)}`);
    reportMarkers.set(id, marker);

    const item = document.createElement("div");
    item.className = "sos-list-item";
    item.innerHTML = `
      <div class="top-row">
        <b>${d.userName || "ไม่ระบุชื่อ"}</b>
        <span class="tag" style="background:${badgeColor(d.status)}">${statusLabel(d.status)}</span>
      </div>
      <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">
        ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)} ${d.userPhone ? " · โทร " + d.userPhone : ""}
      </div>
    `;
    list.appendChild(item);
  });
}

// ================================================================ แท็บ: ประวัติ/Log (Admin เท่านั้น)
function loadHistory() {
  const rangeSelect = document.getElementById("history-range");
  const render = () => renderHistory(parseInt(rangeSelect.value, 10));
  rangeSelect.onchange = render;
  render();
}

function withinRange(millis, days) {
  if (!days) return true; // 0 = ทั้งหมด
  return millis >= Date.now() - days * 24 * 60 * 60 * 1000;
}

async function renderHistory(days) {
  const sosList = document.getElementById("history-sos-list");
  const reportList = document.getElementById("history-report-list");
  const safeList = document.getElementById("history-safe-list");
  sosList.innerHTML = reportList.innerHTML = safeList.innerHTML = "กำลังโหลด...";

  try {
    const [sosSnap, reportSnap, safeSnap] = await Promise.all([
      getDocs(collection(db, "sos_alerts")),
      getDocs(collection(db, "status_reports")),
      getDocs(collection(db, "safe_requests"))
    ]);

    // --- SOS (รวมที่ resolve แล้ว) ---
    const sosDocs = sosSnap.docs
      .filter((d) => withinRange(toMillis(d.data().createdAt), days))
      .sort((a, b) => toMillis(b.data().createdAt) - toMillis(a.data().createdAt));
    sosList.innerHTML = sosDocs.length === 0
      ? '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีข้อมูลในช่วงเวลานี้</div>'
      : sosDocs.map((docSnap) => {
          const d = docSnap.data();
          const time = d.createdAt ? new Date(toMillis(d.createdAt)).toLocaleString("th-TH") : "-";
          return `<div class="sos-list-item">
            <div class="top-row">
              <b>${d.userName || "ไม่ระบุชื่อ"}</b>
              <span class="tag" style="background:${d.resolved ? "#2FB380" : badgeColor(d.status)}">${d.resolved ? "ปิดเคสแล้ว" : statusLabel(d.status)}</span>
            </div>
            <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">${time} ${d.userPhone ? " · โทร " + d.userPhone : ""}</div>
          </div>`;
        }).join("");

    // --- รายงานตนเอง ---
    const reportDocs = reportSnap.docs
      .filter((d) => withinRange(toMillis(d.data().createdAt), days))
      .sort((a, b) => toMillis(b.data().createdAt) - toMillis(a.data().createdAt));
    reportList.innerHTML = reportDocs.length === 0
      ? '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีข้อมูลในช่วงเวลานี้</div>'
      : reportDocs.map((docSnap) => {
          const d = docSnap.data();
          const time = d.createdAt ? new Date(toMillis(d.createdAt)).toLocaleString("th-TH") : "-";
          return `<div class="sos-list-item">
            <div class="top-row">
              <b>${d.userName || "ไม่ระบุชื่อ"}</b>
              <span class="tag" style="background:${badgeColor(d.status)}">${statusLabel(d.status)}</span>
            </div>
            <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">${time} ${d.userPhone ? " · โทร " + d.userPhone : ""}</div>
          </div>`;
        }).join("");

    // --- ผู้เช็คอินปลอดภัย ---
    const safeDocs = safeSnap.docs
      .filter((d) => d.data().checkedIn && withinRange(toMillis(d.data().checkInTime), days))
      .sort((a, b) => toMillis(b.data().checkInTime) - toMillis(a.data().checkInTime));
    safeList.innerHTML = safeDocs.length === 0
      ? '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีข้อมูลในช่วงเวลานี้</div>'
      : safeDocs.map((docSnap) => {
          const d = docSnap.data();
          const time = d.checkInTime ? new Date(toMillis(d.checkInTime)).toLocaleString("th-TH") : "-";
          return `<div class="sos-list-item">
            <div class="top-row">
              <b>${d.userName || "ไม่ระบุชื่อ"}</b>
              <span class="tag" style="background:#2FB380">✅ ${d.recommendedZoneName || "-"}</span>
            </div>
            <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">${time} ${d.userPhone ? " · โทร " + d.userPhone : ""}</div>
          </div>`;
        }).join("");
  } catch (err) {
    console.error(err);
    sosList.innerHTML = reportList.innerHTML = safeList.innerHTML =
      `<div style="color:#E5484D;font-size:0.85rem">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
  }
}

// ================================================================ แท็บ: จัดการผู้ใช้ (Admin เท่านั้น)
function wireAddUserForm() {
  const form = document.getElementById("add-user-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("add-user-error");
    const successEl = document.getElementById("add-user-success");
    errorEl.style.display = "none";
    successEl.style.display = "none";

    const email = document.getElementById("new-user-email").value.trim();
    const password = document.getElementById("new-user-password").value;
    const role = document.getElementById("new-user-role").value;
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "กำลังสร้าง...";

    // ใช้ Firebase App "instance ที่สอง" แยกต่างหาก เพื่อสร้างผู้ใช้ใหม่โดยไม่ทำให้
    // เซสชันล็อกอินของ Admin ที่กำลังใช้งานอยู่หลุด (ข้อจำกัดของ Firebase Client SDK)
    const secondaryApp = initializeApp(firebaseConfig, "SecondaryAdminApp-" + Date.now());
    const secondaryAuth = getSecondaryAuth(secondaryApp);

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const newUid = cred.user.uid;

      await setDoc(doc(db, "roles", newUid), {
        role,
        email,
        createdAt: serverTimestamp(),
        createdBy: currentUid
      });

      successEl.textContent = `สร้างบัญชี ${email} (${role === "admin" ? "Admin" : "หน่วยกู้ภัย"}) สำเร็จแล้ว`;
      successEl.style.display = "block";
      form.reset();
      loadUserList();
    } catch (err) {
      errorEl.textContent = translateAuthError(err.code);
      errorEl.style.display = "block";
    } finally {
      await signOut(secondaryAuth).catch(() => {});
      await deleteApp(secondaryApp).catch(() => {});
      submitBtn.disabled = false;
      submitBtn.textContent = "สร้างบัญชี";
    }
  });
}

async function loadUserList() {
  const list = document.getElementById("user-list");
  list.innerHTML = "กำลังโหลด...";
  try {
    const snap = await getDocs(collection(db, "roles"));
    if (snap.empty) {
      list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ยังไม่มีผู้ใช้ในระบบ</div>';
      return;
    }
    list.innerHTML = "";
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const uid = docSnap.id;
      const item = document.createElement("div");
      item.className = "sos-list-item";
      item.innerHTML = `
        <div class="top-row">
          <b>${d.email || "-"}</b>
          <span class="tag" style="background:${d.role === "admin" ? "#1B2534" : "#3E7CB1"}">${d.role === "admin" ? "Admin" : "หน่วยกู้ภัย"}</span>
        </div>
        <div class="actions">
          <button data-action="revoke" data-uid="${uid}" ${uid === currentUid ? "disabled title='ไม่สามารถเพิกถอนสิทธิ์ตัวเองได้'" : ""}>เพิกถอนสิทธิ์</button>
        </div>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll("button[data-action=revoke]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.dataset.uid;
        const ok = confirm(
          "เพิกถอนสิทธิ์ผู้ใช้นี้?\n\n" +
          "บัญชีจะเข้าสู่ระบบไม่ได้อีก (แต่บัญชี Firebase ยังอยู่ — ถ้าต้องการลบถาวร " +
          "ต้องลบผ่าน Firebase Console > Authentication > Users ด้วย)"
        );
        if (!ok) return;
        await deleteDoc(doc(db, "roles", uid));
        showToast("เพิกถอนสิทธิ์แล้ว");
        loadUserList();
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="color:#E5484D;font-size:0.85rem">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
  }
}

function tickClock() {
  document.getElementById("clock-pill").textContent = new Date().toLocaleTimeString("th-TH");
}

initAuthUI();

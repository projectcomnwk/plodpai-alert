// ============================================================================
// admin.js — Dashboard สำหรับ Admin/หน่วยกู้ภัย (ต้องล็อกอินด้วย Firebase Auth)
// เห็นข้อมูลครบทุกอย่างรวมชื่อ-เบอร์โทร-พิกัดละเอียดของทุกคน
// ============================================================================

import { FALLBACK_LOCATION } from "./utils.js";
import {
  db, auth, collection, onSnapshot, query, where, doc, updateDoc, serverTimestamp,
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "./config.js";

let map;
const sosMarkers = new Map();
const zoneMarkers = new Map();
const reportMarkers = new Map();
let watchersStarted = false;

// -------------------------------------------------------------- ล็อกอิน
function initAuthUI() {
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const loginScreen = document.getElementById("login-screen");
  const dashScreen = document.getElementById("dashboard-screen");
  const logoutBtn = document.getElementById("btn-logout");
  const whoami = document.getElementById("whoami");

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

  onAuthStateChanged(auth, (user) => {
    if (user) {
      loginScreen.style.display = "none";
      dashScreen.style.display = "block";
      whoami.textContent = user.email;
      if (!watchersStarted) {
        watchersStarted = true;
        startDashboard();
      }
    } else {
      loginScreen.style.display = "flex";
      dashScreen.style.display = "none";
    }
  });
}

function translateAuthError(code) {
  const map = {
    "auth/invalid-credential": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    "auth/wrong-password": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    "auth/user-not-found": "ไม่พบบัญชีผู้ใช้นี้",
    "auth/invalid-email": "รูปแบบอีเมลไม่ถูกต้อง",
    "auth/too-many-requests": "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่"
  };
  return map[code] || "เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง";
}

// -------------------------------------------------------------- Dashboard หลัก
function startDashboard() {
  initMap();
  watchSOS();
  watchZones();
  watchRequests();
  watchSafePeople();
  watchReports();
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
    trapped: "#E5484D",
    injured_severe: "#F5A623",
    injured_minor: "#E5C85A",
    helping: "#3E7CB1",
    safe: "#2FB380",
    unsafe: "#E5484D",
    unknown: "#F5A623"
  };
  return map[status] || "#94A3B8";
}

// แปลงสถานะของ "รายงานตนเอง" ให้ใช้ class สีเดียวกับที่มีอยู่แล้วใน CSS (.sos-pin.xxx)
function reportPinClass(status) {
  const map = { safe: "helping", unsafe: "trapped", unknown: "injured_minor" };
  return map[status] || "injured_minor";
}

// -------------------------------------------------------------- SOS (เต็มรูปแบบ)
function watchSOS() {
  const q = query(collection(db, "sos_alerts"), where("resolved", "==", false));
  onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("sos-list");
      list.innerHTML = "";
      let count = 0;
      const currentIds = new Set();

      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt?.toMillis?.() ?? 0;
        const tb = b.data().createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });

      docs.forEach((docSnap) => {
        const d = docSnap.data();
        const id = docSnap.id;
        currentIds.add(id);
        count++;

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

      document.getElementById("stat-sos-pending").textContent = count;
      if (count === 0) {
        list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีคำขอ SOS ที่ค้างอยู่ในขณะนี้</div>';
      }
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

// -------------------------------------------------------------- ความจุจุดปลอดภัย
function watchZones() {
  onSnapshot(collection(db, "zone_state"), (snap) => {
    let totalPeople = 0;

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const id = docSnap.id;
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

    document.getElementById("stat-total-people").textContent = totalPeople;
  });
}

// -------------------------------------------------------------- สถิติคำขอ/เช็คอิน
function watchRequests() {
  onSnapshot(collection(db, "safe_requests"), (snap) => {
    const totalRequests = snap.size;
    let totalCheckins = 0;
    snap.forEach((d) => { if (d.data().checkedIn) totalCheckins++; });

    document.getElementById("stat-requests").textContent = totalRequests;
    document.getElementById("stat-checkins").textContent = totalCheckins;
    document.getElementById("stat-not-arrived").textContent = Math.max(0, totalRequests - totalCheckins);
  });
}

// -------------------------------------------------------------- รายชื่อผู้ปลอดภัย (เต็มรูปแบบ)
function watchSafePeople() {
  const q = query(collection(db, "safe_requests"), where("checkedIn", "==", true));
  onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("safe-list");
      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().checkInTime?.toMillis?.() ?? 0;
        const tb = b.data().checkInTime?.toMillis?.() ?? 0;
        return tb - ta;
      });

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
    },
    (err) => console.error("watchSafePeople error:", err)
  );
}

// -------------------------------------------------------------- รายงานตนเอง (คนที่ไม่ได้ไปจุดที่แนะนำ)
function watchReports() {
  onSnapshot(
    collection(db, "status_reports"),
    (snap) => {
      const list = document.getElementById("report-list");
      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt?.toMillis?.() ?? 0;
        const tb = b.data().createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });

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
    },
    (err) => console.error("watchReports error:", err)
  );
}

function tickClock() {
  document.getElementById("clock-pill").textContent = new Date().toLocaleTimeString("th-TH");
}

initAuthUI();

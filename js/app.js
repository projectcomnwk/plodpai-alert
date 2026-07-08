// ============================================================================
// app.js — ไฟล์หลักของหน้า index.html
// เชื่อมแผนที่ (Leaflet + OpenStreetMap) + quake.js + safezone.js + sos.js เข้าด้วยกัน
// ============================================================================

import { getUserLocation, showToast, FALLBACK_LOCATION, haversineKm } from "./utils.js";
import { initQuakeWatcher, setWideMode, simulateQuake } from "./quake.js";
import { fetchNearbySafeZones, scoreZones, fetchWalkingRoute, checkInToZone } from "./safezone.js";
import { initSOS, getStatusOptions, submitSOS, closeStatusSheet } from "./sos.js";
import { initReport, getReportStatusOptions, submitReport, openReportSheet, closeReportSheet } from "./report.js";
import { db, collection, doc, setDoc, updateDoc, serverTimestamp } from "./config.js";
import { playSiren, vibrateAlert } from "./sound.js";
import { ensureProfile, openProfileModal, getProfile } from "./profile.js";

let map, userMarker, epicenterCircle, epicenterMarker, routeLine, waveTimer;
const zoneMarkers = new Map();

let userLocation = null;
let userProfile = null; // { userId, name, phone } — กรอกครั้งแรกแล้วเก็บไว้ในเครื่อง
let currentRecommendation = null; // จุดที่ระบบแนะนำล่าสุด (ไว้ใช้ตอนกดเช็คอิน)
let currentRequestId = null; // id ของเอกสาร safe_requests ล่าสุด (ไว้ผูกกับการเช็คอิน)
let quakeCountdownTimer = null;

let liveWatchId = null; // watchPosition id — ทำงานตลอดตั้งแต่เปิดแอป ไม่ใช่แค่ตอนนำทาง
let navigating = false;
let navigationTargetZone = null;
const ARRIVAL_THRESHOLD_M = 40; // ถือว่า "ถึงแล้ว" เมื่อห่างจุดหมายไม่เกินนี้ (เมตร)

async function main() {
  userProfile = await ensureProfile(); // ต้องกรอกชื่อก่อนถึงจะใช้งานต่อได้

  userLocation = await getUserLocation();
  if (userLocation.isFallback) {
    showToast("ไม่พบสัญญาณ GPS — ใช้ตำแหน่งสำรอง (โรงเรียนหนองหินวิทยาคม)");
  }

  initMap();
  startLiveTracking(); // เริ่มติดตามตำแหน่งเป็นจุดแดงแบบเรียลไทม์ทันที (ไม่ต้องรอกดนำทาง)
  initQuakeWatcher(userLocation, onQuakeDetected);
  initReport(() => userLocation);
  wireButtons();
}

// ---------------------------------------------------------------- แผนที่ (Leaflet + OpenStreetMap)
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([userLocation.lat, userLocation.lng], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  // จุดแดง = ตำแหน่งของผู้ใช้ อัปเดตแบบเรียลไทม์ผ่าน startLiveTracking()
  userMarker = L.marker([userLocation.lat, userLocation.lng], {
    icon: L.divIcon({ className: "", html: '<div class="live-dot"></div>', iconSize: [18, 18] }),
    zIndexOffset: 1000
  }).addTo(map).bindPopup("ตำแหน่งของคุณ (อัปเดตสด)");
}

// ---------------------------------------------------------------- ติดตามตำแหน่งจริงตลอดเวลา
function startLiveTracking() {
  if (!navigator.geolocation) {
    showToast("อุปกรณ์นี้ไม่รองรับ GPS แบบติดตามตำแหน่ง");
    return;
  }
  if (liveWatchId !== null) navigator.geolocation.clearWatch(liveWatchId);

  liveWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userLocation.lat = pos.coords.latitude;
      userLocation.lng = pos.coords.longitude;
      userLocation.isFallback = false;

      if (userMarker) userMarker.setLatLng([userLocation.lat, userLocation.lng]);

      // ถ้ากำลังนำทางอยู่ ให้อัปเดตระยะทาง + เช็คว่าถึงจุดหมายหรือยังไปด้วยในตัว
      if (navigating && navigationTargetZone) {
        updateNavDistance(navigationTargetZone);
        const distM = haversineKm(userLocation.lat, userLocation.lng, navigationTargetZone.lat, navigationTargetZone.lng) * 1000;
        if (distM <= ARRIVAL_THRESHOLD_M) {
          triggerArrival(navigationTargetZone);
        }
      }
    },
    (err) => console.warn("watchPosition error:", err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

// ------------------------------------------------------------------ ปุ่มต่างๆ
function wireButtons() {
  document.getElementById("btn-request-zone").addEventListener("click", handleRequestZone);
  document.getElementById("btn-checkin").addEventListener("click", handleCheckIn);
  document.getElementById("btn-demo").addEventListener("click", openDemoPanel);
  document.getElementById("btn-wide-mode").addEventListener("click", toggleWideMode);
  document.getElementById("btn-navigate").addEventListener("click", () => {
    if (currentRecommendation) startNavigation(currentRecommendation);
  });
  document.getElementById("btn-cancel-nav").addEventListener("click", stopNavigation);
  document.getElementById("arrival-cancel").addEventListener("click", () => {
    document.getElementById("arrival-sheet").classList.remove("show");
  });
  document.getElementById("btn-confirm-checkin").addEventListener("click", async () => {
    document.getElementById("arrival-sheet").classList.remove("show");
    await handleCheckIn();
  });
  document.getElementById("btn-profile").addEventListener("click", () => {
    openProfileModal((profile) => {
      userProfile = profile;
      showToast("บันทึกข้อมูลของคุณแล้ว");
    }, getProfile());
  });
  document.getElementById("btn-report").addEventListener("click", openReportSheet);
  getReportStatusOptions().forEach((opt) => {
    const btn = document.querySelector(`.report-option[data-key="${opt.key}"]`);
    if (btn) btn.addEventListener("click", () => submitReport(opt.key));
  });
  document.getElementById("report-cancel").addEventListener("click", closeReportSheet);

  initSOS(document.getElementById("btn-sos"), () => userLocation);

  getStatusOptions().forEach((opt) => {
    const btn = document.querySelector(`.status-option[data-key="${opt.key}"]`);
    if (btn) btn.addEventListener("click", () => submitSOS(opt.key));
  });
  document.getElementById("sos-cancel").addEventListener("click", closeStatusSheet);

  // แผงจำลองแผ่นดินไหว
  document.getElementById("demo-run").addEventListener("click", () => {
    const mag = parseFloat(document.getElementById("demo-magnitude").value);
    simulateQuake(mag, userLocation.lat, userLocation.lng);
    document.getElementById("demo-panel").classList.remove("show");
  });
  document.getElementById("demo-cancel").addEventListener("click", () => {
    document.getElementById("demo-panel").classList.remove("show");
  });
}

function openDemoPanel() {
  document.getElementById("demo-panel").classList.add("show");
}

let wideModeOn = false;
function toggleWideMode() {
  wideModeOn = !wideModeOn;
  setWideMode(wideModeOn);
  const btn = document.getElementById("btn-wide-mode");
  btn.textContent = wideModeOn
    ? "🌏 โหมดขยายพื้นที่: เปิดอยู่ (ตรวจข้อมูลจริงทั่วโลก)"
    : "🌏 เปิดโหมดขยายพื้นที่ (พิสูจน์ข้อมูลจริงจาก USGS)";
}

// ------------------------------------------------------------ แจ้งเตือนแผ่นดินไหว
function onQuakeDetected(quake, etaSeconds) {
  const banner = document.getElementById("quake-banner");
  banner.classList.add("show");
  document.getElementById("qb-place").textContent = quake.place;
  document.getElementById("qb-mag").textContent = quake.magnitude.toFixed(1);
  document.getElementById("qb-distance").textContent = Math.round(quake.distanceKm);
  document.getElementById("qb-source").textContent = quake.source === "DEMO" ? "DEMO MODE" : "USGS (ข้อมูลจริง)";

  showQuakeModal(quake, etaSeconds);
  playSiren(4000);
  vibrateAlert();

  drawEpicenter(quake);
  startCountdown(etaSeconds);
}

function showQuakeModal(quake, etaSeconds) {
  const modal = document.getElementById("quake-modal");
  document.getElementById("qm-source").textContent =
    quake.source === "DEMO" ? "🧪 โหมดจำลอง (DEMO)" : "🔔 ข้อมูลจริงจาก USGS";
  document.getElementById("qm-place").textContent = quake.place;
  document.getElementById("qm-mag").textContent = quake.magnitude.toFixed(1);
  document.getElementById("qm-distance").textContent = Math.round(quake.distanceKm);
  document.getElementById("qm-eta").textContent =
    etaSeconds > 0 ? `แรงสั่นอาจถึงในอีก ${etaSeconds} วินาที` : "แรงสั่นอาจถึงแล้ว";
  modal.classList.add("show");

  clearTimeout(modal._autoClose);
  modal._autoClose = setTimeout(() => modal.classList.remove("show"), 15000);
}

document.getElementById("qm-ack").addEventListener("click", () => {
  document.getElementById("quake-modal").classList.remove("show");
});

function drawEpicenter(quake) {
  if (epicenterMarker) map.removeLayer(epicenterMarker);
  if (epicenterCircle) map.removeLayer(epicenterCircle);

  epicenterMarker = L.marker([quake.lat, quake.lng], {
    icon: L.divIcon({ className: "", html: '<div class="pulse-marker"></div>', iconSize: [16, 16] })
  }).addTo(map).bindPopup(`ศูนย์กลาง: ${quake.place}<br>ขนาด ${quake.magnitude}`);

  epicenterCircle = L.circle([quake.lat, quake.lng], {
    radius: 1000,
    color: "#E5484D",
    weight: 1,
    fillOpacity: 0.05
  }).addTo(map);

  // แสดงคลื่นสั่นสะเทือนที่ขยายตัวไปตามเวลาจริง (สื่อฟิสิกส์ของคลื่น S)
  const startTime = Date.now();
  const speedMs = 3500; // ม./วินาที
  clearInterval(waveTimer);
  waveTimer = setInterval(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    epicenterCircle.setRadius(Math.min(elapsedSec * speedMs, 3000000));
  }, 200);
}

function startCountdown(etaSeconds) {
  clearInterval(quakeCountdownTimer);
  let remaining = etaSeconds;
  const etaEl = document.getElementById("qb-eta");

  function tick() {
    if (remaining <= 0) {
      etaEl.textContent = "คลื่นสั่นสะเทือนอาจถึงแล้ว — หมอบ-กำบัง-ยึด";
      clearInterval(quakeCountdownTimer);
      return;
    }
    etaEl.textContent = `แรงสั่นอาจถึงในอีก ${remaining} วินาที`;
    remaining -= 1;
  }
  tick();
  quakeCountdownTimer = setInterval(tick, 1000);
}

// -------------------------------------------------------------- จุดปลอดภัย
async function handleRequestZone() {
  const btn = document.getElementById("btn-request-zone");
  const label = btn.querySelector(".btn-label");
  const originalLabel = label.textContent;
  btn.disabled = true;
  label.textContent = "กำลังค้นหา...";
  showToast("🔎 กำลังค้นหาจุดปลอดภัยใกล้คุณ...");

  try {
    const zones = await fetchNearbySafeZones(userLocation.lat, userLocation.lng);
    const ranked = scoreZones(zones);

    if (ranked.length === 0) {
      showToast("ไม่พบจุดปลอดภัยในรัศมี 5 กม. ลองขยับตำแหน่งหรือเพิ่มรัศมีในโค้ด");
      btn.disabled = false;
      label.textContent = originalLabel;
      return;
    }

    currentRecommendation = ranked[0];
    renderZonesOnMap(ranked);
    renderRecommendation(currentRecommendation);
    drawRouteTo(currentRecommendation);

    // บันทึกคำขอนี้ไว้วิเคราะห์ (กี่คนขอ, ขอจุดไหน, เช็คอินสำเร็จกี่คน, เป็นใคร)
    const reqRef = doc(collection(db, "safe_requests"));
    await setDoc(reqRef, {
      userId: userProfile?.userId || null,
      userName: userProfile?.name || "ไม่ระบุชื่อ",
      userPhone: userProfile?.phone || null,
      lat: userLocation.lat,
      lng: userLocation.lng,
      recommendedZoneId: currentRecommendation.id,
      recommendedZoneName: currentRecommendation.name,
      checkedIn: false,
      createdAt: serverTimestamp()
    });
    currentRequestId = reqRef.id;

    document.getElementById("btn-checkin").disabled = false;
  } catch (err) {
    console.error(err);
    showToast("ดึงข้อมูลจุดปลอดภัยไม่สำเร็จ ลองใหม่อีกครั้ง");
  } finally {
    btn.disabled = false;
    label.textContent = originalLabel;
  }
}

function renderZonesOnMap(zones) {
  zoneMarkers.forEach((m) => map.removeLayer(m));
  zoneMarkers.clear();

  zones.forEach((z, idx) => {
    const ratio = z.occupancyRatio;
    const cls = ratio > 0.85 ? "full" : ratio > 0.5 ? "mid" : z.category === "help" ? "help" : "ok";
    const marker = L.marker([z.lat, z.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="zone-pin ${cls}"><span>${z.emoji}</span></div>`,
        iconSize: [26, 26]
      })
    })
      .addTo(map)
      .bindPopup(
        `<b>${idx === 0 ? "⭐ แนะนำ: " : ""}${z.name}</b><br>` +
        `ระยะทาง ${z.distanceKm.toFixed(1)} กม.<br>` +
        `ความจุ ${z.currentCount}/${z.capacity} คน<br>` +
        `🛡️ ความปลอดภัย ${z.safetyPercent}%`
      );
    zoneMarkers.set(z.id, marker);
  });
}

function renderRecommendation(zone) {
  const card = document.getElementById("recommend-card");
  card.classList.add("show");
  document.getElementById("rec-name").textContent = `${zone.emoji} ${zone.name}`;
  document.getElementById("rec-distance").textContent = zone.distanceKm.toFixed(2) + " กม.";
  document.getElementById("rec-capacity").textContent = `${zone.currentCount}/${zone.capacity} คน`;
  document.getElementById("rec-safety").textContent = `🛡️ ความปลอดภัย ${zone.safetyPercent}% · รองรับได้อีก ${zone.capacityRemaining} คน`;
  const pct = Math.min(100, Math.round((zone.currentCount / zone.capacity) * 100));
  document.getElementById("rec-bar").style.width = pct + "%";
  document.getElementById("rec-bar").style.background =
    pct > 85 ? "var(--alert-red)" : pct > 50 ? "var(--warn-amber)" : "var(--safe-green)";
}

async function drawRouteTo(zone) {
  if (routeLine) map.removeLayer(routeLine);
  try {
    const coords = await fetchWalkingRoute(userLocation.lat, userLocation.lng, zone.lat, zone.lng);
    routeLine = L.polyline(coords, { color: "#3E7CB1", weight: 4, opacity: 0.85 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  } catch (e) {
    // fallback: เส้นตรง ถ้า OSRM เรียกไม่สำเร็จ (เช่น ไม่มีเน็ตหรือ rate limit)
    routeLine = L.polyline(
      [[userLocation.lat, userLocation.lng], [zone.lat, zone.lng]],
      { color: "#3E7CB1", weight: 3, dashArray: "6 6" }
    ).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
}

// -------------------------------------------------------------- นำทางเรียลไทม์
// หมายเหตุ: การติดตามตำแหน่ง (watchPosition) ทำงานอยู่ตลอดเวลาแล้วผ่าน startLiveTracking()
// ฟังก์ชันด้านล่างแค่ "เปิด/ปิดโหมดนำทาง" (เช็คระยะ+แจ้งถึงจุดหมาย) ไม่ต้องเปิด watch ใหม่
function startNavigation(zone) {
  navigating = true;
  navigationTargetZone = zone;
  document.getElementById("nav-bar").classList.add("show");
  document.getElementById("nav-zone-name").textContent = `🧭 กำลังไป: ${zone.name}`;
  updateNavDistance(zone);
  showToast("เริ่มนำทางแบบเรียลไทม์แล้ว — จุดแดงจะอัปเดตตำแหน่งคุณสด");
}

function updateNavDistance(zone) {
  const distKm = haversineKm(userLocation.lat, userLocation.lng, zone.lat, zone.lng);
  const distM = Math.round(distKm * 1000);
  const distText = distM >= 1000 ? `${(distM / 1000).toFixed(2)} กม.` : `${distM} ม.`;
  const walkMinutes = Math.max(1, Math.round((distKm / 4.5) * 60)); // สมมติเดินเร็ว 4.5 กม./ชม.
  document.getElementById("nav-distance").textContent = `เหลือ ${distText} · ประมาณ ${walkMinutes} นาที`;
}

function stopNavigation() {
  navigating = false;
  navigationTargetZone = null;
  document.getElementById("nav-bar").classList.remove("show");
}

function triggerArrival(zone) {
  if (!navigating) return; // กันไม่ให้เด้งซ้ำหลังจากที่ยืนยันไปแล้วรอบหนึ่ง
  stopNavigation();
  document.getElementById("arrival-zone-name").textContent = `${zone.emoji || "📍"} ${zone.name}`;
  document.getElementById("arrival-sheet").classList.add("show");
  vibrateAlert();
}

async function handleCheckIn() {
  if (!currentRecommendation) return;
  const btn = document.getElementById("btn-checkin");
  btn.disabled = true;
  try {
    await checkInToZone(currentRecommendation);
    if (currentRequestId) {
      await updateDoc(doc(db, "safe_requests", currentRequestId), {
        checkedIn: true,
        checkInTime: serverTimestamp()
      });
      // เขียนจุดสาธารณะ (ไม่มีชื่อ/เบอร์) ให้ Dashboard สาธารณะเห็นว่า "มีคนปลอดภัยที่นี่" ได้
      await setDoc(doc(db, "public_pins", currentRequestId), {
        kind: "checkin",
        status: "safe",
        lat: currentRecommendation.lat,
        lng: currentRecommendation.lng,
        zoneName: currentRecommendation.name,
        createdAt: serverTimestamp()
      });
    }
    showToast(`✅ เช็คอินที่ ${currentRecommendation.name} สำเร็จ`);
    currentRecommendation.currentCount += 1;
    renderRecommendation(currentRecommendation);
  } catch (err) {
    console.error(err);
    showToast("เช็คอินไม่สำเร็จ ลองใหม่อีกครั้ง");
    btn.disabled = false;
  }
}

main();

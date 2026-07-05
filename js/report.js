// ============================================================================
// report.js — "แจ้งพิกัดของฉัน" สำหรับผู้ใช้ที่ไม่ได้เดินทางไปจุดปลอดภัยที่แนะนำ
// แต่ยังต้องการรายงานตำแหน่งและสถานะตัวเอง (ปลอดภัย/ไม่ปลอดภัย/ไม่แน่ใจ)
// ============================================================================

import { db, collection, doc, setDoc, serverTimestamp } from "./config.js";
import { getProfile } from "./profile.js";
import { showToast } from "./utils.js";

const STATUS_OPTIONS = [
  { key: "safe",   emoji: "✅", label: "ปลอดภัยดี ณ จุดนี้" },
  { key: "unsafe", emoji: "⚠️", label: "ไม่ปลอดภัย ต้องการความช่วยเหลือ" },
  { key: "unknown",emoji: "❓", label: "ไม่แน่ใจ / กำลังประเมินสถานการณ์" }
];

let getLocationFn = null;

export function initReport(getCurrentLocation) {
  getLocationFn = getCurrentLocation;
}

export function getReportStatusOptions() {
  return STATUS_OPTIONS;
}

export function openReportSheet() {
  document.getElementById("report-sheet").classList.add("show");
}

export function closeReportSheet() {
  document.getElementById("report-sheet").classList.remove("show");
}

/** ส่งรายงานพิกัด+สถานะของผู้ใช้ (ไม่ผูกกับจุดปลอดภัยที่ระบบแนะนำ) */
export async function submitReport(statusKey) {
  const location = await getLocationFn();
  const profile = getProfile();

  const ref = doc(collection(db, "status_reports"));

  // เอกสารเต็ม — มีชื่อ/เบอร์ เห็นได้เฉพาะ admin/หน่วยกู้ภัยที่ล็อกอินแล้ว
  await setDoc(ref, {
    userId: profile?.userId || null,
    userName: profile?.name || "ไม่ระบุชื่อ",
    userPhone: profile?.phone || null,
    lat: location.lat,
    lng: location.lng,
    status: statusKey,
    createdAt: serverTimestamp()
  });

  // เอกสารสาธารณะ — ไม่มีชื่อ/เบอร์ ใครก็เข้าดูได้
  await setDoc(doc(db, "public_pins", ref.id), {
    kind: "report",
    status: statusKey,
    lat: location.lat,
    lng: location.lng,
    createdAt: serverTimestamp()
  });

  closeReportSheet();
  showToast("📍 ส่งพิกัดและสถานะของคุณแล้ว");
  return ref.id;
}

// ============================================================================
// profile.js — เก็บข้อมูลผู้ใช้ (ชื่อ, เบอร์โทร) ก่อนเริ่มใช้งานระบบ
//
// เก็บไว้ใน localStorage ของเครื่องผู้ใช้เอง (ไม่ใช่ฐานข้อมูลกลาง) เพื่อไม่ต้อง
// กรอกซ้ำทุกครั้งที่เปิดแอปบนเครื่องเดียวกัน แต่ทุกครั้งที่ส่งข้อมูลไป Firestore
// (ขอจุดปลอดภัย / เช็คอิน / SOS) จะแนบชื่อ+รหัสผู้ใช้นี้ไปด้วยเสมอ เพื่อให้เจ้าหน้าที่
// ทราบว่า "ใครปลอดภัย ใครเกิดอุบัติเหตุ ใครติดอยู่" ได้จากหน้า Dashboard
// ============================================================================

const STORAGE_KEY = "plodpai_profile_v1";

function generateUserId() {
  return "u-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** อ่านโปรไฟล์ที่เคยบันทึกไว้ในเครื่อง (คืนค่า null ถ้ายังไม่เคยกรอก) */
export function getProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null; // เผื่อเบราว์เซอร์ปิด localStorage ไว้ (private mode บางกรณี)
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (e) {
    console.warn("บันทึกโปรไฟล์ไม่สำเร็จ (localStorage อาจถูกปิด):", e);
  }
}

/**
 * ต้องเรียกก่อนใช้งานฟีเจอร์หลักของแอป — ถ้ายังไม่เคยกรอกชื่อ จะเปิด modal ให้กรอกก่อน
 * คืนค่าเป็น Promise ที่ resolve เมื่อมีโปรไฟล์พร้อมใช้งานแล้ว (ไม่ว่าจะกรอกใหม่หรือเคยมีอยู่แล้ว)
 */
export function ensureProfile() {
  return new Promise((resolve) => {
    const existing = getProfile();
    if (existing && existing.name) {
      resolve(existing);
      return;
    }
    openProfileModal(resolve, existing);
  });
}

/** เปิด modal แก้ไข/กรอกข้อมูลผู้ใช้ เรียกใช้ได้ทั้งตอนเริ่มแอปและตอนกด "แก้ไขข้อมูล" ทีหลัง */
export function openProfileModal(onDone, existing = null) {
  const modal = document.getElementById("profile-modal");
  const form = document.getElementById("profile-form");
  const nameInput = document.getElementById("profile-name");
  const phoneInput = document.getElementById("profile-phone");
  const errorEl = document.getElementById("profile-error");

  const data = existing || getProfile();
  nameInput.value = data?.name || "";
  phoneInput.value = data?.phone || "";
  errorEl.style.display = "none";

  modal.classList.add("show");

  function handleSubmit(e) {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = "กรุณากรอกชื่อ-นามสกุลก่อนใช้งาน";
      errorEl.style.display = "block";
      return;
    }
    const profile = {
      userId: data?.userId || generateUserId(),
      name,
      phone: phoneInput.value.trim()
    };
    saveProfile(profile);
    modal.classList.remove("show");
    form.removeEventListener("submit", handleSubmit);
    if (onDone) onDone(profile);
  }

  form.addEventListener("submit", handleSubmit);
}

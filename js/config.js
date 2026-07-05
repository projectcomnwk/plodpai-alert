// ============================================================================
// config.js — เชื่อมต่อ Firebase สำหรับโปรเจค Plodpai Alert
// ไฟล์นี้ import จาก Firebase CDN โดยตรง ไม่ต้องใช้ npm/build tool ใดๆ
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  setDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Firebase config (จาก Firebase Console ของโปรเจค plodpai-alert) --------
const firebaseConfig = {
  apiKey: "AIzaSyAo57X5oBFiJdEMCYW1uXWrDs-mwCNAQ0A",
  authDomain: "plodpai-alert.firebaseapp.com",
  projectId: "plodpai-alert",
  storageBucket: "plodpai-alert.firebasestorage.app",
  messagingSenderId: "875023057159",
  appId: "1:875023057159:web:e98f5a89426ca6db69c5a2",
  measurementId: "G-W7D07EXE6H"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ส่งออกทุกอย่างที่ไฟล์อื่นในระบบต้องใช้ (import { db, collection, ... } from "./config.js")
export {
  db,
  collection,
  doc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  setDoc,
  getDoc
};

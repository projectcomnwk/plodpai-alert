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
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  getDoc,
  getDocs,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
const auth = getAuth(app);

// ส่งออกทุกอย่างที่ไฟล์อื่นในระบบต้องใช้ (import { db, collection, ... } from "./config.js")
export {
  firebaseConfig,
  db,
  auth,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  getDoc,
  getDocs,
  writeBatch,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
};

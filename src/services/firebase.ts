// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAY14cd-z9JDaINNabCsVAA9y2E1ZW833Q",
  authDomain: "fake-detect.firebaseapp.com",
  projectId: "fake-detect",
  storageBucket: "fake-detect.firebasestorage.app",
  messagingSenderId: "103176605981",
  appId: "1:103176605981:web:e20e11e9e7006bb77511f4",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

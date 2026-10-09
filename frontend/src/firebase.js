import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBqocBnVVa3Lra411wseWviZ50XEIcdbTw",
  authDomain: "chemxact-omr.firebaseapp.com",
  projectId: "chemxact-omr",
  storageBucket: "chemxact-omr.firebasestorage.app",
  messagingSenderId: "875125689980",
  appId: "1:875125689980:web:8d9b4bf0923c631fe883f9"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

export const loginWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logoutUser = () => signOut(auth);
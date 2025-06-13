import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

const serviceAccount = JSON.parse(
  readFileSync(
    "./linkedin-automation-31093-firebase-adminsdk-fbsvc-d9d2ed9b03.json",
    "utf8"
  )
);

// Initialize Firebase Admin
const app = initializeApp({
  credential: cert(serviceAccount),
});

// Get Firestore instance
const db = getFirestore(app);
if (
  process.env.FUNCTIONS_EMULATOR === "true" ||
  process.env.FIRESTORE_EMULATOR_HOST
) {
  db.settings({
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
  });
}

export { db, Timestamp };

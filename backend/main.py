import asyncio
import os
from datetime import date
from typing import List, Optional

import firebase_admin
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import auth as firebase_auth, credentials, firestore
from starlette.concurrency import run_in_threadpool

import omr_engine

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_IMAGE_BYTES = 10 * 1024 * 1024
DAILY_FREE_LIMIT = 15
MAX_CONCURRENT_SCANS = 2

credential_candidates = [
    os.environ.get("FIREBASE_ADMIN_CREDENTIALS", ""),
    os.path.join(BASE_DIR, "firebase-adminsdk.json"),
    os.path.join(BASE_DIR, "firebase-adminsdk.json.json"),
]
db = None
for credential_path in credential_candidates:
    if os.path.exists(credential_path):
        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app(credentials.Certificate(credential_path))
            db = firestore.client()
            print(f"Firebase connected successfully using {credential_path}")
            break
        except Exception as exc:
            print(f"Firebase connection error for {credential_path}: {exc}")
            break

if db is None:
    print("Firebase is unavailable; scan and quota endpoints will return an error.")

app = FastAPI()
allowed_origins = [
    origin.strip().rstrip("/")
    for origin in os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check():
    if db is None:
        return {
            "status": "degraded",
            "firebase": "unavailable",
            "detail": "Firebase is unavailable; scan and quota endpoints will return an error until credentials are configured.",
        }
    return {"status": "ok", "firebase": "ready"}


def require_user(authorization: Optional[str] = Header(default=None)):
    if db is None:
        raise HTTPException(status_code=503, detail="Firebase is unavailable; quota cannot be enforced.")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in is required.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        return firebase_auth.verify_id_token(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Your sign-in has expired. Please sign in again.") from exc


def _user_ref(uid: str):
    return db.collection("user_limits").document(uid)


def get_usage(uid: str):
    today = date.today().isoformat()
    snapshot = _user_ref(uid).get()
    data = snapshot.to_dict() or {}
    scans_today = data.get("scans_today", 0) if data.get("last_scan_date") == today else 0
    is_premium = bool(data.get("is_premium", False))
    return {
        "scans_today": scans_today,
        "daily_limit": DAILY_FREE_LIMIT,
        "remaining": max(0, DAILY_FREE_LIMIT - scans_today) if not is_premium else None,
        "is_premium": is_premium,
        "resets_on": today,
    }


def reserve_scan(uid: str, email: str):
    today = date.today().isoformat()
    ref = _user_ref(uid)
    transaction = db.transaction()

    @firestore.transactional
    def reserve(transaction):
        snapshot = ref.get(transaction=transaction)
        data = snapshot.to_dict() or {}
        is_premium = bool(data.get("is_premium", False))
        scans_today = data.get("scans_today", 0) if data.get("last_scan_date") == today else 0
        if not is_premium and scans_today >= DAILY_FREE_LIMIT:
            return False
        if not is_premium:
            scans_today += 1
            transaction.set(ref, {
                "email": email,
                "scans_today": scans_today,
                "last_scan_date": today,
                "is_premium": False,
            }, merge=True)
        return True

    return reserve(transaction)


def release_failed_scan(uid: str):
    today = date.today().isoformat()
    ref = _user_ref(uid)
    transaction = db.transaction()

    @firestore.transactional
    def release(transaction):
        snapshot = ref.get(transaction=transaction)
        data = snapshot.to_dict() or {}
        if (
            data.get("last_scan_date") == today
            and not data.get("is_premium", False)
            and data.get("scans_today", 0) > 0
        ):
            transaction.set(ref, {"scans_today": data["scans_today"] - 1}, merge=True)

    release(transaction)


@app.get("/api/usage")
def read_usage(user=Depends(require_user)):
    return get_usage(user["uid"])


@app.post("/api/bulk-scan")
async def bulk_scan(
    files: List[UploadFile] = File(...),
    answer_key: str = Form(...),
    user=Depends(require_user),
):
    if not files:
        raise HTTPException(status_code=400, detail="Select at least one OMR image.")
    if not answer_key or any(choice not in "ABCD" for choice in answer_key.upper()):
        raise HTTPException(status_code=400, detail="Answer key must contain at least one choice (A-D).")

    uid = user["uid"]
    email = user.get("email", "")
    results = [None] * len(files)
    quota_reached = False

    async def scan_one(index, filename, image_bytes):
        scan = await run_in_threadpool(
            omr_engine.process_omr_image,
            image_bytes,
            answer_key.upper(),
        )
        if not scan.get("success"):
            await run_in_threadpool(release_failed_scan, uid)
            return {
                "filename": filename,
                "status": "Failed",
                "message": scan.get("message", "Scan failed."),
            }
        return {
            "filename": filename,
            "student_name": scan["student_name"],
            "roll": scan["roll"],
            "score": scan["score"],
            "total": scan["total"],
            "status": "Scanned",
            "details": scan["details"],
        }

    for batch_start in range(0, len(files), MAX_CONCURRENT_SCANS):
        batch_end = min(batch_start + MAX_CONCURRENT_SCANS, len(files))
        scan_jobs = []
        for index in range(batch_start, batch_end):
            uploaded_file = files[index]
            filename = uploaded_file.filename or f"Sheet {index + 1}"
            if not reserve_scan(uid, email):
                quota_reached = True
                for pending_index in range(index, len(files)):
                    pending = files[pending_index]
                    results[pending_index] = {
                        "filename": pending.filename or f"Sheet {pending_index + 1}",
                        "status": "Not scanned",
                        "message": "Daily limit reached. Try again tomorrow.",
                    }
                break

            image_bytes = await uploaded_file.read(MAX_IMAGE_BYTES + 1)
            if len(image_bytes) > MAX_IMAGE_BYTES:
                await run_in_threadpool(release_failed_scan, uid)
                results[index] = {
                    "filename": filename,
                    "status": "Failed",
                    "message": "Image exceeds the 10 MB limit.",
                }
                continue
            scan_jobs.append((index, filename, image_bytes))

        batch_results = await asyncio.gather(*(
            scan_one(index, filename, image_bytes)
            for index, filename, image_bytes in scan_jobs
        ))
        for (index, _, _), result in zip(scan_jobs, batch_results):
            results[index] = result
        if quota_reached:
            break

    return {
        "success": True,
        "results": results,
        "quota_reached": quota_reached,
        "usage": get_usage(uid),
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", os.environ.get("OMR_PORT", "8001")))
    uvicorn.run(app, host="0.0.0.0", port=port)

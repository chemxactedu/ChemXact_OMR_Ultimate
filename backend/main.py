import asyncio
import logging
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
MAX_SCAN_FILES = 4
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


def _public_stats_ref():
    return db.collection("public_stats").document("usage")


def track_teacher(uid: str):
    stats_ref = _public_stats_ref()
    teacher_ref = stats_ref.collection("teachers").document(uid)
    transaction = db.transaction()

    @firestore.transactional
    def track(transaction):
        teacher_snapshot = next(transaction.get(teacher_ref))
        if teacher_snapshot.exists:
            return
        stats_snapshot = next(transaction.get(stats_ref))
        stats = stats_snapshot.to_dict() or {}
        transaction.set(teacher_ref, {"tracked_at": firestore.SERVER_TIMESTAMP})
        transaction.set(stats_ref, {
            "teachers": int(stats.get("teachers", 0)) + 1,
        }, merge=True)

    track(transaction)


def record_scanned_sheets(count: int):
    if count:
        _public_stats_ref().set(
            {"scanned_sheets": firestore.Increment(count)},
            merge=True,
        )


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


@app.get("/api/public-stats")
def read_public_stats():
    if db is None:
        raise HTTPException(status_code=503, detail="Usage statistics are temporarily unavailable.")
    snapshot = _public_stats_ref().get()
    stats = snapshot.to_dict() or {}
    return {
        "teachers": max(0, int(stats.get("teachers", 0))),
        "scanned_sheets": max(0, int(stats.get("scanned_sheets", 0))),
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
    try:
        track_teacher(user["uid"])
    except Exception:
        logging.exception("Could not update aggregate teacher statistics.")
    return get_usage(user["uid"])


@app.post("/api/bulk-scan")
async def bulk_scan(
    files: List[UploadFile] = File(...),
    answer_key: str = Form(...),
    user=Depends(require_user),
):
    if not files:
        raise HTTPException(status_code=400, detail="Select at least one OMR image.")
    if len(files) > MAX_SCAN_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"You can scan up to {MAX_SCAN_FILES} sheets at a time.",
        )
    if not answer_key or any(choice not in "ABCD" for choice in answer_key.upper()):
        raise HTTPException(status_code=400, detail="Answer key must contain at least one choice (A-D).")

    uid = user["uid"]
    email = user.get("email", "")
    results = [None] * len(files)
    quota_reached = False
    quota_error = None

    async def failed_scan(filename, message):
        try:
            await run_in_threadpool(release_failed_scan, uid)
        except Exception:
            logging.exception("Could not restore scan quota after a failed scan.")
            message = "The sheet could not be scanned, and the quota update could not be confirmed. Refresh your scan limit before retrying."
        return {
            "filename": filename,
            "status": "Failed",
            "message": message,
        }

    async def scan_one(index, filename, image_bytes):
        try:
            scan = await run_in_threadpool(
                omr_engine.process_omr_image,
                image_bytes,
                answer_key.upper(),
            )
        except Exception:
            logging.exception("Unexpected error while scanning uploaded sheet %s.", index + 1)
            return await failed_scan(filename, "A temporary scanner error interrupted this sheet. Its scan allowance has been restored; please retry.")
        if not isinstance(scan, dict) or not scan.get("success"):
            message = scan.get("message", "Scan failed.") if isinstance(scan, dict) else "The scanner returned an invalid response. Please retry."
            return await failed_scan(filename, message)
        try:
            return {
                "filename": filename,
                "student_name": scan["student_name"],
                "roll": scan["roll"],
                "score": scan["score"],
                "total": scan["total"],
                "status": "Scanned",
                "details": scan["details"],
            }
        except (KeyError, TypeError):
            logging.exception("Scanner returned an incomplete result for sheet %s.", index + 1)
            return await failed_scan(filename, "The scanner returned incomplete results for this sheet. Its scan allowance has been restored; please retry.")

    for batch_start in range(0, len(files), MAX_CONCURRENT_SCANS):
        batch_end = min(batch_start + MAX_CONCURRENT_SCANS, len(files))
        scan_jobs = []
        for index in range(batch_start, batch_end):
            uploaded_file = files[index]
            filename = uploaded_file.filename or f"Sheet {index + 1}"
            try:
                reserved = await run_in_threadpool(reserve_scan, uid, email)
            except Exception:
                logging.exception("Could not reserve scan quota for uploaded sheet %s.", index + 1)
                quota_error = "Could not confirm scan allowance. This and any remaining sheets were not started; completed results are included."
                for pending_index in range(index, len(files)):
                    pending = files[pending_index]
                    results[pending_index] = {
                        "filename": pending.filename or f"Sheet {pending_index + 1}",
                        "status": "Not scanned",
                        "message": quota_error,
                    }
                break
            if not reserved:
                quota_reached = True
                for pending_index in range(index, len(files)):
                    pending = files[pending_index]
                    results[pending_index] = {
                        "filename": pending.filename or f"Sheet {pending_index + 1}",
                        "status": "Not scanned",
                        "message": "Daily limit reached. Try again tomorrow.",
                    }
                break

            try:
                image_bytes = await uploaded_file.read(MAX_IMAGE_BYTES + 1)
            except Exception:
                logging.exception("Could not read uploaded sheet %s.", index + 1)
                results[index] = await failed_scan(
                    filename,
                    "The uploaded image could not be read. Its scan allowance has been restored; please retry.",
                )
                continue
            if len(image_bytes) > MAX_IMAGE_BYTES:
                results[index] = await failed_scan(filename, "Image exceeds the 10 MB limit.")
                continue
            scan_jobs.append((index, filename, image_bytes))

        batch_results = await asyncio.gather(*(
            scan_one(index, filename, image_bytes)
            for index, filename, image_bytes in scan_jobs
        ))
        for (index, _, _), result in zip(scan_jobs, batch_results):
            results[index] = result
        if quota_reached or quota_error:
            break

    try:
        await run_in_threadpool(record_scanned_sheets, sum(
            result is not None and result["status"] == "Scanned"
            for result in results
        ))
    except Exception:
        logging.exception("Could not update aggregate scanned-sheet statistics.")

    usage = None
    usage_error = None
    try:
        usage = await run_in_threadpool(get_usage, uid)
    except Exception:
        logging.exception("Could not refresh scan quota after the scan batch.")
        usage_error = "Scan results are ready, but the scan limit could not be refreshed. Please retry the limit check."

    return {
        "success": True,
        "results": results,
        "quota_reached": quota_reached,
        "quota_error": quota_error,
        "usage": usage,
        "usage_error": usage_error,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", os.environ.get("OMR_PORT", "8001")))
    uvicorn.run(app, host="0.0.0.0", port=port)

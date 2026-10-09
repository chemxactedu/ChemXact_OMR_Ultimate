import io
import json
import logging
import os
import re
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image, ImageOps, UnidentifiedImageError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GEMINI_MODEL = "gemini-3.8-flash"
FALLBACK_GEMINI_MODELS = ("gemini-3.7-flash", "gemini-3.6-flash")
MAX_GEMINI_ATTEMPTS_PER_MODEL = 2
load_dotenv(os.path.join(BASE_DIR, ".env"))


def _extract_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Gemini returned no valid JSON object.")
        parsed = json.loads(cleaned[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Gemini response must be a JSON object.")
    return parsed


def _is_retryable_error(error: Exception) -> bool:
    code = getattr(error, "code", None)
    if code is None:
        code = getattr(error, "status_code", None)
    if isinstance(code, int):
        return code in {404, 429, 500, 502, 503, 504}

    error_text = f"{code or ''} {error}".upper()
    return (
        bool(re.search(r"\b(404|429|500|502|503|504)\b", error_text))
        or any(status in error_text for status in ("NOT_FOUND", "UNAVAILABLE", "RESOURCE_EXHAUSTED"))
        or (
            "MODEL" in error_text
            and any(phrase in error_text for phrase in ("NOT FOUND", "NO LONGER AVAILABLE", "UNAVAILABLE"))
        )
    )


def _is_model_unavailable_error(error: Exception) -> bool:
    code = getattr(error, "code", None)
    if code is None:
        code = getattr(error, "status_code", None)
    error_text = f"{code or ''} {error}".upper()
    return (
        code == 404
        or any(status in error_text for status in ("NOT_FOUND", "UNAVAILABLE"))
        or (
            "MODEL" in error_text
            and any(phrase in error_text for phrase in ("NOT FOUND", "NO LONGER AVAILABLE"))
        )
    )


def _read_once(client, prompt: str, image_parts: list, question_count: int) -> dict:
    last_retryable_error = None
    models = (GEMINI_MODEL, *FALLBACK_GEMINI_MODELS)
    for model in models:
        for attempt in range(MAX_GEMINI_ATTEMPTS_PER_MODEL):
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=[prompt, *image_parts],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                        thinking_config=types.ThinkingConfig(thinking_level="high"),
                    ),
                )
                result = _extract_json(response.text or "")
                answers = result.get("answers")
                if not isinstance(answers, list) or len(answers) != question_count:
                    raise ValueError(f"Gemini did not return exactly {question_count} answers.")
                return result
            except Exception as exc:
                if not _is_retryable_error(exc):
                    raise
                last_retryable_error = exc
                logging.warning(
                    "Gemini model %s failed (attempt %s/%s).",
                    model,
                    attempt + 1,
                    MAX_GEMINI_ATTEMPTS_PER_MODEL,
                )
                if _is_model_unavailable_error(exc):
                    break
                if attempt + 1 < MAX_GEMINI_ATTEMPTS_PER_MODEL:
                    time.sleep(2 ** attempt)

    raise last_retryable_error or RuntimeError("Gemini read did not complete.")


def _encode_jpeg(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=94, optimize=True)
    return output.getvalue()


def _build_vision_parts(image_bytes: bytes) -> list:
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")

    parts = [
        types.Part.from_text(text="Full sheet image. Use it to understand the page layout and question order."),
        types.Part.from_bytes(data=_encode_jpeg(image), mime_type="image/jpeg"),
    ]

    width, height = image.size
    middle_x, middle_y = width // 2, height // 2
    overlap_x, overlap_y = max(1, width // 20), max(1, height // 20)
    regions = [
        ("top-left", (0, 0, min(width, middle_x + overlap_x), min(height, middle_y + overlap_y))),
        ("top-right", (max(0, middle_x - overlap_x), 0, width, min(height, middle_y + overlap_y))),
        ("bottom-left", (0, max(0, middle_y - overlap_y), min(width, middle_x + overlap_x), height)),
        ("bottom-right", (max(0, middle_x - overlap_x), max(0, middle_y - overlap_y), width, height)),
    ]

    for label, bounds in regions:
        crop = image.crop(bounds)
        if max(crop.size) < 1400:
            scale = 1400 / max(crop.size)
            crop = crop.resize(
                (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
                Image.Resampling.LANCZOS,
            )
        parts.append(types.Part.from_text(text=f"Enlarged sheet detail: {label}. Read these bubbles closely."))
        parts.append(types.Part.from_bytes(data=_encode_jpeg(crop), mime_type="image/jpeg"))
    return parts


def process_omr_image(image_bytes: bytes, answer_key: str):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"success": False, "message": "Ousi Vision is not configured on the scan service."}
    if not re.fullmatch(r"[ABCD]+", answer_key):
        return {"success": False, "message": "Answer key must contain at least one choice (A-D)."}
    question_count = len(answer_key)

    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.verify()
            image_format = (image.format or "").upper()
    except (UnidentifiedImageError, OSError, ValueError):
        return {"success": False, "message": "Uploaded file is not a valid image."}

    mime_type = {
        "JPEG": "image/jpeg",
        "PNG": "image/png",
        "WEBP": "image/webp",
        "GIF": "image/gif",
        "BMP": "image/bmp",
    }.get(image_format)
    if mime_type is None:
        return {"success": False, "message": f"Unsupported image format: {image_format or 'unknown'}."}

    prompt = f"""
You are an accurate OMR sheet reader. The images show the same answer sheet: first the full
page, then four enlarged, overlapping details. Use the full page to follow question numbers
and the enlarged details to inspect bubble interiors.

Read the student's name and roll/role number exactly as printed or written. If either is
missing or unreadable, return an empty string for that field. Read only the first {question_count}
questions, following their printed question numbers. Inspect the four answer bubbles for each
question individually. A selected bubble has visible pencil or pen shading inside
the bubble, even if the fill is partial or lighter than other marks. Do not require a perfectly
dark fill. Compare the inside of each bubble with its printed outline and the other bubbles
in that same question. An empty outlined circle, printed letter, white interior, shadow, crease,
or isolated stray mark is not a selected answer.

Return A, B, C, or D for the bubble with visible interior shading. Return "N/A" only when all
four interiors appear unmarked, two or more options are marked, or the mark cannot be
distinguished from image noise after checking the enlarged details. Do not treat faint but
visible pencil shading as blank. Do not guess from answer patterns or from what seems likely.

Follow the printed question numbers carefully and do not shift answers between rows. Read
marks only from visible image evidence. When uncertain whether any bubble is truly filled,
return "N/A" instead of guessing.

Return only a valid JSON object, without markdown, with these fields:
- "student_name": a string
- "roll": a string
- "answers": an array containing exactly {question_count} strings, one for each question in order;
  each entry must be "A", "B", "C", "D", or "N/A"
Do not include an answer key or calculate a score.
"""
    try:
        client = genai.Client(api_key=api_key)
        image_parts = _build_vision_parts(image_bytes)
        result = _read_once(client, prompt, image_parts, question_count)

        details = []
        for index, (detected, correct) in enumerate(zip(result["answers"], answer_key), start=1):
            normalized = str(detected).strip().upper()
            if normalized not in {"A", "B", "C", "D"}:
                normalized = "N/A"
            details.append({
                "question": index,
                "detected": normalized,
                "correct": correct,
                "isCorrect": normalized == correct,
            })

        def clean_field(field: str) -> str:
            return " ".join(str(result.get(field) or "").split()) or "Unknown"

        return {
            "success": True,
            "student_name": clean_field("student_name"),
            "roll": clean_field("roll"),
            "total": question_count,
            "score": sum(detail["isCorrect"] for detail in details),
            "details": details,
        }
    except Exception as exc:
        if _is_retryable_error(exc):
            error_code = getattr(exc, "code", getattr(exc, "status_code", "unknown"))
            logging.error(
                "Gemini scan failed after retrying available vision models (%s, code %s).",
                type(exc).__name__,
                error_code,
            )
            return {
                "success": False,
                "message": (
                    "Ousi Vision is temporarily unavailable. "
                    "Please try again shortly; this failed scan does not use your daily quota."
                ),
            }
        if isinstance(exc, ValueError):
            return {
                "success": False,
                "message": f"Ousi Vision could not read all {question_count} answers. Please upload a clearer, full-sheet image.",
            }
        return {"success": False, "message": "Ousi Vision could not complete this scan. Please try again."}

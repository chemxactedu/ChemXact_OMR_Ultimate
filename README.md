# ChemXact OMR Scanner

OMR sheets are read from the full-page image using Gemini Vision. The scanner extracts
the student's name and roll/role, reads as many answers as entered in the app, and
calculates the number of correct answers against that answer key. The number of answers
entered sets the question count. Teachers can also enter the exam's full marks, which
are shown separately and do not rescale the correct-answer score. Results can be exported
as Excel, PDF, or Word.
Each sheet is normally sent to Gemini 3.8 Flash once, using high visual resolution and
high thinking effort, as a full-page image plus four enlarged, overlapping details.
Batch scans process up to two sheets at a time to reduce waiting without overwhelming
the free-tier backend.
If the model is unavailable or rate-limited, the backend retries and automatically
switches to Gemini 3.7 Flash and then Gemini 3.6 Flash. Scores are calculated locally
from the returned answers. Empty bubble outlines and unfilled spaces should be reported
as N/A, not inferred choices; unclear answers are flagged for teacher review against
the sheet image.

## Backend setup

1. Create and activate a Python virtual environment in `backend`.
2. Install dependencies: `pip install -r requirements.txt`.
3. Set `GEMINI_API_KEY` in `backend/.env`.
4. Place the Firebase Admin service-account credential file in `backend` as
   `firebase-adminsdk.json` or `firebase-adminsdk.json.json`, or set
   `FIREBASE_ADMIN_CREDENTIALS` to its mounted path.
5. Start the API: `python main.py`.

The API verifies the Firebase sign-in token and stores daily usage in Firestore.
Each free account can scan 15 sheets per calendar day. Failed image/AI scans are
not charged. A batch stops when the account reaches its daily quota; unscanned
sheets can be submitted the next day.

If Firebase credentials are not mounted yet, the app still boots successfully and
`/health` responds with a `degraded` status instead of crashing the deployment;
the authenticated scan and quota endpoints keep returning a 503 until Firebase is
available.

## Frontend setup

1. In `frontend`, install packages with `npm install`.
2. Start the app with `npm run dev`.
3. Sign in with Google, enter the answer key in the answer-key box (the number entered
   sets the question count), enter optional full marks, select full-sheet images, and scan.

The backend defaults to port `8001` (`PORT` or `OMR_PORT` can override it). For local development,
the frontend defaults to `http://localhost:8001`; for a deployed build, set
`VITE_API_BASE_URL` to the public backend URL. If a local frontend uses the deployed API,
include `http://localhost:5173` and `http://127.0.0.1:5173` in the Render service's
`CORS_ORIGINS` value alongside the deployed website origin.

## Production deployment checklist

- The Netlify configuration builds `frontend` and publishes its `dist` directory.
  Add `omr.chemxact.in` as the Netlify site's custom domain and configure its DNS
  record with the value Netlify provides.
- Deploy the API using the root `render.yaml` Blueprint. In Render, add the Firebase
  Admin service-account JSON as a Secret File named `firebase-adminsdk.json`; its
  mounted path must be `/etc/secrets/firebase-adminsdk.json`. Add the Gemini API key
  as the `GEMINI_API_KEY` secret. The Blueprint restricts API CORS to
  `https://omr.chemxact.in` and checks `/health`.
- After Render gives the API its public HTTPS URL, set Netlify's `VITE_API_BASE_URL`
  environment variable to that URL and trigger a fresh deploy. For a local production
  build, copy `frontend/.env.example` to `frontend/.env.production` and replace its
  sample URL.
- Add `omr.chemxact.in` to Firebase Authentication's authorized domains and enable
  Google sign-in.
- Configure `omr.chemxact.in` as a Netlify custom domain and set its DNS record to
  the target Netlify provides.
- Never upload `.env` files or Firebase Admin service-account JSON files. Store them in
  the host's secret manager; mount the Firebase credential file securely.
- Confirm login and authenticated API calls on the hosted site, then test a real OMR
  sheet end-to-end. Local builds and mocked model tests do not validate live scan
  accuracy or model availability.

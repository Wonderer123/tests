# Mock Tracker

A free, phone-friendly dashboard for tracking Guidely banking mock results over time:
scores vs cut-off, percentile, section trends, attempts vs Guidely's "good attempts" range,
time management, and topic-wise strengths and weaknesses.

One link does everything: viewing the dashboard and adding, editing or deleting mocks.
Nobody needs a login. Saving changes needs a PIN.

```
GitHub Pages (index.html)  ──fetch──▶  Google Apps Script web app  ──▶  Google Sheet
   dashboard + form                       doGet / doPost, runs as owner      Exams / Sections / Topics tabs
```

- **Frontend:** plain HTML, CSS and JavaScript, with Chart.js from a CDN. No build step.
- **Backend:** `apps-script/Code.gs`, deployed as a web app.
- **Database:** a private Google Sheet. It is never published; data is only reachable through the script.

## Files

| File | What it is |
|---|---|
| `index.html` | The page: Dashboard, Add mock and History tabs |
| `style.css` | Styles (mobile-first, automatic dark mode) |
| `config.js` | **Settings:** script URL, exam types, sections, topic lists, weak/strong thresholds |
| `calc.js` | All calculations (scores, KPIs, topic stats); no UI code |
| `app.js` | UI, network calls, charts |
| `apps-script/Code.gs` | Backend; paste into the Google Apps Script editor |
| `seed/seed-data.json` | The first 8 mocks, for importing once. **Not committed** (see `.gitignore`) |

## Setup (one time)

### 1. Google Sheet + Apps Script
1. Create a blank Google Sheet on your account (e.g. "Mock Tracker"). Leave it empty.
2. **Extensions → Apps Script.** Delete everything in `Code.gs`, paste the contents of
   `apps-script/Code.gs`, and click 💾 **Save**.
3. ⚙️ **Project Settings → Script Properties → Add script property**: `PIN` = your PIN (4–6 digits).
   *Optional:* add `READ_PIN_REQUIRED` = `true` if viewing the dashboard should also need the PIN.
4. Back in the editor, pick **`setup`** in the function dropdown → **Run**. Google asks for
   permission ("Review permissions" → choose your account → *Advanced* → *Go to … (unsafe)* → *Allow*).
   This is normal for your own scripts. The three tabs `Exams`, `Sections` and `Topics` appear in the Sheet.

### 2. Deploy the web app
1. **Deploy → New deployment** → ⚙️ type **Web app**.
2. *Execute as:* **Me**. *Who has access:* **Anyone**.
3. **Deploy** → copy the **Web app URL** (ends in `/exec`).

### 3. Connect the site
1. Paste the URL into `config.js`: `SCRIPT_URL: 'https://script.google.com/macros/s/…/exec'`.
2. Commit and push to GitHub.
3. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**
   After a minute the site is live at `https://<username>.github.io/<repo>/`.

### 4. Load the first 8 mocks
Open the site on a computer → **History → Import backup (JSON)…** → choose `seed/seed-data.json`
→ enter the PIN. Mocks that already exist are skipped, so importing twice is harmless.

## Day-to-day use

- **Add mock:** fill in the details from Guidely's result page. Score, attempted, skipped and
  accuracy are calculated automatically (1 mark, −0.25 per wrong answer). Topic-wise and time split are optional.
- **Topic-wise:** copy Guidely's "Know Your Strength & Weakness" table. For each topic, enter
  total questions (all boxes), correct (green) and wrong (red). The form checks the totals add up.
- **Incomplete attempt:** tick it for a mock abandoned early. It stays in History but is left out of the stats.
- **Edit / Delete:** in History.
- **Backup:** History → *Download backup (JSON)* (can be re-imported) or *Download CSV*.

## Changing things

- **New kind of test (sectional, mains…):** just type a new exam type name in the form and tick its
  sections; the number of questions per section can be changed per mock. The dashboard filters by
  exam type and opens on `DEFAULT_EXAM_TYPE`, so 40-mark sectionals don't mix into 80-mark mock trends.
- **Exam types, sections, topics, thresholds:** edit `config.js` and push. Existing data keeps working.
- **Change the PIN:** Apps Script → Project Settings → Script Properties.
- **After editing `Code.gs`:** **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
  The URL stays the same. (A *New deployment* would create a new URL.)

## Preview locally

```
python -m http.server 8000
```
Open http://localhost:8000. With `SCRIPT_URL` empty the app runs in **demo mode**,
showing `seed/seed-data.json` if it exists. Saving is disabled in demo mode.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Unexpected reply from the server" | The deployment's access must be **Anyone** (not "Anyone with a Google account"), and `SCRIPT_URL` must end in `/exec`. |
| Code changes don't take effect | Deploy a **new version** of the existing deployment (see above). |
| "PIN is not set up on the server" | Add the `PIN` Script Property. |
| "Too many wrong PINs" | 10 wrong PINs lock saving for 10 minutes. Wait, then retry. |
| Dashboard shows old data | Pull to refresh / reload. The app shows its last saved copy when offline. |

## Notes on security

- The PIN lives only in Script Properties, never in this repo.
- Writes are validated on the server, and a lock stops simultaneous saves from colliding.
- Requests are sent as `text/plain` so browsers don't send a CORS preflight, which Apps Script can't answer.
- Anyone with the site link can *view* the dashboard unless `READ_PIN_REQUIRED` is `true`.

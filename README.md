# 🌱 PosturePal: a posture coach that texts you

A webcam posture tracker that **you turn on and off yourself**. People sign up on the website with their name and iPhone number. PosturePal learns each person's good posture in their normal chair, then sends an **iMessage through Photon Spectrum** when they slouch. They can text it back.

**Privacy by design**
- The camera only turns on when you click **Start**, and it turns off (light goes out) on **Stop**.
- All pose detection runs **in the browser** with Google MediaPipe. No video or images are saved or uploaded.
- Only small JSON numbers reach the server (shown live in the "Privacy" panel).
- Tracking can be **stopped** by iMessage but **never started** remotely. Auto-stops after 3 hours.
- Server listens on `localhost` only. People can reply `unsubscribe` anytime.

## How it works

```
Webcam ─► Browser (MediaPipe Pose, on-device)
             │  {"issue":"slouching","seconds":31}   ← numbers only
             ▼
        Bun server (src/index.ts) ── Claude API (friendly nudges)
             │                    └─ Photon CLI (registers new sign-ups as Photon users)
             ▼
        Photon Spectrum ─► 📱 iMessage  ◄─ reply "hi", "status", "snooze 15", "stop"
```

| Part | Tool |
|---|---|
| Pose detection | Google MediaPipe Pose Landmarker (in the browser) |
| Messages | Claude API (optional) |
| iMessage | Photon Spectrum (`spectrum-ts`) |
| Adding users to Photon | Photon CLI (`@photon-ai/cli`) |
| Server / runtime | Bun + TypeScript |

---

## Setup (Mac)

### 1. Install Bun
```bash
curl -fsSL https://bun.sh/install | bash
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.zshrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
bun --version
```

### 2. Install and log in to the Photon CLI
```bash
bun add -g @photon-ai/cli
photon login        # approve in the browser
photon whoami       # should show your email
```

### 3. Install the project
Unzip this folder (e.g. to your Desktop), then:
```bash
cd ~/Desktop/posturepal
bun install
cp .env.example .env
open -e .env
```
Fill in `PROJECT_ID` and `PROJECT_SECRET` (Photon dashboard → your project → Settings), plus `ANTHROPIC_API_KEY` if you have one.

> Already have a folder made by `bun create spectrum-project ... --projectId ...`? Just copy its `.env` into this folder. It already has `PROJECT_ID` and `PROJECT_SECRET`.

### 4. Run it
```bash
bun start
```
You should see:
```
✅ Connected to Photon Spectrum (iMessage)
✅ PosturePal running at http://localhost:3000
```
Keep this Terminal window open while using the app.

---

## Using it

1. Open **http://localhost:3000** in Chrome.
2. **Sign up**: first name, last name, email, iPhone number (with `+1`), and tick the consent box. The server adds the person to your Photon project automatically.
3. **Activate**: the person gets a welcome iMessage and **replies "hi"**. Photon only allows a couple of messages until the person replies once. The yellow banner on the page disappears on its own when they do. (The text may land in **Unknown Senders**.)
4. Click **🔔 Send test nudge** to confirm texts arrive.
5. Click **▶ Start tracking**. The first time, sit up straight in your normal chair and hold still for 5 seconds to calibrate.
6. Slouch for the "Alert after" time (15/30/60 s) and the phone buzzes.
7. Click **■ Stop** to end. A session summary arrives by iMessage.

**Switching people:** click **Sign out**, then the next person signs up (or signs back in with the same phone number). Each person has their own calibration, nudges and history.

**Text commands**

| Text | What it does |
|---|---|
| `hi` | Activates nudges (first time) |
| `help` | List commands |
| `status` | Minutes so far, % upright, nudges |
| `snooze 15` | Quiet for 15 minutes (default 30) |
| `resume` | Turn alerts back on |
| `stop` | Turns tracking and the camera off |
| `history` | Last 5 sessions |
| `unsubscribe` / `subscribe` | Stop / restart all texts |
| anything else | Chat with the coach |

---

## What it detects

Compared with each person's own calibration, using MediaPipe's nose, ear and shoulder points:

| Issue | Measurement | Triggers when (medium sensitivity) |
|---|---|---|
| Slouching | Nose height above shoulders ÷ shoulder width | Drops more than 15% |
| Head forward | Ear height above shoulders ÷ shoulder width | Drops more than 18% |
| Leaning in | Shoulder width on camera | Grows more than 15% |
| Tilted | Left/right shoulder height difference | Grows by more than 0.10 |

Safeguards: smoothing to remove jitter, bad posture must **last** before an alert, walking away pauses tracking, 3 s of good posture resets the timer, and a cooldown between nudges (`ALERT_COOLDOWN_MINUTES`, set it to `1` for demos).

---

## Files

```
posturepal/
├── src/index.ts       # server: sign-up, Photon users, Spectrum iMessage, Claude, posture events
├── docs/              # the website (also what GitHub Pages publishes)
│   ├── index.html     # sign-up screen + tracker UI
│   ├── style.css      # styles (light/dark)
│   ├── app.js         # camera, MediaPipe, calibration, posture logic
│   └── config.js      # where the website finds the server (for GitHub Pages)
├── data/              # created automatically: users.json, sessions.json
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Put the website on GitHub Pages

GitHub Pages only hosts the **website** (the `docs/` folder). The **server** (`bun start`) keeps running on your Mac, because it holds your Photon secret and sends the iMessages. A free **Cloudflare Tunnel** gives your Mac a secure public address the website can talk to.

```
https://YOU.github.io/posturepal  (GitHub Pages: website)
        │  sign-up + posture numbers
        ▼
https://xxxx.trycloudflare.com    (Cloudflare Tunnel)
        ▼
localhost:3000 on your Mac        (bun start: Photon + Claude)
```

### 1. Put the code on GitHub
1. On github.com click **+ → New repository**. Name it `posturepal`, choose **Public**, and don't add a README. Click **Create repository**.
2. In Terminal:
   ```bash
   cd ~/Desktop/posturepal
   git init
   git add .
   git status          # make sure .env and data/ are NOT in the list
   git commit -m "PosturePal"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/posturepal.git
   git push -u origin main
   ```
   If it asks for a password, GitHub needs a **personal access token**, not your password (GitHub → Settings → Developer settings → Personal access tokens). Or use the **GitHub Desktop** app instead of these commands.

### 2. Turn on GitHub Pages
Repository → **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, folder: **/docs** → **Save**. After a minute or two your site is at `https://YOUR-USERNAME.github.io/posturepal/`.

### 3. Start the tunnel on your Mac
Install cloudflared once:
```bash
brew install cloudflared
```
(No Homebrew? Get it from https://brew.sh first.)

Then, with `bun start` running in one Terminal window, open a **second** window:
```bash
cloudflared tunnel --url http://localhost:3000
```
It prints an address like `https://quiet-river-1234.trycloudflare.com`. Keep this window open too.

### 4. Connect the website to the tunnel
Edit `docs/config.js`:
```js
window.POSTUREPAL_API = "https://quiet-river-1234.trycloudflare.com";
```
Then publish it:
```bash
git add docs/config.js
git commit -m "Point site at server"
git push
```

### 5. Only allow your site to use the server
Add to `.env` (then Ctrl+C and `bun start` again):
```
ALLOWED_ORIGINS=https://YOUR-USERNAME.github.io
```

### Things to know
- **Your Mac must stay on**, with both `bun start` and `cloudflared` running. If either stops, the site shows "Can't reach the PosturePal server."
- **The tunnel address changes every time you restart cloudflared.** Update `docs/config.js` and push again. Shortcut: open the site once as `https://YOUR-USERNAME.github.io/posturepal/?api=https://NEW-ADDRESS.trycloudflare.com`, and that browser remembers it.
- **Anyone with the link can sign up**, and each sign-up uses Photon's free-plan limits. Sign-ups are capped at `SIGNUPS_PER_HOUR` (default 30) in `.env`.
- Localhost still works the same: http://localhost:3000.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| `zsh: command not found: bun` | Redo step 1, then open a new Terminal window. |
| Sign-up error "Could not run the Photon CLI" | Do step 2 (`bun add -g @photon-ai/cli`, `photon login`). |
| `🔒 … must reply to PosturePal's text` | Photon's new-contact limit. The person replies "hi" in the PosturePal thread. |
| `🚫 Photon won't text …` (Target not allowed) | Their iPhone uses a different iMessage handle. Have them open **debug.photon.codes**; if it shows an email, change **Settings → Messages → Send & Receive → Start new conversations from** to their number, or sign them up with what it shows. |
| New person signed up but gets nothing | Restart the server (Ctrl+C, `bun start`) so Photon picks up the new user, then click **Send test nudge**. |
| `⏭ nudge … skipped: cooldown` | Normal. Lower `ALERT_COOLDOWN_MINUTES` in `.env` for testing. |
| Never shows "⚠ slouching" while slouching | Get head and both shoulders in frame, recalibrate while sitting up straight, set Sensitivity to High. |
| Camera won't start | Use `http://localhost:3000`, allow camera in Chrome, and check System Settings → Privacy & Security → Camera → Chrome. |
| Check who's registered on Photon | `photon spectrum users list --project <PROJECT_ID>` |

**Photon free plan limits:** iPhones only (iMessage); about 50 new conversations per line per day; people must be registered users (sign-up does this) and reply once before regular messages flow.

---

## Demo script (2 minutes)

1. "Most posture apps watch you all the time. Ours only runs when you press Start, and video never leaves your laptop." Point to the Privacy panel.
2. A judge signs up with their iPhone and replies "hi". The banner disappears live.
3. Press Start and calibrate.
4. Slouch dramatically. Their phone buzzes with a nudge.
5. They reply `snooze 10`, then `stop`. The camera light turns off on its own and the summary arrives.

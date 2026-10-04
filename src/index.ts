/**
 * PosturePal server (multi-user)
 * - Serves the web app (public/) on http://localhost:3000
 * - Sign-up: saves the user locally AND registers them as a Photon project user
 *   (required on Photon's free/shared plan before the agent can text them)
 * - Receives posture events from the browser (numbers only, never video)
 * - Sends iMessage alerts through Photon Spectrum, per user
 * - Answers each user's iMessage replies: status, snooze, stop, history, help, chat
 */
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import Anthropic from "@anthropic-ai/sdk";
import { mkdir } from "node:fs/promises";

// ---------- Config ----------
const PORT = Number(process.env.PORT ?? 3000);
const PROJECT_ID = process.env.PROJECT_ID ?? "";
const PROJECT_SECRET = process.env.PROJECT_SECRET ?? "";
const PHOTON_CLI = process.env.PHOTON_CLI ?? "photon";
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES ?? 10) * 60_000;
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
const USERS_FILE = "./data/users.json";
const SESSIONS_FILE = "./data/sessions.json";

// ---------- Types ----------
type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string; // E.164
  photonUserId: string | null;
  optedOut: boolean;
  activated?: boolean; // true once they've replied to the agent (Photon requires this)
  createdAt: string;
};
type Stats = { goodSeconds: number; badSeconds: number; awaySeconds: number; alerts: number; issueCounts: Record<string, number> };
type Session = { userId: string; start: string; end: string; minutes: number; goodPct: number; alerts: number; topIssue: string | null };
type LiveState = { active: boolean; sessionStart: number; stats: Stats; snoozedUntil: number; lastAlertAt: number; stopRequested: boolean };

const emptyStats = (): Stats => ({ goodSeconds: 0, badSeconds: 0, awaySeconds: 0, alerts: 0, issueCounts: {} });
const newLive = (): LiveState => ({ active: false, sessionStart: 0, stats: emptyStats(), snoozedUntil: 0, lastAlertAt: 0, stopRequested: false });

// ---------- Storage (local JSON files) ----------
async function readJson<T>(path: string, fallback: T): Promise<T> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as T) : fallback;
}
async function writeJson(path: string, data: unknown) {
  await mkdir("./data", { recursive: true });
  await Bun.write(path, JSON.stringify(data, null, 2));
}

let users: User[] = await readJson<User[]>(USERS_FILE, []);
const saveUsers = () => writeJson(USERS_FILE, users);
const live = new Map<string, LiveState>();
const getLive = (userId: string) => live.get(userId) ?? live.set(userId, newLive()).get(userId)!;

async function loadSessions(userId: string): Promise<Session[]> {
  return (await readJson<Session[]>(SESSIONS_FILE, [])).filter((s) => s.userId === userId);
}
async function saveSession(s: Session) {
  const all = await readJson<Session[]>(SESSIONS_FILE, []);
  all.push(s);
  await writeJson(SESSIONS_FILE, all.slice(-1000));
}

// ---------- Helpers ----------
const digits = (s = "") => s.replace(/\D/g, "");
function toE164(raw: string): string | null {
  const d = digits(raw);
  if (raw.trim().startsWith("+") && d.length >= 8 && d.length <= 15) return "+" + d;
  if (d.length === 10) return "+1" + d; // assume US/Canada
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
const findUserByAddress = (address?: string) => {
  if (!address) return undefined;
  if (address.includes("@")) return users.find((u) => u.email.toLowerCase() === address.toLowerCase());
  return users.find((u) => digits(u.phone).slice(-10) === digits(address).slice(-10));
};
const goodPct = (s: Stats) => {
  const total = s.goodSeconds + s.badSeconds;
  return total === 0 ? 100 : Math.round((s.goodSeconds / total) * 100);
};
const topIssue = (s: Stats) => Object.entries(s.issueCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const minutesSince = (t: number) => Math.round((Date.now() - t) / 60_000);
const publicUser = (u: User) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, phone: u.phone, optedOut: u.optedOut, activated: !!u.activated });

// ---------- Photon: register a user on the project ----------
// Uses the official Photon CLI (`bun add -g @photon-ai/cli`, then `photon login`).
async function addPhotonUser(u: { firstName: string; lastName: string; email: string; phone: string }) {
  if (!PROJECT_ID) return { ok: false as const, error: "PROJECT_ID missing in .env" };
  try {
    const proc = Bun.spawn(
      [PHOTON_CLI, "spectrum", "users", "add",
        "--first-name", u.firstName, "--last-name", u.lastName,
        "--email", u.email, "--phone", u.phone,
        "--project", PROJECT_ID, "--json"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, PHOTON_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 0) {
      let id: string | null = null;
      try { id = JSON.parse(out).id ?? null; } catch {}
      return { ok: true as const, photonUserId: id };
    }
    const msg = (err || out).trim();
    // Already registered on Photon (e.g. you added them in the dashboard) → fine
    if (/already|exists|duplicate/i.test(msg)) return { ok: true as const, photonUserId: null };
    return { ok: false as const, error: msg || `photon CLI exited with code ${code}` };
  } catch (e) {
    return { ok: false as const, error: `Could not run the Photon CLI ("${PHOTON_CLI}"). Install it with: bun add -g @photon-ai/cli` };
  }
}

// ---------- Claude (optional) ----------
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const persona = (name: string) =>
  `You are PosturePal, a warm, upbeat posture coach texting ${name} over iMessage. ` +
  "Keep every message under 25 words, casual, at most one emoji. Never lecture. Never mention cameras or video.";

async function ai(name: string, prompt: string, fallback: string, history: Anthropic.MessageParam[] = []) {
  if (!anthropic) return fallback;
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: persona(name),
      messages: [...history, { role: "user", content: prompt }],
    });
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : fallback;
  } catch (err) {
    console.error("Claude error:", err);
    return fallback;
  }
}

const FALLBACK_NUDGES: Record<string, string[]> = {
  slouching: ["Shoulders back, chin up! 🌱", "Quick check: sit tall like you did at calibration.", "Little slump detected. Reset that spine!"],
  "head forward": ["Tuck that chin back. Your neck will thank you.", "Head's drifting toward the screen. Pull it back 👀"],
  "leaning in": ["You're leaning toward the screen. Scoot back a bit!", "Too close to the screen. Sit back into your chair."],
  tilted: ["You're leaning to one side. Even out those shoulders.", "Tilt alert! Center yourself."],
};
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

// ---------- Photon Spectrum (iMessage) ----------
async function connectSpectrum() {
  const app = await Spectrum({ projectId: PROJECT_ID, projectSecret: PROJECT_SECRET, providers: [imessage.config()] });
  return { app, im: imessage(app) };
}
type Conn = Awaited<ReturnType<typeof connectSpectrum>>;
type Space = Awaited<ReturnType<Conn["im"]["space"]["create"]>>;

let conn: Conn | null = null;
if (PROJECT_ID && PROJECT_SECRET) {
  try {
    conn = await connectSpectrum();
    console.log("✅ Connected to Photon Spectrum (iMessage)");
  } catch (err) {
    console.error("❌ Could not connect to Photon. Check PROJECT_ID / PROJECT_SECRET. Messages will print here instead.\n", err);
  }
} else {
  console.warn("⚠ PROJECT_ID / PROJECT_SECRET missing: messages will print in this terminal instead of iMessage.");
}

const spaces = new Map<string, Space>(); // userId → DM space

type SendResult = { ok: true } | { ok: false; reason: string };

async function sendTo(user: User, msg: string, { force = false } = {}): Promise<SendResult> {
  if (user.optedOut && !force) return { ok: false, reason: "unsubscribed" };
  if (!conn) {
    console.log(`📱 (terminal mode) to ${user.firstName}:`, msg);
    return { ok: true };
  }
  try {
    let space = spaces.get(user.id);
    if (!space) {
      const target = await conn.im.user(user.phone);
      space = await conn.im.space.create(target);
      spaces.set(user.id, space);
    }
    await space.send(msg);
    console.log(`📱 to ${user.firstName}:`, msg);
    return { ok: true };
  } catch (err) {
    const text = String((err as Error)?.message ?? err);
    if (/new contact|until they respond|RESOURCE_EXHAUSTED/i.test(text)) {
      console.warn(`🔒 ${user.firstName} must reply to PosturePal's text before more messages can be sent (Photon limit).`);
      if (user.activated) { user.activated = false; await saveUsers(); }
      return { ok: false, reason: "needs-reply" };
    }
    if (/target not allowed/i.test(text)) {
      console.warn(`🚫 Photon won't text ${user.firstName} (${user.phone}): not an allowed user. Check the Users tab / debug.photon.codes.`);
      return { ok: false, reason: "not-allowed" };
    }
    console.error(`Failed to text ${user.firstName} (${user.phone}): ${text}`);
    spaces.delete(user.id); // rebuild the conversation next time
    return { ok: false, reason: "error" };
  }
}

// Per-user chat memory for free-form questions
const chats = new Map<string, Anthropic.MessageParam[]>();

async function handleText(user: User, raw: string): Promise<string> {
  const t = raw.trim().toLowerCase();
  const st = getLive(user.id);

  if (t === "unsubscribe") {
    user.optedOut = true;
    await saveUsers();
    return "You're unsubscribed. No more texts from PosturePal. Text 'subscribe' to come back.";
  }
  if (t === "subscribe") {
    user.optedOut = false;
    await saveUsers();
    return `Welcome back, ${user.firstName}! 🌱`;
  }
  if (t === "help" || t === "?") {
    return "Commands: status · snooze 15 · resume · stop · history · unsubscribe. Or ask me anything about posture!";
  }
  if (/^start\b/.test(t)) return "For privacy, tracking can only be turned on from your computer. Hit Start there!";
  if (/^(stop|end|off)\b/.test(t)) {
    if (!st.active) return "Tracking is already off. 👍";
    st.stopRequested = true; // browser sees this on its next heartbeat and turns the camera off
    return "Stopping now. Your camera will turn off within a few seconds.";
  }
  const snooze = t.match(/^snooze\s*(\d+)?/);
  if (snooze) {
    const mins = Number(snooze[1] ?? 30);
    st.snoozedUntil = Date.now() + mins * 60_000;
    return `Snoozed for ${mins} min. I'll stay quiet. 🤫`;
  }
  if (t === "resume" || t === "unsnooze") {
    st.snoozedUntil = 0;
    return "Alerts back on!";
  }
  if (/^(status|how am i doing)/.test(t)) {
    if (!st.active) return "Not tracking right now. Start a session on your computer.";
    return `${minutesSince(st.sessionStart)} min in, upright ${goodPct(st.stats)}% of the time, ${st.stats.alerts} nudge(s) so far.`;
  }
  if (t === "history") {
    const h = (await loadSessions(user.id)).slice(-5);
    if (!h.length) return "No sessions yet!";
    return h.map((s) => `${s.start.slice(0, 10)}: ${s.minutes} min, ${s.goodPct}% upright`).join("\n");
  }

  const history = (await loadSessions(user.id)).slice(-5);
  const chat = chats.get(user.id) ?? [];
  const answer = await ai(
    user.firstName,
    `Context: tracking=${st.active}, current good%=${goodPct(st.stats)}, recent sessions=${JSON.stringify(history)}. User says: "${raw}"`,
    "I'm here to help with posture! Text 'help' to see what I can do.",
    chat,
  );
  chat.push({ role: "user", content: raw }, { role: "assistant", content: answer });
  chats.set(user.id, chat.slice(-20));
  return answer;
}

// Listen for incoming iMessages
(async () => {
  if (!conn) return;
  for await (const [space, message] of conn.app.messages) {
    if (message.platform !== "imessage") continue;
    const sender = imessage(message).sender;
    console.log("📩 incoming", message.content.type, "from", sender?.address);
    if (message.content.type !== "text") continue;

    const user = findUserByAddress(sender?.address);
    const text = message.content.text;
    await space.responding(async () => {
      if (!user) {
        await space.send("Hi! I don't recognize this number yet. Sign up on the PosturePal website first. 🌱");
        return;
      }
      spaces.set(user.id, space as Space);
      if (!user.activated) {
        user.activated = true;
        await saveUsers();
        console.log(`✅ ${user.firstName} replied, nudges activated`);
        if (/^(hi|hey|hello|yes|y|start|ok|okay)\b/i.test(text.trim())) {
          await space.send(`You're all set, ${user.firstName}! ✅ Head back to your computer and press Start.`);
          return;
        }
      }
      await space.send(await handleText(user, text));
    });
  }
})().catch((err) => console.error("Message loop crashed:", err));

// ---------- HTTP server (localhost only) ----------
const STATIC: Record<string, string> = {
  "/": "docs/index.html",
  "/index.html": "docs/index.html",
  "/app.js": "docs/app.js",
  "/style.css": "docs/style.css",
  "/config.js": "docs/config.js",
};
const json = (data: unknown, status = 200) => Response.json(data, { status });

// Which websites may call this server (your GitHub Pages site + localhost).
// ALLOWED_ORIGINS=https://yourname.github.io  (comma-separated). Empty = allow any.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const ok =
    ALLOWED_ORIGINS.length === 0 ||
    ALLOWED_ORIGINS.includes(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Simple guard against sign-up spam now that the site is public
const SIGNUPS_PER_HOUR = Number(process.env.SIGNUPS_PER_HOUR ?? 30);
let signupTimes: number[] = [];
const mergeStats = (st: LiveState, incoming?: Partial<Stats>) => {
  if (incoming) st.stats = { ...st.stats, ...incoming, alerts: st.stats.alerts };
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // the Cloudflare Tunnel connects locally; nothing else on your network can reach it
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    const res = await handle(req);
    for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
    return res;
  },
});

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && STATIC[url.pathname]) return new Response(Bun.file(STATIC[url.pathname]));
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    const body = (await req.json().catch(() => ({}))) as any;

    // ----- Sign up (or sign back in with the same phone) -----
    if (url.pathname === "/api/signup") {
      const firstName = String(body.firstName ?? "").trim();
      const lastName = String(body.lastName ?? "").trim();
      const email = String(body.email ?? "").trim().toLowerCase();
      const phone = toE164(String(body.phone ?? ""));
      if (!firstName || !lastName) return json({ error: "Please enter your first and last name." }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email." }, 400);
      if (!phone) return json({ error: "Please enter a valid phone number (e.g. +1 765 555 1234)." }, 400);
      if (!body.consent) return json({ error: "Please agree to receive iMessages from PosturePal." }, 400);

      const existing = users.find((u) => u.phone === phone);
      if (existing) return json({ user: publicUser(existing), returning: true });

      const hourAgo = Date.now() - 3_600_000;
      signupTimes = signupTimes.filter((t) => t > hourAgo);
      if (signupTimes.length >= SIGNUPS_PER_HOUR) return json({ error: "Too many sign-ups right now. Try again later." }, 429);
      signupTimes.push(Date.now());

      const photon = await addPhotonUser({ firstName, lastName, email, phone });
      if (!photon.ok) {
        console.error("Photon user add failed:", photon.error);
        return json({ error: "Couldn't register your number with Photon: " + photon.error }, 502);
      }

      const user: User = {
        id: crypto.randomUUID(),
        firstName, lastName, email, phone,
        photonUserId: photon.photonUserId,
        optedOut: false,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await saveUsers();
      console.log(`👤 New user: ${firstName} ${lastName} (${phone})`);

      await sendTo(user,
        `Hi ${firstName}! 👋 I'm PosturePal. Reply "hi" to activate posture nudges. ` +
        `(Reply 'unsubscribe' anytime to stop texts.)`);
      return json({ user: publicUser(user), returning: false });
    }

    // ----- Everything below needs a signed-up user -----
    const user = users.find((u) => u.id === body.userId);
    if (!user) return json({ error: "unknown user" }, 401);
    const st = getLive(user.id);

    switch (url.pathname) {
      case "/api/me":
        return json({ user: publicUser(user) });

      case "/api/session/start": {
        Object.assign(st, { active: true, sessionStart: Date.now(), stats: emptyStats(), stopRequested: false, lastAlertAt: 0 });
        if (user.activated) await sendTo(user, `PosturePal is on, ${user.firstName}. I'll text you if you slouch. Reply 'help' for options.`);
        return json({ ok: true, activated: !!user.activated });
      }

      case "/api/heartbeat":
        mergeStats(st, body.stats);
        return json({ stop: st.stopRequested, snoozedUntil: st.snoozedUntil });

      case "/api/alert": {
        const issue: string = body.issue ?? "slouching";
        const now = Date.now();
        const skip = (reason: string) => {
          console.log(`⏭  nudge for ${user.firstName} (${issue}) skipped: ${reason}`);
          return json({ sent: false, reason });
        };
        if (body.test) {
          const r = await sendTo(user, `🔔 Test nudge for ${user.firstName}: if you can read this, alerts work!`);
          return json(r.ok ? { sent: true, test: true } : { sent: false, reason: r.reason });
        }
        if (!user.activated) return skip("needs-reply");
        if (!st.active) return skip("tracking isn't on (press Start)");
        if (now < st.snoozedUntil) return skip(`snoozed for ${Math.ceil((st.snoozedUntil - now) / 60_000)} more min`);
        if (now - st.lastAlertAt < COOLDOWN_MS)
          return skip(`cooldown, next nudge allowed in ${Math.ceil((COOLDOWN_MS - (now - st.lastAlertAt)) / 60_000)} min`);
        console.log(`⚠  ${user.firstName}: ${issue} for ${body.seconds}s → sending nudge`);
        st.lastAlertAt = now;
        st.stats.alerts++;
        const msg = await ai(
          user.firstName,
          `Write one posture nudge. Problem: ${issue} for ${body.seconds ?? 30} seconds. ` +
            `This is nudge #${st.stats.alerts} this session; vary the wording. Upright so far: ${goodPct(st.stats)}%.`,
          pick(FALLBACK_NUDGES[issue] ?? FALLBACK_NUDGES.slouching),
        );
        const sent = await sendTo(user, msg);
        if (!sent.ok) return json({ sent: false, reason: sent.reason });
        return json({ sent: true, message: msg });
      }

      case "/api/session/stop": {
        if (!st.active) return json({ ok: true });
        mergeStats(st, body.stats);
        st.active = false;
        st.stopRequested = false;
        const s = st.stats;
        const session: Session = {
          userId: user.id,
          start: new Date(st.sessionStart).toISOString(),
          end: new Date().toISOString(),
          minutes: minutesSince(st.sessionStart),
          goodPct: goodPct(s),
          alerts: s.alerts,
          topIssue: topIssue(s),
        };
        const previous = (await loadSessions(user.id)).at(-1);
        await saveSession(session);
        const summary = await ai(
          user.firstName,
          `Write an end-of-session summary (max 40 words). Session: ${JSON.stringify(session)}. ` +
            `Previous session: ${JSON.stringify(previous ?? null)}. Compare if possible and give one tip.`,
          `Session done: ${session.minutes} min, ${session.goodPct}% upright, ${session.alerts} nudge(s). Nice work! 💪`,
        );
        await sendTo(user, summary);
        return json({ ok: true, session });
      }
    }
    return new Response("Not found", { status: 404 });
}

console.log(`✅ PosturePal running at http://localhost:${PORT}  (${users.length} user(s) signed up)`);

const shutdown = async () => {
  await conn?.app.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { Telegraf } from "telegraf";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { parseAndValidateInitData } from "./auth.js";
import * as db from "./db.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const WEB_APP_URL = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3001);
const NODE_ENV = process.env.NODE_ENV ?? "development";
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n)),
);

function assertAllowed(userId: number) {
  if (ALLOWED.size === 0) {
    console.warn("TELEGRAM_ALLOWED_IDS пуст — доступ к API закрыт.");
    throw new Error("forbidden");
  }
  if (!ALLOWED.has(userId)) throw new Error("forbidden");
}

function authUser(req: express.Request): number {
  if (NODE_ENV === "development") {
    const dev = req.headers["x-dev-user-id"];
    if (typeof dev === "string" && ALLOWED.has(Number(dev))) return Number(dev);
  }
  const h = req.headers.authorization;
  if (!h?.startsWith("tma ")) throw new Error("unauthorized");
  const initData = h.slice(4);
  const v = parseAndValidateInitData(initData, BOT_TOKEN);
  if (!v) throw new Error("unauthorized");
  assertAllowed(v.userId);
  return v.userId;
}

function mondayISO(d: Date): string {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

const app = express();
app.use(
  cors({
    origin: NODE_ENV === "development" ? true : undefined,
    credentials: true,
  }),
);
app.use(express.json({ limit: "512kb" }));

const distDir = path.join(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/week", (req, res) => {
  try {
    authUser(req);
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  const mon = typeof req.query.monday === "string" ? req.query.monday : mondayISO(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) return res.status(400).json({ error: "bad_monday" });
  const events = db.listEventsForWeek(mon);
  return res.json({ monday: mon, events });
});

app.post("/api/events", (req, res) => {
  let userId: number;
  try {
    userId = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const b = req.body as {
    week_monday?: string;
    day_index?: number;
    start_minutes?: number;
    duration_minutes?: number;
    title?: string;
    remind_at?: string | null;
  };
  if (!b.week_monday || !/^\d{4}-\d{2}-\d{2}$/.test(b.week_monday))
    return res.status(400).json({ error: "week_monday" });
  if (typeof b.day_index !== "number" || b.day_index < 0 || b.day_index > 6)
    return res.status(400).json({ error: "day_index" });
  if (typeof b.start_minutes !== "number" || b.start_minutes < 0 || b.start_minutes >= 24 * 60)
    return res.status(400).json({ error: "start_minutes" });
  if (typeof b.duration_minutes !== "number" || b.duration_minutes < 15 || b.duration_minutes > 24 * 60)
    return res.status(400).json({ error: "duration_minutes" });
  if (typeof b.title !== "string" || !b.title.trim()) return res.status(400).json({ error: "title" });
  const id = randomUUID();
  db.insertEvent({
    id,
    week_monday: b.week_monday,
    day_index: b.day_index,
    start_minutes: b.start_minutes,
    duration_minutes: b.duration_minutes,
    title: b.title.trim().slice(0, 500),
    owner_tg_id: userId,
    remind_at: b.remind_at && b.remind_at.length > 0 ? b.remind_at : null,
  });
  return res.json({ id });
});

app.patch("/api/events/:id", (req, res) => {
  let userId: number;
  try {
    userId = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const id = req.params.id;
  const exists = db.getDb().prepare(`SELECT 1 FROM events WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: "not_found" });

  const b = req.body as Partial<{
    day_index: number;
    start_minutes: number;
    duration_minutes: number;
    title: string;
    remind_at: string | null;
  }>;
  const patch: Parameters<typeof db.updateEvent>[1] = {};
  if (typeof b.day_index === "number" && b.day_index >= 0 && b.day_index <= 6) patch.day_index = b.day_index;
  if (typeof b.start_minutes === "number" && b.start_minutes >= 0 && b.start_minutes < 24 * 60)
    patch.start_minutes = b.start_minutes;
  if (typeof b.duration_minutes === "number" && b.duration_minutes >= 15 && b.duration_minutes <= 24 * 60)
    patch.duration_minutes = b.duration_minutes;
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 500);
  if ("remind_at" in b) patch.remind_at = b.remind_at && String(b.remind_at).length ? String(b.remind_at) : null;
  if (patch.remind_at !== undefined) patch.reminder_sent = 0;

  db.updateEvent(id, patch);
  return res.json({ ok: true });
});

app.delete("/api/events/:id", (req, res) => {
  let userId: number;
  try {
    userId = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const id = req.params.id;
  const exists = db.getDb().prepare(`SELECT 1 FROM events WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: "not_found" });
  db.deleteEvent(id);
  return res.json({ ok: true });
});

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api")) return next();
  const index = path.join(distDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(path.resolve(index));
  next();
});

async function sendReminders(bot: Telegraf) {
  const now = new Date().toISOString();
  const rows = db.dueReminders(now);
  for (const ev of rows) {
    const when = `${String(Math.floor(ev.start_minutes / 60)).padStart(2, "0")}:${String(ev.start_minutes % 60).padStart(2, "0")}`;
    const text = `Напоминание: «${ev.title}» (${when}, день ${ev.day_index + 1})`;
    for (const uid of ALLOWED) {
      try {
        await bot.telegram.sendMessage(uid, text);
      } catch (e) {
        console.error("sendMessage", uid, e);
      }
    }
    db.updateEvent(ev.id, { reminder_sent: 1 });
  }
}

async function main() {
  db.getDb();

  if (!BOT_TOKEN) {
    console.error("Укажи BOT_TOKEN в .env");
    process.exit(1);
  }

  const bot = new Telegraf(BOT_TOKEN);

  bot.command("myid", async (ctx) => {
    const id = ctx.from?.id;
    if (!id) return;
    await ctx.reply(
      `Твой Telegram ID (только цифры): ${id}\n\nЕго нужно вписать в TELEGRAM_ALLOWED_IDS на сервере. Номер телефона или @ник сюда не подходят — пусть жена тоже напишет боту /myid со своего Telegram.`,
    );
  });

  bot.start(async (ctx) => {
    const id = ctx.from?.id;
    if (id && ALLOWED.size && !ALLOWED.has(id)) {
      await ctx.reply("Этот бот только для семьи. Добавь свой Telegram ID в TELEGRAM_ALLOWED_IDS на сервере.");
      return;
    }
    if (WEB_APP_URL) {
      await ctx.reply("План недели — открой мини-приложение:", {
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть план недели", web_app: { url: WEB_APP_URL } }]],
        },
      });
    } else {
      await ctx.reply(
        "Задай на сервере переменную WEB_APP_URL — публичный https-адрес, где открывается это приложение (Mini App).",
      );
    }
  });

  const webhookPath = process.env.WEBHOOK_PATH || "/telegram/webhook";
  const webhookBase = (process.env.WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");

  if (webhookBase) {
    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(`${webhookBase}${webhookPath}`);
    console.log("Webhook:", `${webhookBase}${webhookPath}`);
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    void bot.launch().then(() => console.log("Бот: long polling"));
  }

  cron.schedule("* * * * *", () => {
    void sendReminders(bot);
  });

  app.listen(PORT, () => {
    console.log(`API + статика: http://localhost:${PORT}`);
    if (NODE_ENV === "development") {
      console.log("Dev: Vite на :5173, прокси /api → этот сервер. x-dev-user-id для браузера.");
    }
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { Telegraf, type Context } from "telegraf";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { parseAndValidateInitData } from "./auth.js";
import * as db from "./db.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const WEB_APP_URL = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
const PORT_RAW = Number(process.env.PORT);
const PORT = Number.isInteger(PORT_RAW) && PORT_RAW > 0 && PORT_RAW <= 65535 ? PORT_RAW : 3001;
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n)),
);

/** Для отправки сообщений из HTTP (новое дело и т.д.). */
let botForNotify: Telegraf | null = null;

async function notifyOthersInFamily(creatorId: number, text: string) {
  if (!botForNotify || ALLOWED.size < 2) return;
  for (const uid of ALLOWED) {
    if (uid === creatorId) continue;
    try {
      await botForNotify.telegram.sendMessage(uid, text);
    } catch (e) {
      console.error("Уведомление не дошло до", uid, e);
    }
  }
}

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
  const titleTrim = b.title.trim().slice(0, 500);
  const id = randomUUID();
  db.insertEvent({
    id,
    week_monday: b.week_monday,
    day_index: b.day_index,
    start_minutes: b.start_minutes,
    duration_minutes: b.duration_minutes,
    title: titleTrim,
    owner_tg_id: userId,
    remind_at: b.remind_at && b.remind_at.length > 0 ? b.remind_at : null,
  });
  const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const hh = String(Math.floor(b.start_minutes / 60)).padStart(2, "0");
  const mm = String(b.start_minutes % 60).padStart(2, "0");
  const msg = `Новое дело в общем плане:\n«${titleTrim}»\n${WD[b.day_index]}, ${hh}:${mm}`;
  void notifyOthersInFamily(userId, msg);
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
  if (!db.eventExists(id)) return res.status(404).json({ error: "not_found" });

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
  if (!db.eventExists(id)) return res.status(404).json({ error: "not_found" });
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
  db.initStore();

  let bot: Telegraf | null = null;
  if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    botForNotify = bot;

    bot.catch((err, ctx) => {
      console.error("Ошибка в боте:", err);
      void ctx?.reply("Внутренняя ошибка. Посмотри логи на сервере.").catch(() => {});
    });

    const replyMyId = async (ctx: Context) => {
      const id = ctx.from?.id;
      if (!id) return;
      await ctx.reply(
        `Твой Telegram ID (только цифры): ${id}\n\nВпиши его в TELEGRAM_ALLOWED_IDS в файле .env на ПК (два id через запятую). Жена пусть тоже напишет этому боту /myid.`,
      );
    };

    bot.command("myid", replyMyId);

    bot.start(async (ctx) => {
      const id = ctx.from?.id;
      if (id && ALLOWED.size && !ALLOWED.has(id)) {
        await ctx.reply("Этот бот только для семьи. Добавь свой Telegram ID в TELEGRAM_ALLOWED_IDS на сервере.");
        return;
      }
      if (WEB_APP_URL) {
        await ctx.reply("План недели — открой мини-приложение:", {
          reply_markup: {
            inline_keyboard: [[{ text: "Открыть планер", web_app: { url: WEB_APP_URL } }]],
          },
        });
      } else {
        await ctx.reply(
          "Задай на сервере переменную WEB_APP_URL — публичный https-адрес, где открывается это приложение (Mini App).",
        );
      }
    });
  } else {
    botForNotify = null;
    console.error(
      "BOT_TOKEN не задан. На Railway: Variables → BOT_TOKEN → Redeploy. Пока бот не работает, сайт может открываться.",
    );
  }

  const webhookPath = process.env.WEBHOOK_PATH || "/telegram/webhook";
  const webhookBase = (process.env.WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");

  cron.schedule("* * * * *", () => {
    if (bot) void sendReminders(bot);
  });

  // Сначала HTTP — иначе при ошибке Telegram порт не откроется.
  app.listen(PORT, HOST, () => {
    console.log(`API + статика: http://${HOST}:${PORT}`);
    if (NODE_ENV === "development") {
      console.log("Dev: Vite на :5173, прокси /api → этот сервер. x-dev-user-id для браузера.");
    }
  });

  if (!bot) {
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
    return;
  }

  if (webhookBase) {
    console.warn(
      "В .env задан WEBHOOK_BASE_URL — Telegram шлёт сообщения туда, а не на твой ПК. Для проверки дома убери WEBHOOK_BASE_URL и перезапусти.",
    );
    app.use(bot.webhookCallback(webhookPath));
    try {
      await bot.telegram.setWebhook(`${webhookBase}${webhookPath}`);
      console.log("Webhook:", `${webhookBase}${webhookPath}`);
    } catch (e) {
      console.error("setWebhook не удался:", e);
    }
  } else {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {
      console.error("deleteWebhook не удался (проверь BOT_TOKEN):", e);
    }
    void bot
      .launch()
      .then(() =>
        console.log("Бот на связи. В Telegram открой СВОЕГО бота (не @BotFather) и напиши /myid"),
      )
      .catch((e) => console.error("Бот не подключился к Telegram (интернет/токен):", e));
  }

  process.once("SIGINT", () => bot!.stop("SIGINT"));
  process.once("SIGTERM", () => bot!.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

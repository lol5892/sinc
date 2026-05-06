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

type AuthUser = { id: number; name: string };

function displayUserName(user: { id: number; first_name?: string; last_name?: string; username?: string }): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || (user.username ? `@${user.username}` : `Пользователь ${user.id}`);
}

function phoneForUserName(name: string): string {
  const normalized = name.toLocaleLowerCase("ru-RU");
  if (normalized.includes("татьян") || normalized.includes("tatiana") || normalized.includes("tatyana")) {
    return "8901-485-6774";
  }
  return "8960-008-48-43";
}

/** Нормализованный номер для сущности phone_number (как в обычной переписке Telegram). */
function normalizePhoneForEntity(display: string): string {
  const digits = display.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return display.trim() || "+";
}

/** Клавиатура подтверждения (без URL-кнопок, чтобы Telegram не отклонял сообщение). */
function confirmationKeyboard(eventId: string) {
  return {
    inline_keyboard: [
      [{ text: "Подтвердить", callback_data: `confirm:${eventId}` }],
      [{ text: "Отказаться", callback_data: `decline:${eventId}` }],
    ],
  };
}

function acceptDoneKeyboard(eventId: string) {
  return {
    inline_keyboard: [[{ text: "Принять", callback_data: `accept_done:${eventId}` }]],
  };
}

type MsgRef = { chat_id: number; message_id: number };

function parseMessageRefs(raw: string | null | undefined): MsgRef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ chat_id?: number; message_id?: number }>;
    const out: MsgRef[] = [];
    for (const x of arr) {
      const chatId = Number(x.chat_id);
      const msgId = Number(x.message_id);
      if (Number.isFinite(chatId) && Number.isFinite(msgId)) out.push({ chat_id: chatId, message_id: msgId });
    }
    return out;
  } catch {
    return [];
  }
}

async function deleteMessageRefs(refs: MsgRef[]) {
  if (!botForNotify) return { ok: 0, failed: 0 };
  let ok = 0;
  let failed = 0;
  for (const ref of refs) {
    try {
      await botForNotify.telegram.deleteMessage(ref.chat_id, ref.message_id);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

/** Оставляем в чате только сообщения по подтверждённым и существующим делам. */
async function cleanupBotMessagesToConfirmedOnly() {
  const events = await db.listAllEvents();
  let deleted = 0;
  let failed = 0;
  let touchedEvents = 0;
  for (const ev of events) {
    const refs = parseMessageRefs(ev.confirmation_messages_json);
    if (!refs.length) continue;
    const shouldKeep = Boolean(ev.confirmed_at);
    if (shouldKeep) continue;
    const r = await deleteMessageRefs(refs);
    deleted += r.ok;
    failed += r.failed;
    touchedEvents += 1;
    await db.updateEvent(ev.id, {
      confirmation_message_chat_id: null,
      confirmation_message_id: null,
      confirmation_messages_json: null,
    });
  }
  return { deleted, failed, touchedEvents };
}

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

async function requestConfirmationFromOthers(creator: AuthUser, eventId: string, title: string, when: string) {
  if (!botForNotify || ALLOWED.size < 2) return;
  const event = await db.getEvent(eventId);
  if (!event) return;
  const comment = event.comment?.trim() ? event.comment.trim() : "без комментария";
  const phone = phoneForUserName(event.owner_name);
  const text =
    `Нужно подтверждение дела:\n` +
    `Название: ${title}\n` +
    `Время: ${when}\n` +
    `Комментарий: ${comment}\n` +
    `Добавил: ${creator.name}\n\n` +
    `Если есть вопросы — позвоните и обсудите дело:\n${phone}`;
  const delivered: { chat_id: number; message_id: number }[] = [];
  for (const uid of ALLOWED) {
    if (uid === creator.id) continue;
    try {
      const message = await botForNotify.telegram.sendMessage(uid, text, {
        reply_markup: confirmationKeyboard(eventId),
      });
      delivered.push({ chat_id: message.chat.id, message_id: message.message_id });
      await db.updateEvent(eventId, {
        confirmation_message_chat_id: message.chat.id,
        confirmation_message_id: message.message_id,
      });
    } catch (e) {
      console.error("Запрос подтверждения не дошёл до", uid, e);
    }
  }
  if (delivered.length > 0) {
    await db.updateEvent(eventId, {
      confirmation_messages_json: JSON.stringify(delivered),
    });
  }
}

function completionText(event: Awaited<ReturnType<typeof db.getEvent>>, requesterName: string): string {
  if (!event) return "Дело не найдено";
  const hh = String(Math.floor(event.start_minutes / 60)).padStart(2, "0");
  const mm = String(event.start_minutes % 60).padStart(2, "0");
  const doneAt = new Date().toLocaleString("ru-RU");
  return (
    `Отметка о выполнении дела:\n` +
    `Название: ${event.title}\n` +
    `Время: ${hh}:${mm}\n` +
    `Комментарий: ${event.comment?.trim() || "без комментария"}\n` +
    `Исполнитель: ${requesterName}\n` +
    `Отмечено как выполнено: ${doneAt}\n\n` +
    `Если всё ок — нажми «Принять».`
  );
}

function assertAllowed(userId: number) {
  if (ALLOWED.size === 0) {
    console.warn("TELEGRAM_ALLOWED_IDS пуст — доступ к API закрыт.");
    throw new Error("forbidden");
  }
  if (!ALLOWED.has(userId)) throw new Error("forbidden");
}

function authUser(req: express.Request): AuthUser {
  if (NODE_ENV === "development") {
    const dev = req.headers["x-dev-user-id"];
    if (typeof dev === "string" && ALLOWED.has(Number(dev))) {
      const id = Number(dev);
      const devName = req.headers["x-dev-user-name"];
      return {
        id,
        name: typeof devName === "string" && devName.trim() ? devName.trim().slice(0, 120) : `Пользователь ${id}`,
      };
    }
  }
  const h = req.headers.authorization;
  if (!h?.startsWith("tma ")) throw new Error("unauthorized");
  const initData = h.slice(4);
  const v = parseAndValidateInitData(initData, BOT_TOKEN);
  if (!v) throw new Error("unauthorized");
  assertAllowed(v.userId);
  return { id: v.userId, name: displayUserName(v.user) };
}

function mondayISO(d: Date): string {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const MIN_CREATE_LEAD_HOURS = 2;
const MIN_CREATE_LEAD_MS = MIN_CREATE_LEAD_HOURS * 60 * 60 * 1000;

function eventStartAt(weekMonday: string, dayIndex: number, startMinutes: number): Date | null {
  const base = new Date(`${weekMonday}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  if (!Number.isFinite(dayIndex) || !Number.isFinite(startMinutes)) return null;
  base.setDate(base.getDate() + dayIndex);
  base.setMinutes(base.getMinutes() + startMinutes);
  return base;
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

app.get("/api/week", async (req, res) => {
  let user: AuthUser;
  try {
    user = authUser(req);
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  const mon = typeof req.query.monday === "string" ? req.query.monday : mondayISO(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) return res.status(400).json({ error: "bad_monday" });
  const events = (await db.listEventsForWeek(mon)).filter(
    (event) => event.owner_tg_id === user.id || !event.confirmation_required || Boolean(event.confirmed_at),
  );
  return res.json({ monday: mon, events });
});

app.post("/api/events", async (req, res) => {
  let user: AuthUser;
  try {
    user = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const b = req.body as {
    week_monday?: string;
    day_index?: number;
    day_span?: number;
    start_minutes?: number;
    duration_minutes?: number;
    title?: string;
    comment?: string | null;
    confirmation_required?: boolean;
    remind_at?: string | null;
    card_color?: string;
  };
  if (!b.week_monday || !/^\d{4}-\d{2}-\d{2}$/.test(b.week_monday))
    return res.status(400).json({ error: "week_monday" });
  if (typeof b.day_index !== "number" || b.day_index < 0 || b.day_index > 6)
    return res.status(400).json({ error: "day_index" });
  if (typeof b.day_span !== "undefined" && (typeof b.day_span !== "number" || b.day_span < 1 || b.day_span > 7))
    return res.status(400).json({ error: "day_span" });
  if (typeof b.start_minutes !== "number" || b.start_minutes < 0 || b.start_minutes >= 24 * 60)
    return res.status(400).json({ error: "start_minutes" });
  if (typeof b.duration_minutes !== "number" || b.duration_minutes < 15 || b.duration_minutes > 24 * 60)
    return res.status(400).json({ error: "duration_minutes" });
  if (typeof b.title !== "string" || !b.title.trim()) return res.status(400).json({ error: "title" });
  const startAt = eventStartAt(b.week_monday, b.day_index, b.start_minutes);
  if (!startAt) return res.status(400).json({ error: "start_at" });
  const diff = startAt.getTime() - Date.now();
  if (diff < MIN_CREATE_LEAD_MS) {
    return res.status(400).json({
      error: "min_lead_time_10h",
      message: `Дело можно добавить минимум за ${MIN_CREATE_LEAD_HOURS} часов до начала.`,
    });
  }
  const titleTrim = b.title.trim().slice(0, 500);
  const commentTrim = typeof b.comment === "string" ? b.comment.trim().slice(0, 1000) : "";
  const CARD_COLORS = new Set(["slate", "sky", "violet", "rose", "amber", "teal", "coral"]);
  const cardColor =
    typeof b.card_color === "string" && CARD_COLORS.has(b.card_color.trim()) ? b.card_color.trim() : "slate";
  const id = randomUUID();
  await db.insertEvent({
    id,
    week_monday: b.week_monday,
    day_index: b.day_index,
    day_span: Math.min(7 - b.day_index, b.day_span ?? 1),
    start_minutes: b.start_minutes,
    duration_minutes: b.duration_minutes,
    title: titleTrim,
    comment: commentTrim,
    card_color: cardColor,
    confirmation_required: true,
    confirmed_at: null,
    confirmed_by_tg_id: null,
    declined_at: null,
    declined_by_tg_id: null,
    call_clicked_at: null,
    call_clicked_by_tg_id: null,
    confirmation_message_chat_id: null,
    confirmation_message_id: null,
    confirmation_messages_json: null,
    completion_requested_at: null,
    completion_requested_by_tg_id: null,
    completed_at: null,
    completed_by_tg_id: null,
    owner_tg_id: user.id,
    owner_name: user.name,
    remind_at: b.remind_at && b.remind_at.length > 0 ? b.remind_at : null,
  });
  const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const hh = String(Math.floor(b.start_minutes / 60)).padStart(2, "0");
  const mm = String(b.start_minutes % 60).padStart(2, "0");
  // Одно объединённое сообщение: и уведомление о новом деле, и блок подтверждения.
  void requestConfirmationFromOthers(user, id, titleTrim, `${WD[b.day_index]}, ${hh}:${mm}`);
  return res.json({ id });
});

app.patch("/api/events/:id", async (req, res) => {
  let user: AuthUser;
  try {
    user = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const id = req.params.id;
  const event = await db.getEvent(id);
  if (!event) return res.status(404).json({ error: "not_found" });

  const b = req.body as Partial<{
    day_index: number;
    day_span: number;
    start_minutes: number;
    duration_minutes: number;
    title: string;
    comment: string | null;
    confirmation_required: boolean;
    remind_at: string | null;
    card_color: string;
  }>;
  const CARD_COLORS = new Set(["slate", "sky", "violet", "rose", "amber", "teal", "coral"]);
  if (event.owner_tg_id !== user.id) {
    const triesOwnerOnlyChange =
      "title" in b ||
      "comment" in b ||
      "confirmation_required" in b ||
      "remind_at" in b ||
      "card_color" in b ||
      (typeof b.day_span === "number" && b.day_span !== event.day_span) ||
      (typeof b.duration_minutes === "number" && b.duration_minutes !== event.duration_minutes);
    if (triesOwnerOnlyChange) return res.status(403).json({ error: "owner_only" });
  }
  const patch: Parameters<typeof db.updateEvent>[1] = {};
  if (typeof b.day_index === "number" && b.day_index >= 0 && b.day_index <= 6) patch.day_index = b.day_index;
  if (typeof b.day_span === "number" && b.day_span >= 1 && b.day_span <= 7) patch.day_span = b.day_span;
  if (typeof b.start_minutes === "number" && b.start_minutes >= 0 && b.start_minutes < 24 * 60)
    patch.start_minutes = b.start_minutes;
  if (typeof b.duration_minutes === "number" && b.duration_minutes >= 15 && b.duration_minutes <= 24 * 60)
    patch.duration_minutes = b.duration_minutes;
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 500);
  if ("comment" in b) patch.comment = b.comment == null ? "" : String(b.comment).trim().slice(0, 1000);
  if ("confirmation_required" in b) {
    patch.confirmation_required = b.confirmation_required === true;
    if (patch.confirmation_required === false) {
      patch.confirmed_at = null;
      patch.confirmed_by_tg_id = null;
    }
  }
  if ("remind_at" in b) patch.remind_at = b.remind_at && String(b.remind_at).length ? String(b.remind_at) : null;
  if (patch.remind_at !== undefined) patch.reminder_sent = 0;
  if (typeof b.card_color === "string" && CARD_COLORS.has(b.card_color.trim())) patch.card_color = b.card_color.trim();

  // Нельзя переносить дело так, чтобы старт был раньше, чем через MIN_CREATE_LEAD_HOURS от текущего момента.
  const effectiveDay = patch.day_index ?? event.day_index;
  const effectiveStart = patch.start_minutes ?? event.start_minutes;
  const effectiveStartAt = eventStartAt(event.week_monday, effectiveDay, effectiveStart);
  if (!effectiveStartAt) return res.status(400).json({ error: "start_at" });
  const diff = effectiveStartAt.getTime() - Date.now();
  if (diff < MIN_CREATE_LEAD_MS) {
    return res.status(400).json({
      error: "min_lead_time_10h",
      message: `Нельзя перенести дело ближе чем за ${MIN_CREATE_LEAD_HOURS} часов до начала.`,
    });
  }

  await db.updateEvent(id, patch);
  return res.json({ ok: true });
});

app.delete("/api/events/:id", async (req, res) => {
  let user: AuthUser;
  try {
    user = authUser(req);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "forbidden") return res.status(403).json({ error: "forbidden" });
    return res.status(401).json({ error: "unauthorized" });
  }
  const id = req.params.id;
  const event = await db.getEvent(id);
  if (!event) return res.status(404).json({ error: "not_found" });
  if (event.owner_tg_id !== user.id) return res.status(403).json({ error: "owner_only" });

  // Если автор удалил дело, удаляем и сообщения подтверждения у получателей.
  if (botForNotify && event.confirmation_messages_json) {
    const refs = parseMessageRefs(event.confirmation_messages_json);
    await deleteMessageRefs(refs);
  }

  await db.deleteEvent(id);
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
  const rows = await db.dueReminders(now);
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
    await db.updateEvent(ev.id, { reminder_sent: 1 });
  }
}

async function cleanupCompletedTasks() {
  const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const deleted = await db.deleteCompletedOlderThan(cutoff);
    if (deleted > 0) console.log(`Удалено завершённых старше 5 дней: ${deleted}`);
  } catch (e) {
    console.error("Ошибка очистки завершённых дел:", e);
  }
}

function eventEndAt(event: { week_monday: string; day_index: number; start_minutes: number; duration_minutes: number }): Date | null {
  const start = eventStartAt(event.week_monday, event.day_index, event.start_minutes);
  if (!start) return null;
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + event.duration_minutes);
  return end;
}

/** Для забывчивых: после окончания времени дела отправляем автору запрос "Принять". */
async function autoRequestCompletionForOverdueTasks() {
  if (!botForNotify) return;
  try {
    const rows = await db.listAllEvents();
    const now = Date.now();
    for (const ev of rows) {
      if (!ev.confirmed_at) continue;
      if (ev.completed_at) continue;
      if (ev.completion_requested_at) continue;
      const endAt = eventEndAt(ev);
      if (!endAt) continue;
      if (endAt.getTime() > now) continue;
      await db.updateEvent(ev.id, {
        completion_requested_at: endAt.toISOString(),
        completion_requested_by_tg_id: null,
      });
      await botForNotify.telegram
        .sendMessage(
          ev.owner_tg_id,
          `Дело автоматически отмечено как выполненное по времени.\n` +
            `Название: ${ev.title}\n` +
            `Окончание: ${endAt.toLocaleString("ru-RU")}\n\n` +
            `Если всё ок — нажми «Принять».`,
          { reply_markup: acceptDoneKeyboard(ev.id) },
        )
        .catch((e) => console.error("Не удалось отправить авто-запрос принятия:", e));
    }
  } catch (e) {
    console.error("Ошибка авто-запроса завершения:", e);
  }
}

async function saveDailyBackupIfNeeded() {
  try {
    const created = await db.saveDailyBackup(todayISO());
    if (created) {
      console.log("Ежедневный backup дел сохранён.");
    }
  } catch (e) {
    console.error("Не удалось сохранить daily backup:", e);
  }
}

async function main() {
  await db.initStore();

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

    bot.command("cleanup", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || (ALLOWED.size && !ALLOWED.has(userId))) {
        await ctx.reply("Нет доступа.");
        return;
      }
      const r = await cleanupBotMessagesToConfirmedOnly();
      await ctx.reply(
        `Чистка завершена.\nУдалено сообщений: ${r.deleted}\nОшибок удаления: ${r.failed}\nПроверено дел: ${r.touchedEvents}`,
      );
    });

    bot.action(/^confirm:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || (ALLOWED.size && !ALLOWED.has(userId))) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }
      const eventId = ctx.match[1];
      const event = await db.getEvent(eventId);
      if (!event) {
        await ctx.answerCbQuery("Дело не найдено").catch(() => {});
        return;
      }
      await db.updateEvent(eventId, {
        confirmation_required: true,
        confirmed_at: new Date().toISOString(),
        confirmed_by_tg_id: userId,
      });
      await ctx.answerCbQuery("Подтверждено").catch(() => {});
      const text = `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ""}\n\n✅ Подтверждено`;
      await ctx.editMessageText(text).catch(() => {});
    });

    bot.action(/^decline:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || (ALLOWED.size && !ALLOWED.has(userId))) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }
      const eventId = ctx.match[1];
      const event = await db.getEvent(eventId);
      if (!event) {
        await ctx.answerCbQuery("Дело не найдено").catch(() => {});
        return;
      }
      await db.deleteEvent(eventId);
      await ctx.answerCbQuery("Отказано").catch(() => {});
      const text = `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ""}\n\n❌ Отказано и удалено`;
      await ctx.editMessageText(text).catch(() => {});
    });

    bot.action(/^done:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || (ALLOWED.size && !ALLOWED.has(userId))) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }
      const eventId = ctx.match[1];
      const event = await db.getEvent(eventId);
      if (!event) {
        await ctx.answerCbQuery("Дело не найдено").catch(() => {});
        return;
      }
      if (!event.confirmed_at) {
        await ctx.answerCbQuery("Сначала подтвердите дело").catch(() => {});
        return;
      }
      if (event.owner_tg_id === userId) {
        await ctx.answerCbQuery("Отметку делает исполнитель, не автор").catch(() => {});
        return;
      }
      const requesterName = displayUserName(ctx.from ?? { id: userId });
      await db.updateEvent(eventId, {
        completion_requested_at: new Date().toISOString(),
        completion_requested_by_tg_id: userId,
      });
      if (botForNotify) {
        await botForNotify.telegram
          .sendMessage(event.owner_tg_id, completionText(event, requesterName), {
            reply_markup: acceptDoneKeyboard(eventId),
          })
          .catch((e) => console.error("Не удалось отправить запрос принятия автору:", e));
      }
      await ctx.answerCbQuery("Отправлено автору на принятие").catch(() => {});
      const text = `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ""}\n\n🕓 Отмечено как выполнено, ждём принятия автора`;
      await ctx.editMessageText(text).catch(() => {});
    });

    bot.action(/^accept_done:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || (ALLOWED.size && !ALLOWED.has(userId))) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }
      const eventId = ctx.match[1];
      const event = await db.getEvent(eventId);
      if (!event) {
        await ctx.answerCbQuery("Дело не найдено").catch(() => {});
        return;
      }
      if (event.owner_tg_id !== userId) {
        await ctx.answerCbQuery("Принять может только автор дела").catch(() => {});
        return;
      }
      const nowIso = new Date().toISOString();
      await db.updateEvent(eventId, {
        completed_at: nowIso,
        completed_by_tg_id: event.completion_requested_by_tg_id ?? userId,
      });
      await ctx.answerCbQuery("Дело принято и завершено").catch(() => {});
      const text = `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ""}\n\n✅ Принято автором (${new Date(nowIso).toLocaleString("ru-RU")})`;
      await ctx.editMessageText(text).catch(() => {});
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
            inline_keyboard: [[{ text: "Открыть планер", web_app: { url: WEB_APP_URL } }]],
          },
        });
      } else {
        await ctx.reply(
          "Задай на сервере переменную WEB_APP_URL — публичный https-адрес, где открывается это приложение (Mini App).",
        );
      }
    });

    if (WEB_APP_URL) {
      await bot.telegram
        .setChatMenuButton({
          menuButton: {
            type: "web_app",
            text: "Start",
            web_app: { url: WEB_APP_URL },
          },
        })
        .catch((e) => console.error("Не удалось установить кнопку меню Start", e));
    }
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

  // Раз в день сохраняем снимок всех дел в БД backup-таблицу.
  cron.schedule("17 3 * * *", () => {
    void saveDailyBackupIfNeeded();
  });

  // Ежечасно удаляем завершённые дела старше 5 дней.
  cron.schedule("12 * * * *", () => {
    void cleanupCompletedTasks();
  });

  // Каждые 5 минут: если время дела прошло, просим автора принять автозавершение.
  cron.schedule("*/5 * * * *", () => {
    void autoRequestCompletionForOverdueTasks();
  });

  // И сразу один раз при старте (если за сегодня ещё не было snapshot).
  void saveDailyBackupIfNeeded();
  void autoRequestCompletionForOverdueTasks();
  void cleanupCompletedTasks();

  // Сначала HTTP — иначе при ошибке Telegram порт не откроется.
  app.listen(PORT, () => {
    console.log(`API + статика: порт ${PORT}`);
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

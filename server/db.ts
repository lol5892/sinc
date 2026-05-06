import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

/** Хранение в JSON-файле — без нативного SQLite (не ломается при смене версии Node на Windows). */
export type EventRow = {
  id: string;
  week_monday: string;
  day_index: number;
  day_span: number;
  start_minutes: number;
  duration_minutes: number;
  title: string;
  comment: string;
  confirmation_required: boolean;
  confirmed_at: string | null;
  confirmed_by_tg_id: number | null;
  declined_at: string | null;
  declined_by_tg_id: number | null;
  call_clicked_at: string | null;
  call_clicked_by_tg_id: number | null;
  confirmation_message_chat_id: number | null;
  confirmation_message_id: number | null;
  owner_tg_id: number;
  owner_name: string;
  card_color: string;
  remind_at: string | null;
  reminder_sent: number;
};

type FileStore = { events: EventRow[] };

/**
 * Папка хранения данных:
 * - локально по умолчанию: ./data
 * - в проде можно задать DATA_DIR (например /app/data для Railway Volume)
 */
const dataDir = (() => {
  const raw = (process.env.DATA_DIR ?? "").trim();
  if (!raw) return path.join(process.cwd(), "data");
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
})();
const storePath = path.join(dataDir, "events.json");

let mem: FileStore | null = null;
let pgPool: Pool | null = null;
let usePostgres = false;

function wantPostgres(): boolean {
  return Boolean((process.env.DATABASE_URL ?? "").trim());
}

function getPool(): Pool {
  if (!pgPool) {
    const connectionString = (process.env.DATABASE_URL ?? "").trim();
    if (!connectionString) throw new Error("DATABASE_URL is empty");
    pgPool = new Pool({
      connectionString,
      // Railway Postgres usually requires SSL in production.
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pgPool;
}

function readDisk(): FileStore {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(storePath)) return { events: [] };
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const p = JSON.parse(raw) as FileStore;
    if (!Array.isArray(p.events)) return { events: [] };
    return {
      events: p.events.map((e) => ({
        ...e,
        day_span: Number.isFinite((e as Partial<EventRow>).day_span) ? (e as Partial<EventRow>).day_span! : 1,
        comment: typeof (e as Partial<EventRow>).comment === "string" ? (e as Partial<EventRow>).comment! : "",
        confirmation_required: Boolean((e as Partial<EventRow>).confirmation_required),
        confirmed_at: typeof (e as Partial<EventRow>).confirmed_at === "string" ? (e as Partial<EventRow>).confirmed_at! : null,
        confirmed_by_tg_id: Number.isFinite((e as Partial<EventRow>).confirmed_by_tg_id)
          ? (e as Partial<EventRow>).confirmed_by_tg_id!
          : null,
        declined_at: typeof (e as Partial<EventRow>).declined_at === "string" ? (e as Partial<EventRow>).declined_at! : null,
        declined_by_tg_id: Number.isFinite((e as Partial<EventRow>).declined_by_tg_id)
          ? (e as Partial<EventRow>).declined_by_tg_id!
          : null,
        call_clicked_at:
          typeof (e as Partial<EventRow>).call_clicked_at === "string" ? (e as Partial<EventRow>).call_clicked_at! : null,
        call_clicked_by_tg_id: Number.isFinite((e as Partial<EventRow>).call_clicked_by_tg_id)
          ? (e as Partial<EventRow>).call_clicked_by_tg_id!
          : null,
        confirmation_message_chat_id: Number.isFinite((e as Partial<EventRow>).confirmation_message_chat_id)
          ? (e as Partial<EventRow>).confirmation_message_chat_id!
          : null,
        confirmation_message_id: Number.isFinite((e as Partial<EventRow>).confirmation_message_id)
          ? (e as Partial<EventRow>).confirmation_message_id!
          : null,
        owner_name:
          typeof (e as Partial<EventRow>).owner_name === "string" && (e as Partial<EventRow>).owner_name!.trim()
            ? (e as Partial<EventRow>).owner_name!.trim()
            : `Пользователь ${e.owner_tg_id}`,
        card_color:
          typeof (e as Partial<EventRow>).card_color === "string" && (e as Partial<EventRow>).card_color!.trim()
            ? (e as Partial<EventRow>).card_color!.trim()
            : "slate",
      })),
    };
  } catch {
    return { events: [] };
  }
}

function writeDisk(s: FileStore) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(s, null, 2), "utf-8");
}

function getStore(): FileStore {
  if (!mem) mem = readDisk();
  return mem;
}

/** Вызвать при старте сервера (создаёт папку data при необходимости). */
async function initPostgres() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      week_monday TEXT NOT NULL,
      day_index INTEGER NOT NULL,
      day_span INTEGER NOT NULL,
      start_minutes INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL,
      title TEXT NOT NULL,
      comment TEXT NOT NULL,
      confirmation_required BOOLEAN NOT NULL DEFAULT FALSE,
      confirmed_at TEXT NULL,
      confirmed_by_tg_id BIGINT NULL,
      declined_at TEXT NULL,
      declined_by_tg_id BIGINT NULL,
      call_clicked_at TEXT NULL,
      call_clicked_by_tg_id BIGINT NULL,
      confirmation_message_chat_id BIGINT NULL,
      confirmation_message_id BIGINT NULL,
      owner_tg_id BIGINT NOT NULL,
      owner_name TEXT NOT NULL,
      card_color TEXT NOT NULL DEFAULT 'slate',
      remind_at TEXT NULL,
      reminder_sent INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_backups (
      day_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      events_json JSONB NOT NULL
    )
  `);
}

export async function initStore() {
  usePostgres = wantPostgres();
  if (usePostgres) {
    await initPostgres();
    return;
  }
  getStore();
}

export async function getEvent(id: string): Promise<EventRow | null> {
  if (usePostgres) {
    const { rows } = await getPool().query<EventRow>("SELECT * FROM events WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ?? null;
  }
  return getStore().events.find((e) => e.id === id) ?? null;
}

export async function listEventsForWeek(weekMonday: string): Promise<EventRow[]> {
  if (usePostgres) {
    const { rows } = await getPool().query<EventRow>(
      `
        SELECT *
        FROM events
        WHERE week_monday = $1
          AND declined_at IS NULL
        ORDER BY day_index, start_minutes
      `,
      [weekMonday],
    );
    return rows;
  }
  return getStore()
    .events.filter((e) => {
      if (e.week_monday !== weekMonday) return false;
      if (e.declined_at) return false;
      return true;
    })
    .sort((a, b) => a.day_index - b.day_index || a.start_minutes - b.start_minutes);
}

export async function insertEvent(row: Omit<EventRow, "reminder_sent"> & { reminder_sent?: number }) {
  if (usePostgres) {
    await getPool().query(
      `
        INSERT INTO events (
          id, week_monday, day_index, day_span, start_minutes, duration_minutes, title, comment,
          confirmation_required, confirmed_at, confirmed_by_tg_id, declined_at, declined_by_tg_id,
          call_clicked_at, call_clicked_by_tg_id, confirmation_message_chat_id, confirmation_message_id,
          owner_tg_id, owner_name, card_color, remind_at, reminder_sent
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22
        )
      `,
      [
        row.id,
        row.week_monday,
        row.day_index,
        row.day_span,
        row.start_minutes,
        row.duration_minutes,
        row.title,
        row.comment,
        row.confirmation_required ?? false,
        row.confirmed_at ?? null,
        row.confirmed_by_tg_id ?? null,
        row.declined_at ?? null,
        row.declined_by_tg_id ?? null,
        row.call_clicked_at ?? null,
        row.call_clicked_by_tg_id ?? null,
        row.confirmation_message_chat_id ?? null,
        row.confirmation_message_id ?? null,
        row.owner_tg_id,
        row.owner_name.trim() || `Пользователь ${row.owner_tg_id}`,
        row.card_color?.trim() || "slate",
        row.remind_at ?? null,
        row.reminder_sent ?? 0,
      ],
    );
    return;
  }
  const s = getStore();
  s.events.push({
    ...row,
    confirmation_required: row.confirmation_required ?? false,
    confirmed_at: row.confirmed_at ?? null,
    confirmed_by_tg_id: row.confirmed_by_tg_id ?? null,
    declined_at: row.declined_at ?? null,
    declined_by_tg_id: row.declined_by_tg_id ?? null,
    call_clicked_at: row.call_clicked_at ?? null,
    call_clicked_by_tg_id: row.call_clicked_by_tg_id ?? null,
    confirmation_message_chat_id: row.confirmation_message_chat_id ?? null,
    confirmation_message_id: row.confirmation_message_id ?? null,
    owner_name: row.owner_name.trim() || `Пользователь ${row.owner_tg_id}`,
    card_color: row.card_color?.trim() || "slate",
    remind_at: row.remind_at ?? null,
    reminder_sent: row.reminder_sent ?? 0,
  });
  writeDisk(s);
}

export async function updateEvent(
  id: string,
  patch: Partial<
    Pick<
      EventRow,
      | "day_index"
      | "day_span"
      | "start_minutes"
      | "duration_minutes"
      | "title"
      | "comment"
      | "confirmation_required"
      | "confirmed_at"
      | "confirmed_by_tg_id"
      | "declined_at"
      | "declined_by_tg_id"
      | "call_clicked_at"
      | "call_clicked_by_tg_id"
      | "confirmation_message_chat_id"
      | "confirmation_message_id"
      | "card_color"
      | "remind_at"
      | "reminder_sent"
    >
  >,
) {
  if (usePostgres) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const setSql = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const values = entries.map(([, v]) => v);
    values.push(id);
    await getPool().query(`UPDATE events SET ${setSql} WHERE id = $${values.length}`, values);
    return;
  }
  const s = getStore();
  const ev = s.events.find((e) => e.id === id);
  if (!ev) return;
  if (patch.day_index !== undefined) ev.day_index = patch.day_index;
  if (patch.day_span !== undefined) ev.day_span = patch.day_span;
  if (patch.start_minutes !== undefined) ev.start_minutes = patch.start_minutes;
  if (patch.duration_minutes !== undefined) ev.duration_minutes = patch.duration_minutes;
  if (patch.title !== undefined) ev.title = patch.title;
  if (patch.comment !== undefined) ev.comment = patch.comment;
  if (patch.confirmation_required !== undefined) ev.confirmation_required = patch.confirmation_required;
  if (patch.confirmed_at !== undefined) ev.confirmed_at = patch.confirmed_at;
  if (patch.confirmed_by_tg_id !== undefined) ev.confirmed_by_tg_id = patch.confirmed_by_tg_id;
  if (patch.declined_at !== undefined) ev.declined_at = patch.declined_at;
  if (patch.declined_by_tg_id !== undefined) ev.declined_by_tg_id = patch.declined_by_tg_id;
  if (patch.call_clicked_at !== undefined) ev.call_clicked_at = patch.call_clicked_at;
  if (patch.call_clicked_by_tg_id !== undefined) ev.call_clicked_by_tg_id = patch.call_clicked_by_tg_id;
  if (patch.confirmation_message_chat_id !== undefined) ev.confirmation_message_chat_id = patch.confirmation_message_chat_id;
  if (patch.confirmation_message_id !== undefined) ev.confirmation_message_id = patch.confirmation_message_id;
  if (patch.card_color !== undefined) ev.card_color = patch.card_color;
  if (patch.remind_at !== undefined) ev.remind_at = patch.remind_at;
  if (patch.reminder_sent !== undefined) ev.reminder_sent = patch.reminder_sent;
  writeDisk(s);
}

export async function deleteEvent(id: string) {
  if (usePostgres) {
    await getPool().query("DELETE FROM events WHERE id = $1", [id]);
    return;
  }
  const s = getStore();
  s.events = s.events.filter((e) => e.id !== id);
  writeDisk(s);
}

export async function dueReminders(nowIso: string): Promise<EventRow[]> {
  if (usePostgres) {
    const { rows } = await getPool().query<EventRow>(
      `
        SELECT *
        FROM events
        WHERE reminder_sent = 0
          AND remind_at IS NOT NULL
          AND remind_at <> ''
          AND remind_at <= $1
      `,
      [nowIso],
    );
    return rows;
  }
  return getStore().events.filter(
    (e) => e.reminder_sent === 0 && e.remind_at != null && e.remind_at !== "" && e.remind_at <= nowIso,
  );
}

export async function listAllEvents(): Promise<EventRow[]> {
  if (usePostgres) {
    const { rows } = await getPool().query<EventRow>("SELECT * FROM events ORDER BY week_monday, day_index, start_minutes");
    return rows;
  }
  return [...getStore().events].sort((a, b) =>
    a.week_monday.localeCompare(b.week_monday) || a.day_index - b.day_index || a.start_minutes - b.start_minutes,
  );
}

/** Сохраняет 1 снимок в день. Возвращает true, если сегодня снимок создан впервые. */
export async function saveDailyBackup(dayKey: string): Promise<boolean> {
  if (usePostgres) {
    const createdAt = new Date().toISOString();
    const { rowCount } = await getPool().query(
      `
        INSERT INTO event_backups (day_key, created_at, events_json)
        SELECT $1, $2, COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.week_monday, e.day_index, e.start_minutes), '[]'::jsonb)
        FROM events e
        ON CONFLICT (day_key) DO NOTHING
      `,
      [dayKey, createdAt],
    );
    return (rowCount ?? 0) > 0;
  }
  return false;
}

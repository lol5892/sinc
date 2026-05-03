import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type EventRow = {
  id: string;
  week_monday: string;
  day_index: number;
  start_minutes: number;
  duration_minutes: number;
  title: string;
  owner_tg_id: number;
  remind_at: string | null;
  reminder_sent: number;
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "planner.db");
  db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      week_monday TEXT NOT NULL,
      day_index INTEGER NOT NULL,
      start_minutes INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL,
      title TEXT NOT NULL,
      owner_tg_id INTEGER NOT NULL,
      remind_at TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_week ON events(week_monday);
  `);
  return db;
}

export function listEventsForWeek(weekMonday: string): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, week_monday, day_index, start_minutes, duration_minutes, title, owner_tg_id, remind_at, reminder_sent
       FROM events WHERE week_monday = ? ORDER BY day_index, start_minutes`,
    )
    .all(weekMonday) as EventRow[];
}

export function insertEvent(row: Omit<EventRow, "reminder_sent"> & { reminder_sent?: number }) {
  getDb()
    .prepare(
      `INSERT INTO events (id, week_monday, day_index, start_minutes, duration_minutes, title, owner_tg_id, remind_at, reminder_sent)
       VALUES (@id, @week_monday, @day_index, @start_minutes, @duration_minutes, @title, @owner_tg_id, @remind_at, @reminder_sent)`,
    )
    .run({
      ...row,
      remind_at: row.remind_at ?? null,
      reminder_sent: row.reminder_sent ?? 0,
    });
}

export function updateEvent(
  id: string,
  patch: Partial<
    Pick<EventRow, "day_index" | "start_minutes" | "duration_minutes" | "title" | "remind_at" | "reminder_sent">
  >,
) {
  const parts: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.day_index !== undefined) {
    parts.push("day_index = @day_index");
    params.day_index = patch.day_index;
  }
  if (patch.start_minutes !== undefined) {
    parts.push("start_minutes = @start_minutes");
    params.start_minutes = patch.start_minutes;
  }
  if (patch.duration_minutes !== undefined) {
    parts.push("duration_minutes = @duration_minutes");
    params.duration_minutes = patch.duration_minutes;
  }
  if (patch.title !== undefined) {
    parts.push("title = @title");
    params.title = patch.title;
  }
  if (patch.remind_at !== undefined) {
    parts.push("remind_at = @remind_at");
    params.remind_at = patch.remind_at;
  }
  if (patch.reminder_sent !== undefined) {
    parts.push("reminder_sent = @reminder_sent");
    params.reminder_sent = patch.reminder_sent;
  }
  if (parts.length === 0) return;
  getDb().prepare(`UPDATE events SET ${parts.join(", ")} WHERE id = @id`).run(params);
}

export function deleteEvent(id: string) {
  getDb().prepare(`DELETE FROM events WHERE id = ?`).run(id);
}

export function dueReminders(nowIso: string): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, week_monday, day_index, start_minutes, duration_minutes, title, owner_tg_id, remind_at, reminder_sent
       FROM events
       WHERE reminder_sent = 0 AND remind_at IS NOT NULL AND remind_at <= ?`,
    )
    .all(nowIso) as EventRow[];
}

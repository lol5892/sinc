import fs from "node:fs";
import path from "node:path";

/** Хранение в JSON-файле — без нативного SQLite (не ломается при смене версии Node на Windows). */
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

type FileStore = { events: EventRow[] };

const dataDir = path.join(process.cwd(), "data");
const storePath = path.join(dataDir, "events.json");

let mem: FileStore | null = null;

function readDisk(): FileStore {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(storePath)) return { events: [] };
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const p = JSON.parse(raw) as FileStore;
    if (!Array.isArray(p.events)) return { events: [] };
    return p;
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
export function initStore() {
  getStore();
}

export function eventExists(id: string): boolean {
  return getStore().events.some((e) => e.id === id);
}

export function listEventsForWeek(weekMonday: string): EventRow[] {
  return getStore()
    .events.filter((e) => e.week_monday === weekMonday)
    .sort((a, b) => a.day_index - b.day_index || a.start_minutes - b.start_minutes);
}

export function insertEvent(row: Omit<EventRow, "reminder_sent"> & { reminder_sent?: number }) {
  const s = getStore();
  s.events.push({
    ...row,
    remind_at: row.remind_at ?? null,
    reminder_sent: row.reminder_sent ?? 0,
  });
  writeDisk(s);
}

export function updateEvent(
  id: string,
  patch: Partial<
    Pick<EventRow, "day_index" | "start_minutes" | "duration_minutes" | "title" | "remind_at" | "reminder_sent">
  >,
) {
  const s = getStore();
  const ev = s.events.find((e) => e.id === id);
  if (!ev) return;
  if (patch.day_index !== undefined) ev.day_index = patch.day_index;
  if (patch.start_minutes !== undefined) ev.start_minutes = patch.start_minutes;
  if (patch.duration_minutes !== undefined) ev.duration_minutes = patch.duration_minutes;
  if (patch.title !== undefined) ev.title = patch.title;
  if (patch.remind_at !== undefined) ev.remind_at = patch.remind_at;
  if (patch.reminder_sent !== undefined) ev.reminder_sent = patch.reminder_sent;
  writeDisk(s);
}

export function deleteEvent(id: string) {
  const s = getStore();
  s.events = s.events.filter((e) => e.id !== id);
  writeDisk(s);
}

export function dueReminders(nowIso: string): EventRow[] {
  return getStore().events.filter(
    (e) => e.reminder_sent === 0 && e.remind_at != null && e.remind_at !== "" && e.remind_at <= nowIso,
  );
}

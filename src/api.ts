import type { ApiEvent } from "./types";

function headers(initData: string, devUserId?: string, devUserName?: string): HeadersInit {
  const h: Record<string, string> = {};
  if (initData) h.Authorization = `tma ${initData}`;
  if (devUserId) h["x-dev-user-id"] = devUserId;
  if (devUserName) h["x-dev-user-name"] = devUserName;
  return h;
}

export async function fetchWeek(
  monday: string,
  initData: string,
  devUserId?: string,
  devUserName?: string,
): Promise<{ monday: string; events: ApiEvent[] }> {
  const r = await fetch(`/api/week?monday=${encodeURIComponent(monday)}`, {
    headers: headers(initData, devUserId, devUserName),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ monday: string; events: ApiEvent[] }>;
}

export async function createEvent(
  body: {
    week_monday: string;
    day_index: number;
    day_span?: number;
    start_minutes: number;
    duration_minutes: number;
    title: string;
    remind_at?: string | null;
  },
  initData: string,
  devUserId?: string,
  devUserName?: string,
): Promise<{ id: string }> {
  const r = await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers(initData, devUserId, devUserName) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ id: string }>;
}

export async function patchEvent(
  id: string,
  patch: Partial<{
    day_index: number;
    day_span: number;
    start_minutes: number;
    duration_minutes: number;
    title: string;
    remind_at: string | null;
  }>,
  initData: string,
  devUserId?: string,
  devUserName?: string,
): Promise<void> {
  const r = await fetch(`/api/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers(initData, devUserId, devUserName) },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function deleteEvent(id: string, initData: string, devUserId?: string, devUserName?: string): Promise<void> {
  const r = await fetch(`/api/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(initData, devUserId, devUserName),
  });
  if (!r.ok) throw new Error(await r.text());
}

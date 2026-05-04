import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiEvent } from "./types";
import * as api from "./api";
import "./WeekPlanner.css";

const SNAP = 15;
const HOUR_H = 44;
const DAY_H = 24 * HOUR_H;
const TIME_W = 46;
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DEFAULT_DURATION = 60;

function mondayISO(d: Date): string {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): Date {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d;
}

function snapMin(m: number): number {
  return Math.round(m / SNAP) * SNAP;
}

function fmtClock(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function fmtDuration(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm} мин`;
  if (mm === 0) return `${h} ч`;
  return `${h} ч ${mm} мин`;
}

function parseClock(value: string): number | null {
  const [hh, mm] = value.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function durationOptions(current: number): number[] {
  return Array.from(new Set([15, 30, 45, 60, 90, 120, 180, 240, current])).sort((a, b) => a - b);
}

function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Props = {
  initData: string;
  devUserId?: string;
  myTgId: number | null;
};

type DragState = {
  id: string;
  pointerId: number;
  start0: number;
  dur0: number;
  y0: number;
};

type ResizeState = {
  id: string;
  pointerId: number;
  dur0: number;
  start0: number;
  y0: number;
};

export default function WeekPlanner({ initData, devUserId, myTgId }: Props) {
  const [monday, setMonday] = useState(() => mondayISO(new Date()));
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [preview, setPreview] = useState<Partial<Pick<ApiEvent, "day_index" | "start_minutes" | "duration_minutes">> & { id: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const ignoreClickUntil = useRef(0);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const r = await api.fetchWeek(monday, initData, devUserId);
      setEvents(r.events);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [monday, initData, devUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dayDates = useMemo(
    () => WD.map((label, i) => ({ label, date: addDays(monday, i) })),
    [monday],
  );

  const eventsByDay = useMemo(() => {
    const m = new Map<number, ApiEvent[]>();
    for (let i = 0; i < 7; i++) m.set(i, []);
    for (const e of events) {
      if (e.week_monday !== monday) continue;
      m.get(e.day_index)?.push(e);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.start_minutes - b.start_minutes);
    return m;
  }, [events, monday]);

  const displayEvent = (e: ApiEvent) => {
    if (preview?.id === e.id) {
      return {
        ...e,
        day_index: preview.day_index ?? e.day_index,
        start_minutes: preview.start_minutes ?? e.start_minutes,
        duration_minutes: preview.duration_minutes ?? e.duration_minutes,
      };
    }
    return e;
  };

  const shiftWeek = (delta: number) => {
    const d = new Date(monday + "T12:00:00");
    d.setDate(d.getDate() + delta * 7);
    setMonday(mondayISO(d));
  };

  const onPointerDownBlock = (ev: React.PointerEvent, e: ApiEvent) => {
    if ((ev.target as HTMLElement).closest(".resize-handle")) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setDrag({
      id: e.id,
      pointerId: ev.pointerId,
      start0: e.start_minutes,
      dur0: e.duration_minutes,
      y0: ev.clientY,
    });
    setPreview({
      id: e.id,
      day_index: e.day_index,
      start_minutes: e.start_minutes,
      duration_minutes: e.duration_minutes,
    });
  };

  const onPointerDownResize = (ev: React.PointerEvent, e: ApiEvent) => {
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setResize({
      id: e.id,
      pointerId: ev.pointerId,
      dur0: e.duration_minutes,
      start0: e.start_minutes,
      y0: ev.clientY,
    });
    setPreview({
      id: e.id,
      duration_minutes: e.duration_minutes,
      start_minutes: e.start_minutes,
      day_index: e.day_index,
    });
  };

  useEffect(() => {
    if (!drag && !resize) return;
    const onMove = (ev: PointerEvent) => {
      if (drag && ev.pointerId === drag.pointerId) {
        const gr = gridRef.current?.getBoundingClientRect();
        if (!gr) return;
        const colW = (gr.width - TIME_W) / 7;
        const areaLeft = gr.left + TIME_W;
        const dy = ev.clientY - drag.y0;
        const dMin = (dy / HOUR_H) * 60;
        let start = snapMin(drag.start0 + dMin);
        start = Math.max(0, Math.min(24 * 60 - drag.dur0, start));
        const relX = ev.clientX - areaLeft;
        let day = Math.floor(relX / colW);
        day = Math.max(0, Math.min(6, day));
        setPreview({
          id: drag.id,
          start_minutes: start,
          day_index: day,
          duration_minutes: drag.dur0,
        });
      }
      if (resize && ev.pointerId === resize.pointerId) {
        const dy = ev.clientY - resize.y0;
        const dMin = (dy / HOUR_H) * 60;
        let dur = snapMin(Math.max(SNAP, resize.dur0 + dMin));
        const maxDur = 24 * 60 - resize.start0;
        dur = Math.min(dur, maxDur);
        setPreview({
          id: resize.id,
          duration_minutes: dur,
          start_minutes: resize.start0,
        });
      }
    };
    const onUp = async (ev: PointerEvent) => {
      if (drag && ev.pointerId === drag.pointerId) {
        const gr = gridRef.current?.getBoundingClientRect();
        const colW = gr ? (gr.width - TIME_W) / 7 : 1;
        const areaLeft = gr ? gr.left + TIME_W : 0;
        const dy = ev.clientY - drag.y0;
        let start = snapMin(drag.start0 + (dy / HOUR_H) * 60);
        start = Math.max(0, Math.min(24 * 60 - drag.dur0, start));
        const relX = ev.clientX - areaLeft;
        let day = Math.floor(relX / colW);
        day = Math.max(0, Math.min(6, day));
        setDrag(null);
        setPreview(null);
        ignoreClickUntil.current = performance.now() + 500;
        try {
          await api.patchEvent(
            drag.id,
            { day_index: day, start_minutes: start, duration_minutes: drag.dur0 },
            initData,
            devUserId,
          );
          void load();
        } catch (e) {
          setErr(String(e));
        }
      }
      if (resize && ev.pointerId === resize.pointerId) {
        const dy = ev.clientY - resize.y0;
        let dur = snapMin(Math.max(SNAP, resize.dur0 + (dy / HOUR_H) * 60));
        dur = Math.min(dur, 24 * 60 - resize.start0);
        setResize(null);
        setPreview(null);
        ignoreClickUntil.current = performance.now() + 500;
        try {
          await api.patchEvent(resize.id, { duration_minutes: dur }, initData, devUserId);
          void load();
        } catch (e) {
          setErr(String(e));
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, resize, initData, devUserId, load]);

  const [editor, setEditor] = useState<
    | null
    | ({
        mode: "create" | "edit";
        day_index: number;
        start_minutes: number;
        duration_minutes: number;
        title: string;
        remind_at: string;
      } & Partial<{ id: string }>)
  >(null);

  const openCreateAt = (day_index: number, start_minutes: number) => {
    const start = Math.min(24 * 60 - SNAP, Math.max(0, snapMin(start_minutes)));
    setEditor({
      mode: "create",
      day_index,
      start_minutes: start,
      duration_minutes: Math.min(DEFAULT_DURATION, 24 * 60 - start),
      title: "",
      remind_at: "",
    });
  };

  const onBackgroundPointer = (ev: React.PointerEvent, day: number) => {
    if (ev.target !== ev.currentTarget) return;
    const rect = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const mins = snapMin((y / DAY_H) * 24 * 60);
    openCreateAt(day, Math.min(24 * 60 - SNAP, mins));
  };

  const saveEditor = async () => {
    if (!editor) return;
    const title = editor.title.trim();
    if (!title) {
      setErr("Напиши название дела.");
      return;
    }
    const safeDuration = Math.min(Math.max(SNAP, editor.duration_minutes), 24 * 60 - editor.start_minutes);
    try {
      if (editor.mode === "create") {
        await api.createEvent(
          {
            week_monday: monday,
            day_index: editor.day_index,
            start_minutes: editor.start_minutes,
            duration_minutes: safeDuration,
            title,
            remind_at: editor.remind_at ? new Date(editor.remind_at).toISOString() : null,
          },
          initData,
          devUserId,
        );
      } else if (editor.id) {
        await api.patchEvent(
          editor.id,
          {
            day_index: editor.day_index,
            start_minutes: editor.start_minutes,
            duration_minutes: safeDuration,
            title,
            remind_at: editor.remind_at ? new Date(editor.remind_at).toISOString() : null,
          },
          initData,
          devUserId,
        );
      }
      setEditor(null);
      void load();
    } catch (e) {
      setErr(String(e));
    }
  };

  const deleteEditor = async () => {
    if (!editor?.id) return;
    try {
      await api.deleteEvent(editor.id, initData, devUserId);
      setEditor(null);
      void load();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="wp">
      <header className="wp-head">
        <div className="wp-brand">
          <span className="wp-logo">+</span>
          <div>
            <div className="wp-title">План недели вдвоём</div>
            <div className="wp-sub">Нажми плюс в клетке, задай дело и время вручную</div>
          </div>
        </div>
        <div className="wp-nav">
          <button type="button" className="wp-btn ghost" onClick={() => shiftWeek(-1)}>
            ←
          </button>
          <span className="wp-range">{dayDates[0].date.toLocaleDateString("ru-RU")} — {dayDates[6].date.toLocaleDateString("ru-RU")}</span>
          <button type="button" className="wp-btn ghost" onClick={() => shiftWeek(1)}>
            →
          </button>
          <button type="button" className="wp-btn primary" onClick={() => openCreateAt(0, 9 * 60)}>
            + Дело
          </button>
        </div>
      </header>

      {err && (
        <div className="wp-toast err" role="alert">
          {err}
        </div>
      )}
      {loading && <div className="wp-loading">Загрузка…</div>}

      <div className="wp-scroll">
        <div className="wp-grid" ref={gridRef}>
          <div className="wp-corner" style={{ width: TIME_W }} />
          {dayDates.map((d, i) => (
            <div key={i} className="wp-dhead">
              <span className="wp-dn">{d.label}</span>
              <span className="wp-dd">{d.date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
            </div>
          ))}

          <div className="wp-time" style={{ width: TIME_W }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="wp-hour" style={{ height: HOUR_H }}>
                <span>{String(h).padStart(2, "0")}:00</span>
              </div>
            ))}
          </div>

          {dayDates.map((_, day) => (
            <div
              key={day}
              className="wp-day"
              style={{ height: DAY_H }}
              onPointerDown={(e) => onBackgroundPointer(e, day)}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <button
                  key={h}
                  type="button"
                  className="wp-add-slot"
                  style={{ top: h * HOUR_H, height: HOUR_H }}
                  onClick={(e) => {
                    e.stopPropagation();
                    openCreateAt(day, h * 60);
                  }}
                  aria-label={`Добавить дело: ${WD[day]} ${fmtClock(h * 60)}`}
                >
                  <span className="wp-add-plus">+</span>
                </button>
              ))}
              {(eventsByDay.get(day) ?? []).map((ev) => {
                const e = displayEvent(ev);
                const top = (e.start_minutes / 60) * HOUR_H;
                const h = (e.duration_minutes / 60) * HOUR_H;
                const mine = myTgId !== null && e.owner_tg_id === myTgId;
                return (
                  <div
                    key={ev.id}
                    className={`wp-block ${mine ? "mine" : "theirs"}`}
                    style={{ top, height: Math.max(h, 28) }}
                    onPointerDown={(p) => onPointerDownBlock(p, ev)}
                    onClick={(c) => {
                      if (performance.now() < ignoreClickUntil.current) return;
                      c.stopPropagation();
                      setEditor({
                        mode: "edit",
                        id: ev.id,
                        day_index: ev.day_index,
                        start_minutes: ev.start_minutes,
                        duration_minutes: ev.duration_minutes,
                        title: ev.title,
                        remind_at: isoToDatetimeLocal(ev.remind_at),
                      });
                    }}
                  >
                    <div className="wp-block-title">{e.title}</div>
                    <div className="wp-block-meta">
                      {fmtClock(e.start_minutes)} - {fmtClock(e.start_minutes + e.duration_minutes)} · {fmtDuration(e.duration_minutes)}
                    </div>
                    <div
                      className="resize-handle"
                      onPointerDown={(p) => onPointerDownResize(p, ev)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {editor && (
        <div className="wp-modal-root" role="dialog" aria-modal>
          <div className="wp-modal">
            <h2>{editor.mode === "create" ? "Новое дело" : "Редактировать"}</h2>
            <p className="wp-modal-hint">
              Клетка уже выбрала день и примерное время. Здесь можно поправить всё руками.
            </p>
            <label className="wp-field">
              Название дела
              <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="Например: ужин с родителями" autoFocus />
            </label>
            <div className="wp-row2">
              <label className="wp-field">
                День
                <select value={editor.day_index} onChange={(e) => setEditor({ ...editor, day_index: Number(e.target.value) })}>
                  {WD.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wp-field">
                Начало
                <input
                  type="time"
                  step={900}
                  value={fmtClock(editor.start_minutes)}
                  onChange={(e) => {
                    const minutes = parseClock(e.target.value);
                    if (minutes == null) return;
                    setEditor({
                      ...editor,
                      start_minutes: minutes,
                      duration_minutes: Math.min(editor.duration_minutes, 24 * 60 - minutes),
                    });
                  }}
                />
              </label>
            </div>
            <div className="wp-row2">
              <label className="wp-field">
                Длительность
                <select
                  value={editor.duration_minutes}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      duration_minutes: Math.min(Number(e.target.value), 24 * 60 - editor.start_minutes),
                    })
                  }
                >
                  {durationOptions(editor.duration_minutes).map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {fmtDuration(minutes)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wp-field">
                До
                <div className="wp-readonly-time">{fmtClock(editor.start_minutes + editor.duration_minutes)}</div>
              </label>
            </div>
            <label className="wp-field">
              Напоминание (необязательно)
              <input
                type="datetime-local"
                value={editor.remind_at}
                onChange={(e) => setEditor({ ...editor, remind_at: e.target.value })}
              />
            </label>
            <div className="wp-summary">
              {WD[editor.day_index]}, {fmtClock(editor.start_minutes)} - {fmtClock(editor.start_minutes + editor.duration_minutes)}
            </div>
            <div className="wp-actions">
              {editor.mode === "edit" && (
                <button type="button" className="wp-btn danger" onClick={() => void deleteEditor()}>
                  Удалить
                </button>
              )}
              <button type="button" className="wp-btn ghost" onClick={() => setEditor(null)}>
                Отмена
              </button>
              <button type="button" className="wp-btn primary" onClick={() => void saveEditor()}>
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

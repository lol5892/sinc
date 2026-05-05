import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiEvent } from "./types";
import * as api from "./api";
import "./WeekPlanner.css";

const SNAP = 30;
const HOUR_H = 56;
const SLOT_H = HOUR_H / 2;
const DAY_H = 24 * HOUR_H;
const TIME_W = 58;
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

type Props = { initData: string; devUserId?: string; devUserName?: string; myTgId: number | null };
type ThemeMode = "light" | "dark";

type Interaction = {
  id: string;
  pointerId: number;
  mode: "drag" | "resize-bottom" | "resize-top" | "resize-right";
  x0: number;
  y0: number;
  day0: number;
  span0: number;
  start0: number;
  dur0: number;
};

type PreviewPatch = { id: string; day_index?: number; day_span?: number; start_minutes?: number; duration_minutes?: number };
type EditorState = {
  mode: "create" | "edit";
  id?: string;
  owner_tg_id?: number;
  readonlyDetails?: boolean;
  day_index: number;
  day_span: number;
  start_minutes: number;
  duration_minutes: number;
  title: string;
  comment: string;
  confirmation_required: boolean;
  confirmed_at: string | null;
};

function shortComment(comment: string): string {
  const text = comment.trim();
  if (!text) return "";
  return text.length > 52 ? `${text.slice(0, 52).trim()}...` : text;
}

function ymdLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function mondayISO(d: Date): string {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return ymdLocal(x);
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

function hourTheme(): ThemeMode {
  const h = new Date().getHours();
  return h >= 7 && h < 20 ? "light" : "dark";
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalizeToGrid(ev: ApiEvent): ApiEvent {
  const start = clamp(snapMin(ev.start_minutes), 0, 24 * 60 - SNAP);
  const dur = clamp(Math.round(ev.duration_minutes / SNAP) * SNAP, SNAP, 24 * 60 - start);
  const day = clamp(Math.round(ev.day_index), 0, 6);
  const span = clamp(Math.round(ev.day_span || 1), 1, 7 - day);
  return { ...ev, day_index: day, day_span: span, start_minutes: start, duration_minutes: dur };
}

export default function WeekPlanner({ initData, devUserId, devUserName, myTgId }: Props) {
  const [monday, setMonday] = useState(() => mondayISO(new Date()));
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(() => hourTheme());
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [preview, setPreview] = useState<PreviewPatch | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [infoBubble, setInfoBubble] = useState<{ id: string; x: number; y: number } | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const lastTapRef = useRef<{ day: number; min: number; t: number } | null>(null);
  const currentUserId = useMemo(() => {
    if (myTgId !== null) return myTgId;
    const n = Number(devUserId);
    return Number.isFinite(n) ? n : null;
  }, [myTgId, devUserId]);
  const isMine = useCallback(
    (e: Pick<ApiEvent, "owner_tg_id">) => currentUserId !== null && e.owner_tg_id === currentUserId,
    [currentUserId],
  );

  useEffect(() => {
    const id = window.setInterval(() => setTheme(hourTheme()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const r = await api.fetchWeek(monday, initData, devUserId, devUserName);
      setEvents(r.events.map((e) => ({ ...e, comment: e.comment ?? "", day_span: e.day_span ?? 1 })));
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [monday, initData, devUserId, devUserName]);

  useEffect(() => {
    void load();
  }, [load]);

  const dayDates = useMemo(() => WD.map((label, i) => ({ label, date: addDays(monday, i) })), [monday]);

  const rows = useMemo(() => {
    const arr: ApiEvent[] = [];
    for (const e of events) if (e.week_monday === monday) arr.push(e);
    return arr.sort((a, b) => a.day_index - b.day_index || a.start_minutes - b.start_minutes);
  }, [events, monday]);

  const bubbleEvent = useMemo(
    () => (infoBubble ? rows.find((e) => e.id === infoBubble.id) ?? null : null),
    [infoBubble, rows],
  );
  const bubbleStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!infoBubble || typeof window === "undefined") return undefined;
    return {
      left: clamp(infoBubble.x - 140, 12, window.innerWidth - 292),
      top: clamp(infoBubble.y + 12, 12, window.innerHeight - 230),
    };
  }, [infoBubble]);

  const displayEvent = (e: ApiEvent): ApiEvent => {
    const base = normalizeToGrid(e);
    if (!preview || preview.id !== e.id) return base;
    return normalizeToGrid({
      ...base,
      day_index: preview.day_index ?? base.day_index,
      day_span: preview.day_span ?? base.day_span,
      start_minutes: preview.start_minutes ?? base.start_minutes,
      duration_minutes: preview.duration_minutes ?? base.duration_minutes,
    });
  };

  const shiftWeek = (delta: number) => {
    const d = new Date(monday + "T12:00:00");
    d.setDate(d.getDate() + delta * 7);
    setMonday(mondayISO(d));
  };

  const openEditorForEvent = (e: ApiEvent) => {
    const mine = isMine(e);
    setInfoBubble(null);
    setCommentEditorOpen(false);
    setEditor({
      mode: "edit",
      id: e.id,
      owner_tg_id: e.owner_tg_id,
      readonlyDetails: !mine,
      day_index: e.day_index,
      day_span: e.day_span,
      start_minutes: e.start_minutes,
      duration_minutes: e.duration_minutes,
      title: e.title,
      comment: e.comment,
      confirmation_required: e.confirmation_required,
      confirmed_at: e.confirmed_at,
    });
  };

  const onBackgroundTap = (ev: React.PointerEvent, day: number) => {
    if (ev.target !== ev.currentTarget) return;
    const rect = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const min = clamp(snapMin((y / DAY_H) * 24 * 60), 0, 24 * 60 - SNAP);
    const now = Date.now();
    const last = lastTapRef.current;
    const isDouble = !!last && last.day === day && Math.abs(last.min - min) <= SNAP && now - last.t < 340;
    lastTapRef.current = { day, min, t: now };
    if (!isDouble) return;
    setEditor({
      mode: "create",
      day_index: day,
      day_span: 1,
      start_minutes: min,
      duration_minutes: 60,
      title: "",
      comment: "",
      confirmation_required: false,
      confirmed_at: null,
    });
    setCommentEditorOpen(false);
    setInfoBubble(null);
  };

  const onBlockPointerDown = (ev: React.PointerEvent, e: ApiEvent) => {
    beginInteraction(ev, e, "drag");
  };

  const beginInteraction = (ev: React.PointerEvent, e: ApiEvent, mode: Interaction["mode"]) => {
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setInteraction({
      id: e.id,
      pointerId: ev.pointerId,
      mode,
      x0: ev.clientX,
      y0: ev.clientY,
      day0: e.day_index,
      span0: e.day_span,
      start0: e.start_minutes,
      dur0: e.duration_minutes,
    });
    setPreview({
      id: e.id,
      day_index: e.day_index,
      day_span: e.day_span,
      start_minutes: e.start_minutes,
      duration_minutes: e.duration_minutes,
    });
  };

  useEffect(() => {
    if (!interaction) return;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== interaction.pointerId) return;
      const gr = gridRef.current?.getBoundingClientRect();
      if (!gr) return;
      const colW = (gr.width - TIME_W) / 7;
      const dxDays = Math.round((ev.clientX - interaction.x0) / colW);
      const dyMin = snapMin(((ev.clientY - interaction.y0) / SLOT_H) * SNAP);

      if (interaction.mode === "drag") {
        const span = interaction.span0;
        const day = clamp(interaction.day0 + dxDays, 0, 7 - span);
        const start = clamp(interaction.start0 + dyMin, 0, 24 * 60 - interaction.dur0);
        setPreview({ id: interaction.id, day_index: day, day_span: span, start_minutes: start, duration_minutes: interaction.dur0 });
        return;
      }

      if (interaction.mode === "resize-bottom") {
        const dur = clamp(interaction.dur0 + dyMin, SNAP, 24 * 60 - interaction.start0);
        setPreview({ id: interaction.id, duration_minutes: dur, start_minutes: interaction.start0 });
        return;
      }

      if (interaction.mode === "resize-top") {
        const newStart = clamp(interaction.start0 + dyMin, 0, interaction.start0 + interaction.dur0 - SNAP);
        const newDur = clamp(interaction.dur0 - (newStart - interaction.start0), SNAP, 24 * 60 - newStart);
        setPreview({ id: interaction.id, start_minutes: newStart, duration_minutes: newDur });
        return;
      }

      if (interaction.mode === "resize-right") {
        const span = clamp(interaction.span0 + dxDays, 1, 7 - interaction.day0);
        setPreview({ id: interaction.id, day_span: span });
      }
    };

    const onUp = async (ev: PointerEvent) => {
      if (ev.pointerId !== interaction.pointerId) return;
      const p = preview;
      setInteraction(null);
      setPreview(null);
      if (!p || p.id !== interaction.id) return;
      try {
        const patch =
          interaction.mode === "drag"
            ? {
                day_index: p.day_index,
                start_minutes: p.start_minutes,
              }
            : {
                day_index: p.day_index,
                day_span: p.day_span,
                start_minutes: p.start_minutes,
                duration_minutes: p.duration_minutes,
              };
        await api.patchEvent(
          interaction.id,
          patch,
          initData,
          devUserId,
          devUserName,
        );
        void load();
      } catch (e) {
        setErr(String(e));
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
  }, [interaction, preview, initData, devUserId, devUserName, load]);

  const saveEditor = async () => {
    if (!editor) return;
    const canEditDetails =
      editor.mode === "create" || (editor.owner_tg_id !== undefined && currentUserId !== null && editor.owner_tg_id === currentUserId);
    const title = editor.title.trim() || "Без названия";
    try {
      if (editor.mode === "create") {
        await api.createEvent(
          {
            week_monday: monday,
            day_index: editor.day_index,
            day_span: editor.day_span,
            start_minutes: editor.start_minutes,
            duration_minutes: editor.duration_minutes,
            title,
            comment: editor.comment,
            confirmation_required: editor.confirmation_required,
          },
          initData,
          devUserId,
          devUserName,
        );
      } else if (editor.id) {
        const patch = canEditDetails
          ? {
              day_index: editor.day_index,
              day_span: editor.day_span,
              start_minutes: editor.start_minutes,
              duration_minutes: editor.duration_minutes,
              title,
              comment: editor.comment,
              confirmation_required: editor.confirmation_required,
            }
          : {
              day_index: editor.day_index,
              start_minutes: editor.start_minutes,
            };
        await api.patchEvent(editor.id, patch, initData, devUserId, devUserName);
      }
      setEditor(null);
      setCommentEditorOpen(false);
      void load();
    } catch (e) {
      setErr(String(e));
    }
  };

  const onBlockTap = (ev: React.MouseEvent, e: ApiEvent) => {
    ev.stopPropagation();
    setInfoBubble({ id: e.id, x: ev.clientX, y: ev.clientY });
  };

  const removeFromEditor = async () => {
    if (!editor?.id) return;
    try {
      await api.deleteEvent(editor.id, initData, devUserId, devUserName);
      setEditor(null);
      setCommentEditorOpen(false);
      void load();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className={`wp ${theme === "dark" ? "theme-dark" : "theme-light"}`} onPointerDown={() => setInfoBubble(null)}>
      <header className="wp-head glass">
        <div className="wp-brand">
          <span className="wp-logo">◍</span>
          <div>
            <div className="wp-title">Week Duo Planner</div>
            <div className="wp-sub">Двойной тап создаёт блок на 1 час • шаг сетки 30 минут</div>
          </div>
        </div>
        <div className="wp-nav">
          <button type="button" className="wp-btn ghost" onClick={() => shiftWeek(-1)}>
            ←
          </button>
          <span className="wp-range">
            {dayDates[0].date.toLocaleDateString("ru-RU")} — {dayDates[6].date.toLocaleDateString("ru-RU")}
          </span>
          <button type="button" className="wp-btn ghost" onClick={() => shiftWeek(1)}>
            →
          </button>
        </div>
      </header>

      {err && <div className="wp-toast err">{err}</div>}
      {loading && <div className="wp-loading">Синхронизация…</div>}

      <div className="wp-scroll">
        <div className="wp-grid" ref={gridRef}>
          <div className="wp-corner" style={{ width: TIME_W }} />
          {dayDates.map((d, i) => (
            <div key={i} className="wp-dhead glass-soft">
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
            <div key={day} className="wp-day" style={{ height: DAY_H }} onPointerDown={(e) => onBackgroundTap(e, day)}>
              {Array.from({ length: 48 }, (_, i) => (
                <div key={i} className={`wp-slotline ${i % 2 === 0 ? "major" : "minor"}`} style={{ top: i * SLOT_H }} />
              ))}
            </div>
          ))}

          <div className="wp-events-layer" style={{ left: TIME_W }}>
            {rows.map((raw) => {
              const e = displayEvent(raw);
              const top = Math.round((e.start_minutes / SNAP) * SLOT_H);
              const height = Math.max(Math.round((e.duration_minutes / SNAP) * SLOT_H), Math.round(SLOT_H));
              const leftPct = (e.day_index / 7) * 100;
              const widthPct = (e.day_span / 7) * 100;
              const mine = isMine(e);
              const commentPreview = shortComment(e.comment);
              return (
                <article
                  key={e.id}
                  className={`wp-block premium ${mine ? "mine" : "theirs"}`}
                  style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%` }}
                  onPointerDown={(ev) => onBlockPointerDown(ev, e)}
                  onClick={(ev) => onBlockTap(ev, e)}
                >
                  {mine && (
                    <>
                      <div className="resize-handle top" onPointerDown={(ev) => beginInteraction(ev, e, "resize-top")} />
                      <div className="resize-handle right" onPointerDown={(ev) => beginInteraction(ev, e, "resize-right")} />
                      <div className="resize-handle bottom" onPointerDown={(ev) => beginInteraction(ev, e, "resize-bottom")} />
                    </>
                  )}

                  <div className="wp-title-btn">
                    <div className="wp-block-title">{e.title}</div>
                    {commentPreview && <div className="wp-block-comment">{commentPreview}</div>}
                    <div className="wp-block-owner">Добавил: {e.owner_name}</div>
                    <div className="wp-block-meta">
                      {fmtClock(e.start_minutes)} · {fmtClock(e.start_minutes + e.duration_minutes)} · {e.day_span} дн.
                    </div>
                  </div>
                  {e.comment.trim() && <span className="wp-block-comment-dot" />}
                </article>
              );
            })}
          </div>
        </div>
      </div>
      {editor && (
        <div className="wp-modal-root" role="dialog" aria-modal>
          <div className="wp-modal">
            <h2>
              {editor.mode === "create"
                ? "Новое дело"
                : editor.readonlyDetails
                  ? "Перенести дело"
                  : "Редактировать дело"}
            </h2>
            {editor.readonlyDetails && (
              <div className="wp-editor-note">Можно изменить только день и время. Название и комментарий меняет автор.</div>
            )}
            <label className="wp-field">
              Что сделать
              <input
                autoFocus
                value={editor.title}
                disabled={!!editor.readonlyDetails}
                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                placeholder="Например: Помыть посуду"
              />
            </label>
            <div className="wp-row2">
              <label className="wp-field">
                День
                <select
                  value={editor.day_index}
                  onChange={(e) => {
                    const day_index = Number(e.target.value);
                    setEditor({
                      ...editor,
                      day_index,
                      day_span: editor.readonlyDetails ? editor.day_span : clamp(editor.day_span, 1, 7 - day_index),
                    });
                  }}
                >
                  {WD.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wp-field">
                Время
                <input
                  type="time"
                  step={1800}
                  value={fmtClock(editor.start_minutes)}
                  onChange={(e) => {
                    const [hh, mm] = e.target.value.split(":").map(Number);
                    setEditor({ ...editor, start_minutes: hh * 60 + mm });
                  }}
                />
              </label>
            </div>
            {!editor.readonlyDetails && (
              <>
                <div className="wp-row2">
                  <label className="wp-field">
                    Длительность (ч)
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={editor.duration_minutes / 60}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          duration_minutes: Math.max(SNAP, Math.round((Number(e.target.value) * 60) / SNAP) * SNAP),
                        })
                      }
                    />
                  </label>
                </div>
                <label className="wp-field">
                  По дням
                  <input
                    type="number"
                    min={1}
                    max={7 - editor.day_index}
                    step={1}
                    value={editor.day_span}
                    onChange={(e) =>
                      setEditor({ ...editor, day_span: clamp(Number(e.target.value) || 1, 1, 7 - editor.day_index) })
                    }
                  />
                </label>
                <div className="wp-comment-preview">
                  {editor.comment.trim() ? editor.comment.trim() : "Комментарий пока не добавлен"}
                </div>
                <label className="wp-check">
                  <input
                    type="checkbox"
                    checked={editor.confirmation_required}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        confirmation_required: e.target.checked,
                        confirmed_at: e.target.checked ? editor.confirmed_at : null,
                      })
                    }
                  />
                  <span>Запросить подтверждение у второго пользователя</span>
                </label>
              </>
            )}
            <div className="wp-actions">
              {editor.mode === "edit" && events.some((event) => event.id === editor.id && isMine(event)) && (
                <button type="button" className="wp-btn danger" onClick={() => void removeFromEditor()}>
                  Удалить
                </button>
              )}
              {!editor.readonlyDetails && (
                <button type="button" className="wp-btn ghost" onClick={() => setCommentEditorOpen(true)}>
                  {editor.comment.trim() ? "Изменить комментарий" : "Добавить комментарий"}
                </button>
              )}
              <button type="button" className="wp-btn ghost" onClick={() => setEditor(null)}>
                Отмена
              </button>
              <button type="button" className="wp-btn primary" onClick={() => void saveEditor()}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {commentEditorOpen && editor && (
        <div className="wp-sheet-root" role="dialog" aria-modal onPointerDown={() => setCommentEditorOpen(false)}>
          <div className="wp-sheet" onPointerDown={(ev) => ev.stopPropagation()}>
            <h3>Комментарий к делу</h3>
            <label className="wp-field">
              Комментарий
              <textarea
                autoFocus
                value={editor.comment}
                maxLength={1000}
                onChange={(e) => setEditor({ ...editor, comment: e.target.value })}
                placeholder="Например: что купить, куда позвонить, детали дела..."
              />
            </label>
            <div className="wp-actions">
              <button type="button" className="wp-btn ghost" onClick={() => setEditor({ ...editor, comment: "" })}>
                Очистить
              </button>
              <button type="button" className="wp-btn primary" onClick={() => setCommentEditorOpen(false)}>
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
      {bubbleEvent && bubbleStyle && (
        <div
          className="wp-info-bubble"
          style={bubbleStyle}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          <div className="wp-info-head">
            <div className="wp-info-title">{bubbleEvent.title}</div>
            <button
              type="button"
              className="wp-gear"
              aria-label="Открыть изменение дела"
              onClick={() => openEditorForEvent(bubbleEvent)}
            >
              <span aria-hidden />
            </button>
          </div>
          <div className="wp-info-time">
            {WD[bubbleEvent.day_index]} · {fmtClock(bubbleEvent.start_minutes)} —{" "}
            {fmtClock(bubbleEvent.start_minutes + bubbleEvent.duration_minutes)}
          </div>
          <div className="wp-info-owner">Добавил: {bubbleEvent.owner_name}</div>
          {bubbleEvent.confirmation_required && (
            <div className={`wp-confirm-status ${bubbleEvent.confirmed_at ? "done" : ""}`}>
              {bubbleEvent.confirmed_at ? "Подтверждено" : "Ждёт подтверждения"}
            </div>
          )}
          <div className={`wp-info-comment ${bubbleEvent.comment.trim() ? "" : "wp-info-empty"}`}>
            {bubbleEvent.comment.trim() || "Комментария пока нет"}
          </div>
        </div>
      )}
    </div>
  );
}

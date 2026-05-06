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

const CARD_PALETTE = [
  { id: "slate", label: "Серый" },
  { id: "sky", label: "Небо" },
  { id: "violet", label: "Фиолет" },
  { id: "rose", label: "Роза" },
  { id: "amber", label: "Янтарь" },
  { id: "teal", label: "Бирюза" },
  { id: "coral", label: "Коралл" },
] as const;

type CardColorId = (typeof CARD_PALETTE)[number]["id"];

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
  /** Дата начала в рамках открытой недели (YYYY-MM-DD) */
  startDateIso: string;
  /** Дата окончания включительно, не раньше startDateIso */
  endDateIso: string;
  /** Показать поле даты окончания (дело на несколько дней) */
  showEndDate: boolean;
  day_index: number;
  day_span: number;
  start_minutes: number;
  end_minutes: number;
  duration_minutes: number;
  title: string;
  comment: string;
  card_color: CardColorId;
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

function normalizeCardColor(c: string | undefined): CardColorId {
  const x = (c || "slate").trim();
  return CARD_PALETTE.some((p) => p.id === x) ? (x as CardColorId) : "slate";
}

function dayIndexInWeek(weekMonday: string, dateIso: string): number {
  const t0 = new Date(weekMonday + "T12:00:00").getTime();
  const t1 = new Date(dateIso + "T12:00:00").getTime();
  return clamp(Math.round((t1 - t0) / 86400000), 0, 6);
}

function daysSpanInclusive(startIso: string, endIso: string): number {
  const a = new Date(startIso + "T12:00:00").getTime();
  const b = new Date(endIso + "T12:00:00").getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function durationFromTimes(startM: number, endM: number): number {
  let end = snapMin(endM);
  let start = snapMin(startM);
  if (end <= start) end = Math.min(start + SNAP, 24 * 60);
  return clamp(Math.round((end - start) / SNAP) * SNAP, SNAP, 24 * 60 - start);
}

function normalizeToGrid(ev: ApiEvent): ApiEvent {
  const start = clamp(snapMin(ev.start_minutes), 0, 24 * 60 - SNAP);
  const dur = clamp(Math.round(ev.duration_minutes / SNAP) * SNAP, SNAP, 24 * 60 - start);
  const day = clamp(Math.round(ev.day_index), 0, 6);
  const span = clamp(Math.round(ev.day_span || 1), 1, 7 - day);
  return {
    ...ev,
    card_color: normalizeCardColor(ev.card_color),
    day_index: day,
    day_span: span,
    start_minutes: start,
    duration_minutes: dur,
  };
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
      setEvents(
        r.events.map((e) => ({
          ...e,
          comment: e.comment ?? "",
          day_span: e.day_span ?? 1,
          card_color: normalizeCardColor((e as { card_color?: string }).card_color),
        })),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [monday, initData, devUserId, devUserName]);

  useEffect(() => {
    void load();
  }, [load]);

  const dayDates = useMemo(() => {
    const todayStr = ymdLocal(new Date());
    return WD.map((label, i) => {
      const date = addDays(monday, i);
      return { label, date, isToday: ymdLocal(date) === todayStr };
    });
  }, [monday]);

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
    const eg = normalizeToGrid(e);
    const startIso = ymdLocal(addDays(monday, eg.day_index));
    const endIso = ymdLocal(addDays(monday, eg.day_index + eg.day_span - 1));
    const endMin = Math.min(eg.start_minutes + eg.duration_minutes, 24 * 60);
    setInfoBubble(null);
    setCommentEditorOpen(false);
    setEditor({
      mode: "edit",
      id: e.id,
      owner_tg_id: e.owner_tg_id,
      readonlyDetails: !mine,
      startDateIso: startIso,
      endDateIso: endIso,
      showEndDate: eg.day_span > 1,
      day_index: eg.day_index,
      day_span: eg.day_span,
      start_minutes: eg.start_minutes,
      end_minutes: endMin,
      duration_minutes: eg.duration_minutes,
      title: e.title,
      comment: e.comment,
      card_color: normalizeCardColor(eg.card_color),
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
    const startIso = ymdLocal(addDays(monday, day));
    const endM = Math.min(min + 60, 24 * 60);
    setEditor({
      mode: "create",
      startDateIso: startIso,
      endDateIso: startIso,
      showEndDate: false,
      day_index: day,
      day_span: 1,
      start_minutes: min,
      end_minutes: endM,
      duration_minutes: durationFromTimes(min, endM),
      title: "",
      comment: "",
      card_color: "sky",
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
    const duration_minutes = durationFromTimes(editor.start_minutes, editor.end_minutes);
    try {
      if (editor.mode === "edit" && editor.id && !canEditDetails) {
        await api.patchEvent(
          editor.id,
          { day_index: editor.day_index, start_minutes: editor.start_minutes },
          initData,
          devUserId,
          devUserName,
        );
        setEditor(null);
        setCommentEditorOpen(false);
        void load();
        return;
      }

      const weekSun = ymdLocal(addDays(monday, 6));
      let startIso = editor.startDateIso;
      let endIso = editor.showEndDate ? editor.endDateIso : editor.startDateIso;
      if (startIso < monday) startIso = monday;
      if (startIso > weekSun) startIso = weekSun;
      if (endIso < startIso) endIso = startIso;
      if (endIso > weekSun) endIso = weekSun;
      const day_index = dayIndexInWeek(monday, startIso);
      const spanRaw = daysSpanInclusive(startIso, endIso);
      const day_span = clamp(spanRaw, 1, 7 - day_index);

      if (editor.mode === "create") {
        await api.createEvent(
          {
            week_monday: monday,
            day_index,
            day_span,
            start_minutes: editor.start_minutes,
            duration_minutes,
            title,
            comment: editor.comment,
            card_color: editor.card_color,
          },
          initData,
          devUserId,
          devUserName,
        );
      } else if (editor.id) {
        await api.patchEvent(
          editor.id,
          {
            day_index,
            day_span,
            start_minutes: editor.start_minutes,
            duration_minutes,
            title,
            comment: editor.comment,
            card_color: editor.card_color,
          },
          initData,
          devUserId,
          devUserName,
        );
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
        <div className="wp-nav">
          <button type="button" className="wp-btn wp-icon-btn ghost" aria-label="Предыдущая неделя" onClick={() => shiftWeek(-1)}>
            ‹
          </button>
          <span className="wp-range-chip">
            {dayDates[0].date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} —{" "}
            {dayDates[6].date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}
          </span>
          <button type="button" className="wp-btn wp-icon-btn ghost" aria-label="Следующая неделя" onClick={() => shiftWeek(1)}>
            ›
          </button>
        </div>
      </header>

      {err && <div className="wp-toast err">{err}</div>}
      {loading && <div className="wp-loading">Синхронизация…</div>}

      <div className="wp-scroll">
        <div className="wp-grid" ref={gridRef}>
          <div className="wp-corner" style={{ width: TIME_W }} />
          {dayDates.map((d, i) => (
            <div key={i} className={`wp-dhead glass-soft${d.isToday ? " wp-dhead-today" : ""}`}>
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
                  className={`wp-block premium ${mine ? "mine" : "theirs"} card-c-${normalizeCardColor(e.card_color)}`}
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
                      {fmtClock(e.start_minutes)} — {fmtClock(e.start_minutes + e.duration_minutes)}
                      {e.day_span > 1 ? ` · ${e.day_span} дн.` : ""}
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
                value={editor.title}
                disabled={!!editor.readonlyDetails}
                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                placeholder="Например: Помыть посуду"
              />
            </label>
            {!editor.readonlyDetails && (
              <div className="wp-color-field">
                <span className="wp-color-label">Цвет</span>
                <div className="wp-color-swatches" role="listbox" aria-label="Цвет карточки">
                  {CARD_PALETTE.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`wp-color-swatch card-c-${p.id}${editor.card_color === p.id ? " active" : ""}`}
                      title={p.label}
                      aria-label={p.label}
                      aria-pressed={editor.card_color === p.id}
                      onClick={() => setEditor({ ...editor, card_color: p.id })}
                    />
                  ))}
                </div>
              </div>
            )}
            <label className="wp-field">
              Дата начала
              <input
                type="date"
                min={monday}
                max={ymdLocal(addDays(monday, 6))}
                value={editor.startDateIso}
                disabled={editor.readonlyDetails && editor.day_span > 1}
                onChange={(ev) => {
                  let v = ev.target.value;
                  if (v < monday) v = monday;
                  const sun = ymdLocal(addDays(monday, 6));
                  if (v > sun) v = sun;
                  setEditor((ed) => {
                    if (!ed) return ed;
                    if (ed.readonlyDetails && ed.day_span > 1) return ed;
                    if (ed.readonlyDetails && ed.day_span <= 1) {
                      const di = dayIndexInWeek(monday, v);
                      return {
                        ...ed,
                        startDateIso: v,
                        endDateIso: v,
                        day_index: di,
                        day_span: 1,
                        duration_minutes: durationFromTimes(ed.start_minutes, ed.end_minutes),
                      };
                    }
                    let end = ed.endDateIso;
                    if (end < v) end = v;
                    if (end > sun) end = sun;
                    const di = dayIndexInWeek(monday, v);
                    const span = daysSpanInclusive(v, ed.showEndDate ? end : v);
                    return {
                      ...ed,
                      startDateIso: v,
                      endDateIso: end,
                      day_index: di,
                      day_span: clamp(span, 1, 7 - di),
                      duration_minutes: durationFromTimes(ed.start_minutes, ed.end_minutes),
                    };
                  });
                }}
              />
            </label>
            <div className="wp-row2">
              <label className="wp-field">
                Время начала
                <input
                  type="time"
                  step={300}
                  value={fmtClock(editor.start_minutes)}
                  onChange={(e) => {
                    const [hh, mm] = e.target.value.split(":").map(Number);
                    const start = hh * 60 + mm;
                    setEditor((ed) => {
                      if (!ed) return ed;
                      return {
                        ...ed,
                        start_minutes: start,
                        duration_minutes: durationFromTimes(start, ed.end_minutes),
                      };
                    });
                  }}
                />
              </label>
              <label className="wp-field">
                Время окончания
                <input
                  type="time"
                  step={300}
                  value={fmtClock(editor.end_minutes)}
                  disabled={editor.readonlyDetails}
                  onChange={(e) => {
                    const [hh, mm] = e.target.value.split(":").map(Number);
                    const end = hh * 60 + mm;
                    setEditor((ed) => {
                      if (!ed) return ed;
                      return {
                        ...ed,
                        end_minutes: end,
                        duration_minutes: durationFromTimes(ed.start_minutes, end),
                      };
                    });
                  }}
                />
              </label>
            </div>
            {!editor.readonlyDetails && (
              <div className="wp-multiday">
                <div className="wp-multiday-row">
                  <span className="wp-multiday-label">Несколько дней</span>
                  <label className="wp-switch">
                    <input
                      type="checkbox"
                      className="wp-switch-input"
                      checked={editor.showEndDate}
                      aria-label="Несколько дней: показать дату окончания"
                      onChange={(ev) => {
                        const on = ev.target.checked;
                        setEditor((ed) => {
                          if (!ed) return ed;
                          if (!on) {
                            return {
                              ...ed,
                              showEndDate: false,
                              endDateIso: ed.startDateIso,
                              day_span: 1,
                              day_index: dayIndexInWeek(monday, ed.startDateIso),
                            };
                          }
                          return {
                            ...ed,
                            showEndDate: true,
                            endDateIso: ed.endDateIso >= ed.startDateIso ? ed.endDateIso : ed.startDateIso,
                          };
                        });
                      }}
                    />
                    <span className="wp-switch-track" aria-hidden />
                  </label>
                </div>
                {editor.showEndDate && (
                  <label className="wp-field wp-field-tight">
                    <span className="wp-field-sublabel">Окончание</span>
                    <input
                      type="date"
                      min={editor.startDateIso}
                      max={ymdLocal(addDays(monday, 6))}
                      value={editor.endDateIso}
                      onChange={(ev) => {
                        let v = ev.target.value;
                        const sun = ymdLocal(addDays(monday, 6));
                        if (v < editor.startDateIso) v = editor.startDateIso;
                        if (v > sun) v = sun;
                        setEditor((ed) => {
                          if (!ed) return ed;
                          const di = dayIndexInWeek(monday, ed.startDateIso);
                          const span = daysSpanInclusive(ed.startDateIso, v);
                          return {
                            ...ed,
                            endDateIso: v,
                            day_index: di,
                            day_span: clamp(span, 1, 7 - di),
                          };
                        });
                      }}
                    />
                  </label>
                )}
              </div>
            )}
            {editor.readonlyDetails && editor.day_span > 1 && (
              <p className="wp-modal-note">
                Несколько дней: до{" "}
                {addDays(monday, editor.day_index + editor.day_span - 1).toLocaleDateString("ru-RU", {
                  day: "numeric",
                  month: "long",
                })}
                . Длительность по времени меняет автор.
              </p>
            )}
            {!editor.readonlyDetails && (
              <div className="wp-comment-preview">
                {editor.comment.trim() ? editor.comment.trim() : "Комментарий пока не добавлен"}
              </div>
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
              className={`wp-gear card-c-${normalizeCardColor(bubbleEvent.card_color)}`}
              aria-label="Открыть изменение дела"
              onClick={() => openEditorForEvent(bubbleEvent)}
            >
              <img src="/gear-settings.png" alt="" className="wp-gear-img" width={36} height={36} decoding="async" />
            </button>
          </div>
          <div className="wp-info-time">
            {bubbleEvent.day_span > 1
              ? `${addDays(monday, bubbleEvent.day_index).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} — ${addDays(monday, bubbleEvent.day_index + bubbleEvent.day_span - 1).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} · `
              : `${WD[bubbleEvent.day_index]} · `}
            {fmtClock(bubbleEvent.start_minutes)} — {fmtClock(bubbleEvent.start_minutes + bubbleEvent.duration_minutes)}
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

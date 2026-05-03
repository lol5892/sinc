import { useEffect, useMemo, useState } from "react";
import WeekPlanner from "./WeekPlanner";
import "./App.css";

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void;
        expand: () => void;
        initData: string;
        initDataUnsafe: { user?: { id?: number } };
        themeParams: Record<string, string | undefined>;
        setHeaderColor?: (c: string) => void;
        setBackgroundColor?: (c: string) => void;
      };
    };
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const devUserId = import.meta.env.VITE_DEV_USER_ID as string | undefined;

  const { initData, myTgId } = useMemo(() => {
    const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
    const id = tg?.initDataUnsafe?.user?.id ?? null;
    return { initData: tg?.initData ?? "", myTgId: id };
  }, [ready]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      const tp = tg.themeParams;
      const root = document.documentElement;
      if (tp.bg_color) {
        root.style.setProperty("--wp-bg", tp.bg_color);
        tg.setBackgroundColor?.(tp.bg_color);
      }
      if (tp.text_color) root.style.setProperty("--wp-fg", tp.text_color);
      if (tp.hint_color) root.style.setProperty("--wp-muted", tp.hint_color);
      if (tp.secondary_bg_color) root.style.setProperty("--wp-panel", tp.secondary_bg_color);
      if (tp.button_color) root.style.setProperty("--wp-accent", tp.button_color);
    }
    setReady(true);
  }, []);

  const canUse = initData.length > 0 || (import.meta.env.DEV && devUserId);

  if (!ready) return <div className="boot">…</div>;

  if (!canUse) {
    return (
      <div className="boot">
        <p>Открой это приложение из Telegram (кнопка в боте).</p>
        <p className="muted">
          Для разработки в браузере создай <code>.env</code> с <code>VITE_DEV_USER_ID</code> и тем же ID в{" "}
          <code>TELEGRAM_ALLOWED_IDS</code> на сервере.
        </p>
      </div>
    );
  }

  return <WeekPlanner initData={initData} devUserId={devUserId} myTgId={myTgId} />;
}

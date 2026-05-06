/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Имя ярлыка в приложении «Команды», который принимает текст и создаёт напоминание (см. .env.example). */
  readonly VITE_REMINDERS_SHORTCUT_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

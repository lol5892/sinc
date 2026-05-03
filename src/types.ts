export type ApiEvent = {
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

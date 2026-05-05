export type ApiEvent = {
  id: string;
  week_monday: string;
  day_index: number;
  day_span: number;
  start_minutes: number;
  duration_minutes: number;
  title: string;
  owner_tg_id: number;
  owner_name: string;
  remind_at: string | null;
  reminder_sent: number;
};

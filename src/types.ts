export type ApiEvent = {
  id: string;
  week_monday: string;
  day_index: number;
  day_span: number;
  start_minutes: number;
  duration_minutes: number;
  title: string;
  comment: string;
  assignee: "tatyana" | "anton";
  owner_tg_id: number;
  approval_status: "pending" | "confirmed" | "rejected";
  remind_at: string | null;
  reminder_sent: number;
};

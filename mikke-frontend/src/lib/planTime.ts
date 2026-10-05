// プラン作成フォームの日時を扱う純粋関数（React/ブラウザAPIに依存しない。node --test でテスト可能）。
//
// Mikke は日本国内向けサービスなので、プランの時刻はすべて「日本時間(JST, UTC+09:00)の壁時計」として扱う。
// 端末のタイムゾーン設定（海外設定・UTC設定の端末など）に左右されないよう、
// Date#getHours() などのローカル時刻APIは使わず、UTC基準の計算に固定オフセットを足して求める。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_OFFSET = "+09:00";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// 終了が開始より前でも、同じ日付・12時間以内なら「翌日まで」と解釈する（例: 23:00〜01:00）。
const NEXT_DAY_ROLLOVER_MAX_MS = 12 * HOUR_MS;
// 1回のおでかけプランとして受け付ける最長時間（サーバー側の上限と同じ）。
export const MAX_PLAN_DURATION_MS = 24 * HOUR_MS;
// フォームを開いたまま少し時間が経っても、開始時刻が「過去」扱いにならない猶予。
const PAST_START_GRACE_MS = 10 * MINUTE_MS;
const DEFAULT_DURATION_MS = 3 * HOUR_MS;

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export const PLAN_TIME_MESSAGES = {
  missing: "開始日時と終了日時を入力してください。",
  invalid_format: "日時の形式が正しくありません。カレンダーから選び直してください。",
  end_not_after_start: "終了時間は開始時間より後に設定してください。",
  too_long: "プランの時間は24時間以内で設定してください。",
  end_in_past: "終了時間が過去になっています。これからの時間を設定してください。",
  start_in_past: "開始時間が過去になっています。現在以降の時間を設定してください。",
} as const;

export type PlanTimeErrorCode = keyof typeof PLAN_TIME_MESSAGES;

export type PlanWindow =
  | {
    ok: true;
    startIso: string; // サーバーへ送る値（必ず +09:00 付き）
    endIso: string;
    endLocal: string; // 翌日補正後の datetime-local 値
    durationMinutes: number;
    endAdjustedToNextDay: boolean;
  }
  | { ok: false; code: PlanTimeErrorCode; message: string };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// 絶対時刻 → JSTの datetime-local 値 ("YYYY-MM-DDTHH:MM")
export function toJstLocal(date: Date): string {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}T${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

// JSTの datetime-local 値 → 絶対時刻。形式不正・存在しない日付（2/30など）は null。
export function parseJstLocal(value: string): Date | null {
  const m = LOCAL_PATTERN.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - JST_OFFSET_MS);
}

// 絶対時刻 → サーバーへ送るISO文字列 ("YYYY-MM-DDTHH:MM:SS+09:00")
export function toJstIso(date: Date): string {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${toJstLocal(date)}:${pad(j.getUTCSeconds())}${JST_OFFSET}`;
}

// フォームの初期値（今から1時間後〜3時間後、日本時間、分単位で切り捨て）。
export function defaultPlanWindow(now: Date = new Date()): { startAt: string; endAt: string } {
  const base = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return {
    startAt: toJstLocal(new Date(base + HOUR_MS)),
    endAt: toJstLocal(new Date(base + 3 * HOUR_MS)),
  };
}

// 開始を変えたとき、終了も同じ長さだけ一緒に動かす（カレンダーアプリと同じ挙動）。
// これで「開始だけ後ろにずらして終了が開始より前になる」事故を防ぐ。
export function shiftEndWithStart(prevStart: string, prevEnd: string, nextStart: string): string {
  const next = parseJstLocal(nextStart);
  if (!next) return prevEnd;
  const s = parseJstLocal(prevStart);
  const e = parseJstLocal(prevEnd);
  let duration = s && e ? e.getTime() - s.getTime() : DEFAULT_DURATION_MS;
  if (duration <= 0 || duration > MAX_PLAN_DURATION_MS) duration = DEFAULT_DURATION_MS;
  return toJstLocal(new Date(next.getTime() + duration));
}

function fail(code: PlanTimeErrorCode): PlanWindow {
  return { ok: false, code, message: PLAN_TIME_MESSAGES[code] };
}

// 送信前の検証と正規化。サーバーの invalid_time_range 条件（終了 <= 開始）より手前で、
// 同じ条件＋αを日本語メッセージ付きで判定する。サーバー側の検証は別途そのまま残る。
export function resolvePlanWindow(startLocal: string, endLocal: string, now: Date = new Date()): PlanWindow {
  if (!startLocal?.trim() || !endLocal?.trim()) return fail("missing");
  const start = parseJstLocal(startLocal);
  let end = parseJstLocal(endLocal);
  if (!start || !end) return fail("invalid_format");

  let endAdjustedToNextDay = false;
  if (end.getTime() <= start.getTime()) {
    const sameDate = startLocal.slice(0, 10) === endLocal.slice(0, 10);
    const rolled = new Date(end.getTime() + 24 * HOUR_MS);
    if (sameDate && end.getTime() < start.getTime() && rolled.getTime() - start.getTime() <= NEXT_DAY_ROLLOVER_MAX_MS) {
      end = rolled;
      endAdjustedToNextDay = true;
    } else {
      return fail("end_not_after_start");
    }
  }
  if (end.getTime() - start.getTime() > MAX_PLAN_DURATION_MS) return fail("too_long");
  if (end.getTime() <= now.getTime()) return fail("end_in_past");
  if (start.getTime() < now.getTime() - PAST_START_GRACE_MS) return fail("start_in_past");

  return {
    ok: true,
    startIso: toJstIso(start),
    endIso: toJstIso(end),
    endLocal: toJstLocal(end),
    durationMinutes: Math.round((end.getTime() - start.getTime()) / MINUTE_MS),
    endAdjustedToNextDay,
  };
}

// 画面表示用: "9/24(木) 23:00 〜 9/25(金) 01:00（2時間）"
export function describePlanWindow(window: Extract<PlanWindow, { ok: true }>): string {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const label = (iso: string) => {
    const j = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()}(${weekdays[j.getUTCDay()]}) ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
  };
  const h = Math.floor(window.durationMinutes / 60);
  const m = window.durationMinutes % 60;
  const duration = h && m ? `${h}時間${m}分` : h ? `${h}時間` : `${m}分`;
  return `${label(window.startIso)} 〜 ${label(window.endIso)}（${duration}）`;
}

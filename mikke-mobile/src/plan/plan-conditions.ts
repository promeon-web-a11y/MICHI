/**
 * Step 4-4「今日どこ行く？」の条件（選択肢・入力中の下書き・次工程へ渡す PlanConditions）。
 * React / expo に依存しない純粋関数（Node で単体テストするため）。
 *
 * Step 4-5（AIプラン生成）はこのファイルの PlanConditions をそのまま受け取る。
 * 現在地の変換は Step 4-3 の toPlanOrigin() を再利用する（重複実装しない）。
 */
import { toPlanOrigin } from '../location/current-location-service';
import type { CurrentLocation, PlanOrigin } from '../location/current-location-types';

// ---------------------------------------------------------------------------------------------
// 選択肢
// ---------------------------------------------------------------------------------------------

export type DurationOption = { minutes: number; label: string };
/** 使える時間（プリセット）。内部は分単位 */
export const DURATION_OPTIONS: readonly DurationOption[] = [
  { minutes: 60, label: '1時間' },
  { minutes: 120, label: '2時間' },
  { minutes: 180, label: '3時間' },
  { minutes: 240, label: '4時間' },
  { minutes: 360, label: '6時間' },
  { minutes: 480, label: '半日' },
];
/** 将来の自由入力でも受け付ける範囲（30分〜12時間） */
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 720;

export type BudgetOption = { yen: number | null; label: string };
/** 予算（1人あたり・施設利用料＋飲食費＋交通費の合計の上限を想定）。null = 気にしない（上限なし） */
export const BUDGET_OPTIONS: readonly BudgetOption[] = [
  { yen: 1000, label: '〜1,000円' },
  { yen: 3000, label: '〜3,000円' },
  { yen: 5000, label: '〜5,000円' },
  { yen: 10000, label: '〜10,000円' },
  { yen: null, label: '気にしない' },
];
export const MAX_BUDGET_YEN = 1_000_000;

/** 移動手段。経路API（徒歩 / 公共交通 / 車）へ対応付けやすい値 */
export const TRANSPORT_MODES = ['walking', 'train', 'bus', 'car'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export const TRANSPORT_OPTIONS: readonly { value: TransportMode; label: string; icon: string }[] = [
  { value: 'walking', label: '徒歩', icon: '🚶' },
  { value: 'train', label: '電車・地下鉄', icon: '🚃' },
  { value: 'bus', label: 'バス', icon: '🚌' },
  { value: 'car', label: '車', icon: '🚗' },
];

/**
 * 気分・目的（複数選択。A/B/C プランの違いを出す手がかり）。
 * 値は既存 generate-plan の moods（omakase / eat / cafe / shopping / relaxing / active）に揃え、観光だけ追加。
 * omakase は他と排他（選ぶと他を外す・全部外すと omakase に戻る）。
 */
export const PREFERENCES = ['omakase', 'eat', 'cafe', 'shopping', 'sightseeing', 'relaxing', 'active'] as const;
export type Preference = (typeof PREFERENCES)[number];
export const PREFERENCE_OPTIONS: readonly { value: Preference; label: string; icon: string }[] = [
  { value: 'omakase', label: 'おまかせ', icon: '✨' },
  { value: 'eat', label: 'グルメ', icon: '🍜' },
  { value: 'cafe', label: 'カフェ', icon: '☕' },
  { value: 'shopping', label: '買い物', icon: '🛍️' },
  { value: 'sightseeing', label: '観光', icon: '📸' },
  { value: 'relaxing', label: 'のんびり', icon: '🌿' },
  { value: 'active', label: 'アクティブ', icon: '🏃' },
];
/** 気分は3つまで（多すぎると A/B/C の違いがぼやけるため） */
export const MAX_PREFERENCES = 3;

// ---------------------------------------------------------------------------------------------
// 入力中の下書き
// ---------------------------------------------------------------------------------------------

/**
 * 出発地点の選び方。今回は現在地のみ。
 * 将来: { type: 'home' } / { type: 'custom', latitude, longitude, label } を追加する想定。
 */
export type OriginChoice = { type: 'current_location' };

export type PlanDraft = {
  origin: OriginChoice;
  durationMinutes: number;
  budgetYen: number | null;
  transportModes: TransportMode[];
  preferences: Preference[];
};

/**
 * 既定値:
 * - 3時間: 「これからちょっと出かける」で最も使われやすい長さ
 * - 〜3,000円: カフェ＋1スポット＋近距離の移動が収まる額
 * - 徒歩＋電車・地下鉄＋バス: 車の有無を仮定しない（地域を問わず使える公共交通＋徒歩）
 */
export const DEFAULT_PLAN_DRAFT: PlanDraft = {
  origin: { type: 'current_location' },
  durationMinutes: 180,
  budgetYen: 3000,
  transportModes: ['walking', 'train', 'bus'],
  preferences: ['omakase'],
};

export function isValidDuration(minutes: unknown): minutes is number {
  return (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= MIN_DURATION_MINUTES &&
    minutes <= MAX_DURATION_MINUTES
  );
}

export function isValidBudget(yen: unknown): yen is number | null {
  return yen === null || (typeof yen === 'number' && Number.isInteger(yen) && yen > 0 && yen <= MAX_BUDGET_YEN);
}

const isTransportMode = (v: unknown): v is TransportMode => TRANSPORT_MODES.includes(v as TransportMode);
const isPreference = (v: unknown): v is Preference => PREFERENCES.includes(v as Preference);

/** 不正な値を既定値に戻した下書き（重複除去・順序は選択肢の並び） */
export function sanitizeDraft(input: Partial<Record<keyof PlanDraft, unknown>> | null | undefined): PlanDraft {
  const d = input ?? {};
  const modes = Array.isArray(d.transportModes) ? TRANSPORT_MODES.filter((m) => (d.transportModes as unknown[]).includes(m)) : [];
  let prefs = Array.isArray(d.preferences) ? PREFERENCES.filter((p) => (d.preferences as unknown[]).includes(p)) : [];
  if (prefs.includes('omakase') || prefs.length === 0) prefs = ['omakase'];
  if (prefs.length > MAX_PREFERENCES) prefs = prefs.slice(0, MAX_PREFERENCES);
  return {
    origin: { type: 'current_location' },
    durationMinutes: isValidDuration(d.durationMinutes) ? d.durationMinutes : DEFAULT_PLAN_DRAFT.durationMinutes,
    budgetYen: isValidBudget(d.budgetYen) ? d.budgetYen : DEFAULT_PLAN_DRAFT.budgetYen,
    transportModes: modes.length > 0 ? modes : [...DEFAULT_PLAN_DRAFT.transportModes],
    preferences: prefs,
  };
}

export function setDuration(draft: PlanDraft, minutes: unknown): PlanDraft {
  return isValidDuration(minutes) ? { ...draft, durationMinutes: minutes } : draft;
}

export function setBudget(draft: PlanDraft, yen: unknown): PlanDraft {
  return isValidBudget(yen) ? { ...draft, budgetYen: yen } : draft;
}

/** 移動手段の選択/解除。最後の1つは解除できない */
export function toggleTransport(draft: PlanDraft, mode: unknown): PlanDraft {
  if (!isTransportMode(mode)) return draft;
  const selected = draft.transportModes.includes(mode);
  if (selected && draft.transportModes.length <= 1) return draft;
  const next = selected ? draft.transportModes.filter((m) => m !== mode) : [...draft.transportModes, mode];
  return { ...draft, transportModes: TRANSPORT_MODES.filter((m) => next.includes(m)) };
}

/** 気分の選択/解除。おまかせは排他、最大3つ、全部外すとおまかせに戻る */
export function togglePreference(draft: PlanDraft, pref: unknown): PlanDraft {
  if (!isPreference(pref)) return draft;
  if (pref === 'omakase') return { ...draft, preferences: ['omakase'] };
  const current = draft.preferences.filter((p) => p !== 'omakase');
  let next: Preference[];
  if (current.includes(pref)) {
    next = current.filter((p) => p !== pref);
  } else {
    if (current.length >= MAX_PREFERENCES) return draft;
    next = [...current, pref];
  }
  return { ...draft, preferences: next.length === 0 ? ['omakase'] : PREFERENCES.filter((p) => next.includes(p)) };
}

// ---------------------------------------------------------------------------------------------
// 次工程へ渡す条件
// ---------------------------------------------------------------------------------------------

export const PLAN_CONDITIONS_VERSION = 1;

/** Step 4-5（AIプラン生成）へ渡す条件 */
export type PlanConditions = {
  version: typeof PLAN_CONDITIONS_VERSION;
  /** 出発地点。今回は現在地のみ（Step 4-3 の toPlanOrigin で作る） */
  origin: PlanOrigin & { type: OriginChoice['type'] };
  duration_minutes: number;
  /** 1人あたりの上限。null = 気にしない */
  budget_yen: number | null;
  /** 1つ以上 */
  transport_modes: TransportMode[];
  /** 1つ以上（おまかせのみ = ['omakase']） */
  preferences: Preference[];
  /** 保存Place件数（プラン候補の母数。Place 本体はサーバーが RLS で取得する） */
  saved_place_count: number;
  /** 条件を確定した時刻（ISO 8601） */
  created_at: string;
};

export type PlanConditionsIssue =
  /** 未ログイン */
  | 'unauthorized'
  /** 保存Placeを読み込めていない / 失敗 */
  | 'saved_places_unavailable'
  | 'no_saved_places'
  /** 出発地点（現在地）が無い */
  | 'origin_missing';

export type BuildPlanConditionsResult =
  | { ok: true; conditions: PlanConditions }
  | { ok: false; issues: PlanConditionsIssue[] };

export const PLAN_ISSUE_MESSAGES: Record<PlanConditionsIssue, string> = {
  unauthorized: 'ログインが必要です',
  saved_places_unavailable: '保存した場所を読み込めていません',
  no_saved_places: 'まだ保存した場所がありません',
  origin_missing: '出発地点（現在地）を取得してください',
};

/**
 * 下書き＋現在地＋保存Place件数から PlanConditions を作る。足りないものがあれば issues を返す。
 * @param savedPlaceCount 保存Place件数。未ログインなら 'unauthorized'、読み込み中・失敗なら null
 */
export function buildPlanConditions(args: {
  draft: PlanDraft;
  location: CurrentLocation | null;
  savedPlaceCount: number | null | 'unauthorized';
  now?: () => Date;
}): BuildPlanConditionsResult {
  const issues: PlanConditionsIssue[] = [];
  if (args.savedPlaceCount === 'unauthorized') issues.push('unauthorized');
  else if (args.savedPlaceCount === null) issues.push('saved_places_unavailable');
  else if (args.savedPlaceCount <= 0) issues.push('no_saved_places');
  if (!args.location) issues.push('origin_missing');
  if (issues.length > 0 || !args.location || typeof args.savedPlaceCount !== 'number') {
    return { ok: false, issues };
  }

  // 念のため最終的な値も検証してから渡す
  const draft = sanitizeDraft(args.draft);
  return {
    ok: true,
    conditions: {
      version: PLAN_CONDITIONS_VERSION,
      origin: { type: draft.origin.type, ...toPlanOrigin(args.location) },
      duration_minutes: draft.durationMinutes,
      budget_yen: draft.budgetYen,
      transport_modes: draft.transportModes,
      preferences: draft.preferences,
      saved_place_count: args.savedPlaceCount,
      created_at: (args.now ?? (() => new Date()))().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 表示用
// ---------------------------------------------------------------------------------------------

export function durationLabel(minutes: number): string {
  const preset = DURATION_OPTIONS.find((o) => o.minutes === minutes);
  if (preset) return preset.label;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}時間` : h === 0 ? `${m}分` : `${h}時間${m}分`;
}

export function budgetLabel(yen: number | null): string {
  if (yen === null) return '予算は気にしない';
  return BUDGET_OPTIONS.find((o) => o.yen === yen)?.label ?? `〜${yen.toLocaleString('ja-JP')}円`;
}

/** 確認表示用の短い要約（JSON は見せない） */
export function summarizeConditions(c: PlanConditions): string[] {
  const label = <T extends string>(options: readonly { value: T; label: string }[], values: T[]) =>
    values.map((v) => options.find((o) => o.value === v)?.label ?? v).join('・');
  return [
    '📍 現在地から',
    `⏰ ${durationLabel(c.duration_minutes)}`,
    `💴 ${budgetLabel(c.budget_yen)}`,
    `🚶 ${label(TRANSPORT_OPTIONS, c.transport_modes)}`,
    `✨ ${label(PREFERENCE_OPTIONS, c.preferences)}`,
    `🗂 保存した${c.saved_place_count}スポットから`,
  ];
}

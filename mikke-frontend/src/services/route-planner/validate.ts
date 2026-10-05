// AI が選んだ立ち寄り先を、プログラムで時刻に落とし、直せるものは直し、検証する。AI は使わない。
// - 時刻は AI に計算させない。到着・出発は、滞在時間と移動時間の目安からここで計算する
// - 営業時間が分かる場所は、開いている時間に収まるように待つ・滞在を縮める。収まらなければ外す
// - 検証の結果は pass / warning / fail。fail が残ったプランは利用者に見せない（plan-route.ts が1回だけ作り直す）
import { estimateLeg, haversineKm } from "@/services/maps/travel-estimate";
import type { PlanLeg, ValidationIssue, ValidationStatus } from "@/services/plan/types";

import type { PlannerBrief } from "./brief";
import type { RouteCandidate } from "./candidates";

export type ChosenStop = { candidate: RouteCandidate; stayMinutes: number; reason: string; costYen: number | null };

export type ScheduledRoute = {
  stops: ChosenStop[];
  arrivals: number[];
  departures: number[];
  legs: PlanLeg[];
  /** その場所が開くまで待つ分数（最初の場所は、待たずに開始を遅らせる） */
  waits: number[];
  /** 営業時間に収められなかった立ち寄りの番号 */
  outsideHours: number[];
  start: number;
  end: number;
  totalCostYen: number | null;
};

const MIN_STAY = 30;
const MIN_STAY_RELAXED = 45;
const MAX_LEG_MINUTES = 75;
const MAX_WAIT_MINUTES = 30;
const MAX_START_SHIFT_MINUTES = 120;
/** 使える時間・終了時刻を、この分数までは超えてよい（移動時間が目安のため） */
const TIME_GRACE_MINUTES = 10;
const DEFAULT_START = 11 * 60;

const minStay = (brief: PlannerBrief) => (brief.soft.pace === "relaxed" ? MIN_STAY_RELAXED : MIN_STAY);
const isMustVisit = (stop: ChosenStop) => stop.candidate.found.mustVisit !== null;

/** 開始時刻を決める。指定があればそれ、無ければ AI の提案（無ければ 11:00）。「今から」のときは、いまより前にしない */
export function resolveStart(brief: PlannerBrief, suggested: number | null): number {
  const base = brief.window.start ?? suggested ?? DEFAULT_START;
  return brief.window.earliestStart !== null ? Math.max(base, brief.window.earliestStart) : base;
}

export function scheduleStops(stops: ChosenStop[], startMinute: number, brief: PlannerBrief): ScheduledRoute {
  const arrivals: number[] = [];
  const departures: number[] = [];
  const legs: PlanLeg[] = [];
  const waits: number[] = [];
  const outsideHours: number[] = [];
  let clock = startMinute;
  stops.forEach((stop, index) => {
    if (index > 0) {
      const leg = estimateLeg(stops[index - 1].candidate.place, stop.candidate.place, brief.transportMode);
      legs.push(leg);
      clock += leg.minutes;
    }
    let arrival = clock;
    let departure = arrival + stop.stayMinutes;
    let wait = 0;
    const hours = stop.candidate.hours;
    if (hours.status === "open") {
      // 最低限の滞在ができる、いちばん早い営業の区間を使う
      const period = hours.periods.find(([, close]) => close - minStay(brief) >= arrival);
      // 開くまで長く待つ場所は、営業時間に合わないものとして扱う。
      // 最初の場所は、待つ代わりに開始を遅らせてよい（開始時刻の指定があるときは2時間まで。使える時間の終わりを越える遅らせ方はしない）
      const mayShiftStart =
        index === 0 &&
        period !== undefined &&
        (brief.window.start === null || period[0] - arrival <= MAX_START_SHIFT_MINUTES) &&
        (brief.window.end === null || period[0] + minStay(brief) <= brief.window.end);
      const tooEarly = period !== undefined && period[0] - arrival > MAX_WAIT_MINUTES && !mayShiftStart;
      if (!period || tooEarly) {
        outsideHours.push(index);
      } else {
        if (arrival < period[0]) {
          // 最初の場所は、開くまで待つのではなく、開始を遅らせる
          wait = index === 0 ? 0 : period[0] - arrival;
          arrival = period[0];
        }
        departure = Math.min(arrival + stop.stayMinutes, period[1]);
      }
    }
    arrivals.push(arrival);
    departures.push(departure);
    waits.push(wait);
    clock = departure;
  });
  const costs = stops.map((s) => s.costYen);
  return {
    stops,
    arrivals,
    departures,
    legs,
    waits,
    outsideHours,
    start: arrivals[0] ?? startMinute,
    end: clock,
    totalCostYen: costs.some((c) => c !== null) ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null,
  };
}

function overTime(route: ScheduledRoute, brief: PlannerBrief): boolean {
  const { end, maxMinutes } = brief.window;
  if (end !== null && route.end > end + TIME_GRACE_MINUTES) return true;
  return maxMinutes !== null && route.end - route.start > maxMinutes + TIME_GRACE_MINUTES;
}

const legTooLong = (leg: PlanLeg, brief: PlannerBrief): boolean =>
  leg.minutes > MAX_LEG_MINUTES || (leg.mode === "walk" && leg.minutes > brief.maxWalkLegMinutes);

const overBudget = (route: ScheduledRoute, brief: PlannerBrief): boolean =>
  brief.hard.budgetYen !== null && route.totalCostYen !== null && route.totalCostYen > brief.hard.budgetYen;

/** 外してよい立ち寄りの番号（後ろから。必ず行きたい場所は最後まで残す） */
function removable(stops: ChosenStop[], pick: (candidates: number[]) => number): number | null {
  const optional = stops.map((_, i) => i).filter((i) => !isMustVisit(stops[i]));
  const pool = optional.length > 0 ? optional : stops.map((_, i) => i);
  return pool.length > 0 ? pick(pool) : null;
}

/**
 * 軽い問題を、作り直さずに直す。
 * 多すぎる立ち寄りを減らす → 営業時間に収まらない場所を外す → 遠すぎる区間の先を外す → 時間を超えるなら滞在を縮め、まだ超えるなら後ろから外す
 * → 予算を超えるなら高い場所から外す。
 * 外した場所の ID を removed に返す（作り直すときに、同じ場所を選ばせない）。
 */
export function repairRoute(chosen: ChosenStop[], startMinute: number, brief: PlannerBrief): { route: ScheduledRoute; removed: string[] } {
  let stops = [...chosen];
  const removed: string[] = [];
  const drop = (index: number) => {
    removed.push(stops[index].candidate.place.id);
    stops = stops.filter((_, i) => i !== index);
  };
  while (stops.length > brief.limits.maxStops) {
    const index = removable(stops, (pool) => pool[pool.length - 1]);
    if (index === null) break;
    drop(index);
  }
  let shrunk = false;
  for (let guard = 0; guard < 16; guard++) {
    const route = scheduleStops(stops, startMinute, brief);
    if (route.outsideHours.length > 0) {
      drop(route.outsideHours[0]);
      continue;
    }
    const farLeg = route.legs.findIndex((leg) => legTooLong(leg, brief));
    if (farLeg >= 0 && stops.length > brief.limits.minStops) {
      // 区間 farLeg は stops[farLeg] → stops[farLeg + 1]。あとの方を外す（必ず行きたい場所なら、前の方を外す）
      drop(isMustVisit(stops[farLeg + 1]) && !isMustVisit(stops[farLeg]) ? farLeg : farLeg + 1);
      continue;
    }
    if (overTime(route, brief)) {
      if (!shrunk) {
        // まず滞在を少し縮める（25% まで。最低限の滞在は残す）
        shrunk = true;
        stops = stops.map((s) => ({ ...s, stayMinutes: Math.max(minStay(brief), Math.floor((s.stayMinutes * 0.75) / 5) * 5) }));
        continue;
      }
      if (stops.length > brief.limits.minStops) {
        const index = removable(stops, (pool) => pool[pool.length - 1]);
        if (index !== null) {
          drop(index);
          continue;
        }
      }
    }
    if (overBudget(route, brief) && stops.length > brief.limits.minStops) {
      const index = removable(stops, (pool) => pool.reduce((best, i) => ((stops[i].costYen ?? 0) > (stops[best].costYen ?? 0) ? i : best), pool[0]));
      if (index !== null && (stops[index].costYen ?? 0) > 0) {
        drop(index);
        continue;
      }
    }
    return { route, removed };
  }
  return { route: scheduleStops(stops, startMinute, brief), removed };
}

/** 立ち寄りの順番が、いちばん短い回り方よりどれだけ遠回りか（km） */
function detourKm(stops: ChosenStop[]): number {
  if (stops.length < 3 || stops.length > 6) return 0;
  const points = stops.map((s) => s.candidate.place);
  const length = (order: number[]) => order.slice(1).reduce((sum, to, i) => sum + haversineKm(points[order[i]], points[to]), 0);
  const indexes = points.map((_, i) => i);
  let best = Infinity;
  const permute = (rest: number[], order: number[]) => {
    if (rest.length === 0) {
      best = Math.min(best, length(order));
      return;
    }
    rest.forEach((value, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...order, value]));
  };
  permute(indexes, []);
  return length(indexes) - best;
}

export type RouteCheck = { status: ValidationStatus; issues: ValidationIssue[] };

/**
 * 検証する。finalAttempt = これ以上作り直さないとき。
 * 順番の遠回り・「必ず行きたい場所」の漏れは、作り直せるうちは fail（作り直しのきっかけ）、最後は warning にして結果に出す。
 * それ以外の fail（立ち寄り不足・営業時間外・時間超過・予算超過・長すぎる移動）は、最後まで fail のまま。
 */
export function validateRoute(route: ScheduledRoute, brief: PlannerBrief, candidates: RouteCandidate[], finalAttempt: boolean): RouteCheck {
  const issues: ValidationIssue[] = [];
  const soft = (code: string) => issues.push({ code, severity: finalAttempt ? "warning" : "fail" });

  if (route.stops.length < brief.limits.minStops) issues.push({ code: "too_few_stops", severity: "fail" });
  const ids = route.stops.map((s) => s.candidate.place.id);
  if (new Set(ids).size !== ids.length) issues.push({ code: "duplicate_place", severity: "fail" });

  route.stops.forEach((stop, index) => {
    if (!(route.arrivals[index] < route.departures[index])) issues.push({ code: "arrival_not_before_departure", severity: "fail", stop: index });
    if (index > 0 && route.arrivals[index] < route.departures[index - 1]) issues.push({ code: "time_order", severity: "fail", stop: index });
    if (route.outsideHours.includes(index)) issues.push({ code: "outside_opening_hours", severity: "fail", stop: index });
    if (route.waits[index] > MAX_WAIT_MINUTES) issues.push({ code: "long_wait", severity: "fail", stop: index });
    if (stop.candidate.hours.status === "unknown") issues.push({ code: "opening_hours_unknown", severity: "warning", stop: index });
  });
  route.legs.forEach((leg, index) => {
    if (legTooLong(leg, brief)) issues.push({ code: "leg_too_long", severity: "fail", stop: index + 1 });
  });

  if (overTime(route, brief)) issues.push({ code: "over_available_time", severity: "fail" });
  if (overBudget(route, brief)) issues.push({ code: "over_budget", severity: "fail" });
  if (brief.hard.budgetYen !== null && route.stops.some((s) => s.costYen === null)) issues.push({ code: "cost_unknown", severity: "warning" });

  if (detourKm(route.stops) > 3) soft("backtracking");
  const chosen = new Set(ids);
  if (candidates.some((c) => c.found.mustVisit !== null && !chosen.has(c.place.id))) soft("must_visit_left_out");

  const coversLunch = route.start <= 11 * 60 + 30 && route.end >= 13 * 60 + 30;
  if (coversLunch && !route.stops.some((s) => s.candidate.found.kind === "meal")) issues.push({ code: "no_meal_stop", severity: "warning" });

  const status: ValidationStatus = issues.some((i) => i.severity === "fail") ? "fail" : issues.length > 0 ? "warning" : "pass";
  return { status, issues };
}

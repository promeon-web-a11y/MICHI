// 2地点間の移動時間の目安（直線距離から控えめに見積もる）。
// mikke-supabase-backend/supabase/functions/generate-plan/plan.ts の estimateTravelMinutes と同じ係数。
// 実際の経路（Google Routes API）に差し替えるときは、この関数の中身だけを置き換える。

import type { PlanLeg, TransportMode } from "@/services/plan/types";

type LatLng = { latitude: number; longitude: number };

const TRAVEL_PROFILE: Record<TransportMode, { kmh: number; overhead: number }> = {
  walk: { kmh: 4.5, overhead: 0 },
  public_transit: { kmh: 25, overhead: 10 },
  car: { kmh: 30, overhead: 5 },
};
const ROUTE_DETOUR_FACTOR = 1.3;
/** これより近ければ、車・公共交通の指定でも歩く */
const WALKABLE_KM = 1.2;

export function haversineKm(a: LatLng, b: LatLng): number {
  const r = 6371;
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export function estimateLeg(from: LatLng, to: LatLng, preferred: TransportMode | null): PlanLeg {
  const km = haversineKm(from, to) * ROUTE_DETOUR_FACTOR;
  const mode: TransportMode = km <= WALKABLE_KM ? "walk" : (preferred ?? "public_transit");
  if (km < 0.3) return { mode: "walk", minutes: 5 };
  const profile = TRAVEL_PROFILE[mode];
  const minutes = Math.max(5, Math.ceil((km / profile.kmh) * 60 + profile.overhead));
  // 5分単位に丸める（目安であることが伝わる粒度にする）
  return { mode, minutes: Math.ceil(minutes / 5) * 5 };
}

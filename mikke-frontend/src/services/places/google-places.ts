// Google Places API (New) の Text Search。サーバー専用（Route Handler からだけ使う）。
// mikke-supabase-backend の Edge Functions（resolve-place / identify-place）と同じ API・同じ環境変数名。
//   GOOGLE_PLACES_API_KEY … サーバー側だけで使う（NEXT_PUBLIC_ を付けない。写真も /api/place-photo 経由で返す）

import { redactSecrets } from "@/services/ai/openai";

const TEXT_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const PLACES_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 6;

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.photos",
  // 評価・価格帯と同じ課金区分（Text Search Enterprise）なので、足しても区分は上がらない（2026-10-05 に公式文書で確認）
  "places.regularOpeningHours",
  "places.accessibilityOptions",
].join(",");

/** 営業時間の1区間。day は 0 = 日曜。close が null のときは24時間営業 */
export type OpeningPeriod = { openDay: number; openMinute: number; closeDay: number | null; closeMinute: number | null };

export type PlaceCandidate = {
  id: string;
  name: string;
  category: string | null;
  address: string;
  latitude: number;
  longitude: number;
  mapsUrl: string | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: string | null;
  /** Place Photos のリソース名（places/…/photos/…） */
  photoName: string | null;
  photoCredit: string | null;
  /** 通常の営業時間（Google の情報）。取得できなかったときは null（「営業している」という意味ではない） */
  openingPeriods?: OpeningPeriod[] | null;
  /** 入口が車いすで入れるか（Google の情報）。情報が無いときは null */
  wheelchairEntrance?: boolean | null;
};

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  photos?: { name?: string; authorAttributions?: { displayName?: string }[] }[];
  regularOpeningHours?: { periods?: { open?: GooglePoint; close?: GooglePoint }[] };
  accessibilityOptions?: { wheelchairAccessibleEntrance?: boolean };
};
type GooglePoint = { day?: number; hour?: number; minute?: number };

function toOpeningPeriods(hours: GooglePlace["regularOpeningHours"]): OpeningPeriod[] | null {
  if (!hours || !Array.isArray(hours.periods)) return null;
  const periods: OpeningPeriod[] = [];
  for (const period of hours.periods) {
    const open = period.open;
    if (typeof open?.day !== "number" || typeof open.hour !== "number") return null;
    const close = period.close;
    periods.push({
      openDay: open.day,
      openMinute: open.hour * 60 + (open.minute ?? 0),
      closeDay: typeof close?.day === "number" ? close.day : null,
      closeMinute: typeof close?.hour === "number" ? close.hour * 60 + (close.minute ?? 0) : null,
    });
  }
  return periods;
}

export const PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export function placesApiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
}

function toCandidate(place: GooglePlace): PlaceCandidate | null {
  const name = place.displayName?.text?.trim();
  const { latitude, longitude } = place.location ?? {};
  if (!place.id || !name || typeof latitude !== "number" || typeof longitude !== "number") return null;
  // 閉業・休業中の場所はプランに入れない
  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") return null;
  const photo = place.photos?.find((p) => p.name && PHOTO_NAME_PATTERN.test(p.name));
  return {
    id: place.id,
    name,
    category: place.primaryTypeDisplayName?.text?.trim() || null,
    address: (place.formattedAddress ?? "").replace(/^日本、\s*/, "").replace(/^〒\d{3}-\d{4}\s*/, ""),
    latitude,
    longitude,
    mapsUrl: place.googleMapsUri ?? null,
    rating: typeof place.rating === "number" ? place.rating : null,
    ratingCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    priceLevel: place.priceLevel ?? null,
    photoName: photo?.name ?? null,
    photoCredit: photo?.authorAttributions?.[0]?.displayName?.trim() || null,
    openingPeriods: toOpeningPeriods(place.regularOpeningHours),
    wheelchairEntrance:
      typeof place.accessibilityOptions?.wheelchairAccessibleEntrance === "boolean" ? place.accessibilityOptions.wheelchairAccessibleEntrance : null,
  };
}

export type PlacesSearchResult = { ok: true; places: PlaceCandidate[]; cached?: boolean } | { ok: false; code: string };

// 同じ検索を短い時間だけ使い回す（メモリ上。サーバーレスではインスタンスごと）。失敗した検索は覚えない
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;
const searchCache = new Map<string, { at: number; places: PlaceCandidate[] }>();

function readCache(key: string, now: number): PlaceCandidate[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.places;
}

function writeCache(key: string, places: PlaceCandidate[], now: number) {
  if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value as string);
  searchCache.set(key, { at: now, places });
}

/**
 * languageCode は、名前・住所・種別を返してもらう言語。英語を指定しても、英語の登録が無い場所は Google が元の表記を返す
 * （こちらで訳したり書き換えたりはしない）。
 */
export async function searchPlacesByText(query: string, languageCode: "ja" | "en" = "ja"): Promise<PlacesSearchResult> {
  const apiKey = placesApiKey();
  if (!apiKey) return { ok: false, code: "not_configured" };
  const cacheKey = `${languageCode}|${query}`;
  const cached = readCache(cacheKey, Date.now());
  if (cached) return { ok: true, places: cached, cached: true };
  let response: Response;
  try {
    response = await fetch(TEXT_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({ textQuery: query, languageCode, regionCode: "JP", pageSize: PAGE_SIZE }),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("[mikke] places_request_failed", redactSecrets(String(e)));
    return { ok: false, code: "network_error" };
  }
  if (!response.ok) {
    const detail = redactSecrets((await response.text().catch(() => "")).slice(0, 300));
    console.error("[mikke] places_http_error", response.status, detail);
    return { ok: false, code: `http_${response.status}` };
  }
  try {
    const payload = (await response.json()) as { places?: GooglePlace[] };
    const places = (Array.isArray(payload.places) ? payload.places : [])
      .map(toCandidate)
      .filter((p): p is PlaceCandidate => p !== null);
    writeCache(cacheKey, places, Date.now());
    return { ok: true, places };
  } catch {
    return { ok: false, code: "response_invalid" };
  }
}

/** Place Photos (New) の画像を取得する。キーはヘッダーで送り、URL には載せない */
export async function fetchPlacePhoto(photoName: string, maxWidthPx: number): Promise<Response | null> {
  const apiKey = placesApiKey();
  if (!apiKey || !PHOTO_NAME_PATTERN.test(photoName)) return null;
  try {
    const response = await fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}`, {
      headers: { "X-Goog-Api-Key": apiKey },
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

import { createClient } from "npm:@supabase/supabase-js@2";

// Google Places API (New) を検索し、Mikkeのplacesスキーマに変換して候補を返す。
// APIキーはこの関数の中でのみ使用し、フロントエンドには一切渡さない。
// 実際の保存はこの関数では行わない。フロントエンドはここで返した候補から選び、
// 既存の save_place RPC をそのまま呼び出す（保存フロー自体は変更していない）。

type ResolveRequest = {
  query: string;
  location_bias?: { latitude: number; longitude: number; radius_meters?: number };
};

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  priceLevel?: string;
  regularOpeningHours?: { periods?: GooglePeriod[] };
  googleMapsUri?: string;
  websiteUri?: string;
  businessStatus?: string;
};

type GooglePeriod = {
  open?: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
};

type PlaceCandidate = {
  provider: "google";
  provider_place_id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  price_band: string;
  opening_hours: unknown;
  maps_url: string | null;
  official_url: string | null;
  business_status: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// Googleのplace typesを、Mikkeのplace_category enumにベストエフォートで変換する。
// 完全な対応表ではないため、フロントエンド側でユーザーが保存前に修正できるようにする前提。
const CATEGORY_RULES: Array<{ types: string[]; category: string }> = [
  { types: ["bakery"], category: "bakery" },
  { types: ["cafe", "coffee_shop"], category: "cafe" },
  { types: ["spa"], category: "onsen" },
  {
    types: ["tourist_attraction", "museum", "art_gallery", "park", "zoo", "aquarium"],
    category: "sightseeing",
  },
  {
    types: ["amusement_park", "bowling_alley", "movie_theater", "gym", "stadium"],
    category: "activity",
  },
  {
    types: [
      "shopping_mall", "department_store", "clothing_store", "store",
      "supermarket", "convenience_store",
    ],
    category: "shopping",
  },
  { types: ["restaurant", "meal_takeaway", "meal_delivery", "bar", "night_club"], category: "dinner" },
];

function mapCategory(types: string[] | undefined): string {
  if (!types) return "other";
  for (const rule of CATEGORY_RULES) {
    if (types.some((t) => rule.types.includes(t))) return rule.category;
  }
  return "other";
}

function mapPriceBand(priceLevel: string | undefined): string {
  switch (priceLevel) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return "under_1000";
    case "PRICE_LEVEL_MODERATE":
      return "under_3000";
    case "PRICE_LEVEL_EXPENSIVE":
      return "under_5000";
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "under_10000";
    default:
      return "unknown";
  }
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

// Google Places (New) の regularOpeningHours.periods を、
// Mikkeの { timezone, weekly: { monday: [["09:00","18:00"]], ... } } 形式に変換する。
// Googleは営業日の実際のローカル時刻を返すため、日本国内の店舗である前提で
// timezoneは固定でAsia/Tokyoとする（Mikkeは現状、日本国内サービスのため）。
// 日をまたぐ営業時間（例: 22:00-翌02:00）は、そのままだとMikke側の判定関数が
// 「時間帯不明」として扱うため、その日の23:59で打ち切る簡略化を行う。
function buildOpeningHours(periods: GooglePeriod[] | undefined): unknown {
  if (!periods || periods.length === 0) return undefined;
  const weekly: Record<string, string[][]> = {};
  for (const period of periods) {
    if (!period.open) continue;
    const dayName = WEEKDAY_NAMES[period.open.day];
    if (!dayName) continue;
    const start = `${pad2(period.open.hour)}:${pad2(period.open.minute)}`;
    const end = period.close && period.close.day === period.open.day
      ? `${pad2(period.close.hour)}:${pad2(period.close.minute)}`
      : "23:59";
    weekly[dayName] = weekly[dayName] ?? [];
    weekly[dayName].push([start, end]);
  }
  if (Object.keys(weekly).length === 0) return undefined;
  return { timezone: "Asia/Tokyo", weekly };
}

function toCandidate(place: GooglePlace): PlaceCandidate {
  return {
    provider: "google",
    provider_place_id: place.id,
    name: place.displayName?.text ?? "",
    category: mapCategory(place.types),
    address: place.formattedAddress ?? "",
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    price_band: mapPriceBand(place.priceLevel),
    opening_hours: buildOpeningHours(place.regularOpeningHours?.periods),
    maps_url: place.googleMapsUri ?? null,
    official_url: place.websiteUri ?? null,
    business_status: place.businessStatus ?? null,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "authentication_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const googlePlacesApiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!supabaseUrl || !anonKey || !googlePlacesApiKey) {
    return reply(500, { error: "server_configuration_missing" });
  }

  // ログイン済みユーザーのみに絞る（検索コストの野放図な消費を防ぐ最低限のガード）。
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, { error: "invalid_session" });

  let body: ResolveRequest;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  if (!body.query || typeof body.query !== "string" || body.query.trim().length === 0) {
    return reply(400, { error: "query_required" });
  }

  const requestBody: Record<string, unknown> = {
    textQuery: body.query,
    languageCode: "ja",
    regionCode: "JP",
  };
  if (body.location_bias) {
    requestBody.locationBias = {
      circle: {
        center: {
          latitude: body.location_bias.latitude,
          longitude: body.location_bias.longitude,
        },
        radius: body.location_bias.radius_meters ?? 5000,
      },
    };
  }

  const googleResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googlePlacesApiKey,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.types",
        "places.priceLevel",
        "places.regularOpeningHours",
        "places.googleMapsUri",
        "places.websiteUri",
        "places.businessStatus",
      ].join(","),
    },
    body: JSON.stringify(requestBody),
  });

  if (!googleResponse.ok) {
    const detail = await googleResponse.text();
    return reply(502, { error: "google_places_request_failed", detail: detail.slice(0, 300) });
  }

  const payload = await googleResponse.json();
  const places: GooglePlace[] = Array.isArray(payload.places) ? payload.places : [];
  const candidates = places.slice(0, 5).map(toCandidate);

  return reply(200, { candidates });
});

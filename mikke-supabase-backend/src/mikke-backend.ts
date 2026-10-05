import type { SupabaseClient } from "@supabase/supabase-js";

export type PlaceInput = {
  provider?: string;
  provider_place_id: string;
  name: string;
  category: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  opening_hours?: unknown;
  price_band?: string;
  maps_url?: string | null;
  official_url?: string | null;
  data_checked_at?: string | null;
};

export type SourceInput = {
  source_platform: string;
  source_url: string;
  source_caption?: string | null;
  user_note?: string | null;
  extraction_confidence?: number | null;
  confirmed_at?: string;
  last_refreshed_at?: string | null;
};

export async function savePlace(client: SupabaseClient, place: PlaceInput, source: SourceInput) {
  const { data, error } = await client.rpc("save_place", { p_place: place, p_source: source });
  if (error) throw error;
  return data;
}

export async function removeSavedPlace(client: SupabaseClient, savedPlaceId: string) {
  const { error } = await client.from("saved_places").delete().eq("id", savedPlaceId);
  if (error) throw error;
}

export async function acceptPlan(client: SupabaseClient, planId: string) {
  const { data, error } = await client.rpc("accept_plan", { p_plan_id: planId });
  if (error) throw error;
  return data;
}

export async function answerVisit(
  client: SupabaseClient,
  input: {
    planId: string;
    went: boolean;
    rating?: "good" | "normal" | "poor" | null;
    reasonNotWent?: string | null;
    visitedPlaceIds?: string[];
  },
) {
  const { data, error } = await client.rpc("answer_visit", {
    p_plan_id: input.planId,
    p_went: input.went,
    p_rating: input.rating ?? null,
    p_reason_not_went: input.reasonNotWent ?? null,
    p_visited_place_ids: input.visitedPlaceIds ?? [],
  });
  if (error) throw error;
  return data;
}

// eventId を渡すと、同じIDの再送はサーバー側で1件にまとめられる（二重計上防止）。
export async function trackEvent(
  client: SupabaseClient,
  name: string,
  properties: Record<string, unknown> = {},
  eventId?: string,
) {
  const { data, error } = await client.rpc("track_event", {
    p_name: name,
    p_properties: properties,
    ...(eventId ? { p_event_id: eventId } : {}),
  });
  if (error) throw error;
  return data;
}

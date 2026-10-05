/**
 * spot-sync を React から使うフックと操作（いいね / 行きたい）。
 * 行きたいは保存した場所（saved_places）なので、変わったら保存一覧・プラン作成の保存場所も次に開いたとき取り直す。
 */
import { useSyncExternalStore } from 'react';

import { registerUserCacheReset } from '@/auth/session-store';
import { callApi } from '@/lib/use-api-resource';
import { markSavedPlacesChanged } from '@/place/saved-places-client';

import { createSpotSync, toggleSpotReaction, withSpotOverride, type SpotState } from './spot-sync';
import { setPlaceReaction } from './spots-client';

const store = createSpotSync();
registerUserCacheReset(store.reset);

export const spotSync = store;

export function useSpotSync() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** 1件の表示に、ほかの画面で押した結果を重ねる */
export function useSpotState<T extends Partial<SpotState>>(item: T, placeId: string | null | undefined): T & { pendingLike: boolean; pendingWish: boolean } {
  const s = useSpotSync();
  const merged = withSpotOverride(item, placeId, s.overrides);
  return { ...merged, pendingLike: !!(placeId && s.pending[`${placeId}:like`]), pendingWish: !!(placeId && s.pending[`${placeId}:wish`]) };
}

export function useSpotList<T extends SpotState & { id: string }>(items: T[] | null): T[] {
  const s = useSpotSync();
  return (items ?? []).map((i) => withSpotOverride(i, i.id, s.overrides));
}

export async function toggleSpot(placeId: string, kind: 'like' | 'wish', current: SpotState): Promise<string | null> {
  return toggleSpotReaction(store, placeId, kind, current, async (active) => {
    const r = await callApi((opts) => setPlaceReaction(placeId, kind, active, opts));
    if (r.ok && kind === 'wish') markSavedPlacesChanged();
    return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message };
  });
}

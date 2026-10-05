/**
 * route-sync（画面をまたいだ反応・一覧の世代・検索条件）を React から使うフックと操作。
 */
import { useSyncExternalStore } from 'react';

import { registerUserCacheReset } from '@/auth/session-store';
import { callApi } from '@/lib/use-api-resource';

import { toggleRouteReaction, type RouteCard } from './route-posts-client';
import { createRouteSync, optimisticToggle, withOverride, type ReactionOverride } from './route-sync';

const store = createRouteSync();
registerUserCacheReset(store.reset);

export const routeSync = store;

export function useRouteSync() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** 一覧のカードに、他の画面で押した反応を重ねる */
export function useCardsWithOverrides<T extends RouteCard>(cards: T[] | null): T[] {
  const { overrides } = useRouteSync();
  return (cards ?? []).map((c) => withOverride(c, overrides));
}

const pending = new Set<string>();

/**
 * いいね / 行きたい を切り替える（一押しで登録、もう一度で解除）。
 * すぐに表示を変え、サーバーの件数で確定する。失敗したら元に戻す
 */
export async function toggleReaction(card: ReactionOverride & { id: string }, kind: 'like' | 'wish'): Promise<string | null> {
  const key = `${card.id}:${kind}`;
  if (pending.has(key)) return null; // 連打で二重に送らない
  pending.add(key);
  const before: ReactionOverride = { liked: card.liked, likeCount: card.likeCount, wished: card.wished, wishCount: card.wishCount };
  store.setReaction(card.id, optimisticToggle(before, kind));
  try {
    // 押した時点の表示から決めた状態を送る（二重送信・別端末との競合でも結果が同じ）
    const target = kind === 'like' ? !before.liked : !before.wished;
    const r = await callApi((opts) => toggleRouteReaction(card.id, kind, opts, target));
    if (!r.ok) {
      store.setReaction(card.id, before);
      return r.message;
    }
    const current = store.getState().overrides[card.id] ?? before;
    store.setReaction(card.id, {
      ...current,
      likeCount: r.data.likeCount,
      wishCount: r.data.wishCount,
      ...(kind === 'like' ? { liked: r.data.active } : { wished: r.data.active }),
    });
    if (kind === 'wish') store.bump('wishes');
    return null;
  } finally {
    pending.delete(key);
  }
}

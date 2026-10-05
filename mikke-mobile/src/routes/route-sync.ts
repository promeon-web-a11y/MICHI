/**
 * 画面をまたいだ「みんなのルート」の状態（React に依存しない。Node で単体テスト）。
 *
 * - 反応の上書き: 詳細でいいね・行きたいを押したら、一覧・ホーム・保存一覧のカードにもすぐ反映する
 * - 変更の世代: 記録・投稿・行きたいが変わったら、その一覧を次に開いたとき取り直す
 * - みつけるの検索条件: ホームのジャンルから開いたときの条件や、詳細から戻ったときの条件を保つ
 *   （対象の切り替え「みんなのルート / お店・スポット」とスポットの検索条件も同じ）
 */
import { DEFAULT_FEED_QUERY, type RouteCard, type RouteFeedQuery } from './route-posts-client';

export type ReactionOverride = Pick<RouteCard, 'liked' | 'likeCount' | 'wished' | 'wishCount'>;
export type SyncChannel = 'myPosts' | 'wishes' | 'feed';

export type DiscoverType = 'routes' | 'spots';
export type SpotQuery = { query: string; category: string | null };
export const DEFAULT_SPOT_QUERY: SpotQuery = { query: '', category: null };

export type RouteSyncState = {
  overrides: Record<string, ReactionOverride>;
  versions: Record<SyncChannel, number>;
  feedQuery: RouteFeedQuery;
  filtersOpen: boolean;
  discoverType: DiscoverType;
  spotQuery: SpotQuery;
};

export const INITIAL_ROUTE_SYNC: RouteSyncState = {
  overrides: {},
  versions: { myPosts: 0, wishes: 0, feed: 0 },
  feedQuery: DEFAULT_FEED_QUERY,
  filtersOpen: false,
  discoverType: 'routes',
  spotQuery: DEFAULT_SPOT_QUERY,
};

export function createRouteSync() {
  let state: RouteSyncState = INITIAL_ROUTE_SYNC;
  const listeners = new Set<() => void>();
  const set = (next: RouteSyncState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setReaction(id: string, value: ReactionOverride) {
      set({ ...state, overrides: { ...state.overrides, [id]: value } });
    },
    bump(...channels: SyncChannel[]) {
      const versions = { ...state.versions };
      channels.forEach((c) => (versions[c] += 1));
      set({ ...state, versions });
    },
    setFeedQuery(patch: Partial<RouteFeedQuery>) {
      set({ ...state, feedQuery: { ...state.feedQuery, ...patch } });
    },
    setFiltersOpen(open: boolean) {
      set({ ...state, filtersOpen: open });
    },
    setDiscoverType(discoverType: DiscoverType) {
      set({ ...state, discoverType });
    },
    setSpotQuery(patch: Partial<SpotQuery>) {
      set({ ...state, spotQuery: { ...state.spotQuery, ...patch } });
    },
    /** ログアウト・アカウント削除時 */
    reset() {
      set(INITIAL_ROUTE_SYNC);
    },
  };
}

/** カードに上書きを重ねる（上書きが無ければそのまま） */
export function withOverride<T extends RouteCard>(card: T, overrides: Record<string, ReactionOverride>): T {
  const o = overrides[card.id];
  return o ? { ...card, ...o } : card;
}

/** 楽観的な切り替え（サーバーの結果が返るまでの表示） */
export function optimisticToggle(card: ReactionOverride, kind: 'like' | 'wish'): ReactionOverride {
  if (kind === 'like') {
    return { ...card, liked: !card.liked, likeCount: Math.max(0, card.likeCount + (card.liked ? -1 : 1)) };
  }
  return { ...card, wished: !card.wished, wishCount: Math.max(0, card.wishCount + (card.wished ? -1 : 1)) };
}

/** 詳細設定が既定から変わっている数（「詳細設定」ボタンの表示用） */
export function activeFilterCount(q: RouteFeedQuery): number {
  return [q.area, q.maxBudget, q.genre, q.theme].filter((v) => v !== null).length;
}

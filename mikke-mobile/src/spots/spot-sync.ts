/**
 * スポットの いいね / 行きたい を画面をまたいで同じ状態にする（React に依存しない部分は Node で単体テスト）。
 *
 * - 一覧・スポット詳細・ルート詳細の立ち寄り・保存一覧のどこで押しても、同じ場所（place ID）の表示がすぐに変わる
 * - 押した時点の表示から決めた状態をサーバーへ送り、応答の実数で確定する。失敗したら元に戻す
 * - 同じ場所・同じ種類を通信中にもう一度押しても二重に送らない
 */
export type SpotState = { liked: boolean; wished: boolean; likeCount: number };
export type SpotSyncChannel = 'likes' | 'spots';

export type SpotSyncState = {
  overrides: Record<string, Partial<SpotState>>;
  pending: Record<string, true>;
  versions: Record<SpotSyncChannel, number>;
};

export const INITIAL_SPOT_SYNC: SpotSyncState = { overrides: {}, pending: {}, versions: { likes: 0, spots: 0 } };

export function createSpotSync() {
  let state: SpotSyncState = INITIAL_SPOT_SYNC;
  const listeners = new Set<() => void>();
  const set = (next: SpotSyncState) => {
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
    setOverride(placeId: string, value: Partial<SpotState>) {
      set({ ...state, overrides: { ...state.overrides, [placeId]: { ...state.overrides[placeId], ...value } } });
    },
    setPending(key: string, on: boolean) {
      const pending = { ...state.pending };
      if (on) pending[key] = true;
      else delete pending[key];
      set({ ...state, pending });
    },
    bump(...channels: SpotSyncChannel[]) {
      const versions = { ...state.versions };
      channels.forEach((c) => (versions[c] += 1));
      set({ ...state, versions });
    },
    reset() {
      set(INITIAL_SPOT_SYNC);
    },
  };
}

export type SpotSync = ReturnType<typeof createSpotSync>;

/** 表示中の値に、ほかの画面で押した結果を重ねる */
export function withSpotOverride<T extends Partial<SpotState>>(item: T, placeId: string | null | undefined, overrides: SpotSyncState['overrides']): T {
  const o = placeId ? overrides[placeId] : undefined;
  return o ? { ...item, ...o } : item;
}

export const pendingKey = (placeId: string, kind: 'like' | 'wish') => `${placeId}:${kind}`;

/**
 * いいね / 行きたい を切り替える。current は押した時点の表示。
 * send はサーバーへ状態を送る関数（失敗は message を返す）。戻り値: エラーの文言（成功は null）
 */
export async function toggleSpotReaction(
  store: SpotSync,
  placeId: string,
  kind: 'like' | 'wish',
  current: SpotState,
  send: (active: boolean) => Promise<{ ok: true; data: SpotState } | { ok: false; message: string }>
): Promise<string | null> {
  const key = pendingKey(placeId, kind);
  if (store.getState().pending[key]) return null;
  const target = kind === 'like' ? !current.liked : !current.wished;
  const optimistic: SpotState =
    kind === 'like'
      ? { ...current, liked: target, likeCount: Math.max(0, current.likeCount + (target ? 1 : -1)) }
      : { ...current, wished: target };
  // 反映するのは押した種類の値だけ（いいね と 行きたい を同時に押したとき、遅い応答が新しい方を上書きしない）
  const pick = (v: SpotState): Partial<SpotState> => (kind === 'like' ? { liked: v.liked, likeCount: v.likeCount } : { wished: v.wished });
  store.setPending(key, true);
  store.setOverride(placeId, pick(optimistic));
  try {
    const r = await send(target);
    if (!r.ok) {
      store.setOverride(placeId, pick(current));
      return r.message;
    }
    store.setOverride(placeId, pick(r.data));
    store.bump(kind === 'like' ? 'likes' : 'spots');
    return null;
  } finally {
    store.setPending(key, false);
  }
}

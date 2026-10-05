/**
 * みんなのルート詳細（2026-09-29 のデザイン参照 detail）。
 * - 上部に表紙写真（画面幅いっぱい・戻る・地域）、タイトル・投稿者・いいね、紹介、所要時間・予算・スポット数
 * - 「この日のルート」: 立ち寄りごとに時刻・名前・行動・大きな写真（縦 4:5 / 横 16:10 を写真に合わせる）・投稿者のコメント・行きたい
 *   写真か名前を押すとその場所（place ID）の詳細へ。そこで いいね / 行きたい。戻ると同じ閲覧位置（このタブの Stack に残る）
 * - 立ち寄りの「行きたい」= 保存した場所。ルート全体の「保存」（route_wishes）とは別の状態
 * - このルートで行く（start_route_from_post で採用済みプラン → 今日のルート）、今日向けに調整
 * - 時刻・写真・コメントは投稿者が入力したものだけ（移動時間・交通手段は作らない）
 * - コメント・自分のコメント削除・通報・ブロック・運営による非表示の表示は従来どおり
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { callApi, useApiResource } from '@/lib/use-api-resource';
import { blockUser } from '@/moderation/moderation-client';
import { ReportSheet, type ReportTarget } from '@/moderation/report-sheet';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { budgetText, dateText, durationText } from '@/routes/route-format';
import {
  addRouteComment,
  deleteRouteComment,
  getRoutePost,
  MAX_COMMENT_LENGTH,
  startRouteFromPost,
  type RouteComment,
  type RouteDetail,
  type RouteStop,
} from '@/routes/route-posts-client';
import { RoutePhoto, StopPhoto } from '@/routes/route-views';
import { routeSync, toggleReaction, useCardsWithOverrides } from '@/routes/use-route-sync';
import { openSpot, WishButton } from '@/spots/spot-views';
import { invalidateTodayPlan } from '@/today/use-today-plan';
import { Icon } from '@/ui/icon';
import { Avatar, ErrorState, Field, goBack, H2, Loading, Notice, PrimaryButton, SecondaryButton, TextButton, Tiny, Toast, V } from '@/ui/kit';

export default function RouteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useApiResource(id ? `route:${id}` : null, (opts) => getRoutePost(String(id), opts), { staleMs: 15_000 });
  const [merged] = useCardsWithOverrides(detail.data ? [detail.data] : null);
  const [toast, setToast] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  // 通報・ブロックのあと、この投稿を表示しない（サーバーも以後は返さない）
  const [gone, setGone] = useState<string | null>(null);
  const [hiddenComments, setHiddenComments] = useState<Set<string>>(() => new Set());

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 2700);
  };

  if (detail.phase === 'unauthorized') return <SavedPlacesUnauthorized description="ルートを見るにはログインしてください。" />;

  const onReported = (target: ReportTarget, outcome: { blocked: boolean; message: string }) => {
    setReportTarget(null);
    routeSync.bump('feed', 'wishes');
    if (target.kind === 'post') {
      setGone(outcome.message);
      return;
    }
    setHiddenComments((prev) => new Set(prev).add(target.commentId ?? ''));
    // コメントした人をブロックしたら、その人のほかのコメントも消えるように取り直す
    if (outcome.blocked) detail.reload();
    flash(outcome.message);
  };

  const confirmBlock = (target: ReportTarget) =>
    Alert.alert(`${target.authorName}さんをブロックしますか？`, 'お互いの投稿・コメントが表示されなくなり、いいね・コメントもできなくなります。相手に通知はされません。設定の「ブロックしたユーザー」からいつでも解除できます。', [
      { text: 'やめる', style: 'cancel' },
      {
        text: 'ブロックする',
        style: 'destructive',
        onPress: async () => {
          const r = await callApi((opts) => blockUser(target, opts));
          if (!r.ok) return flash(r.message);
          routeSync.bump('feed', 'wishes');
          setGone(`${r.data.name}さんをブロックしました。`);
        },
      },
    ]);

  if (gone || !detail.data || !merged) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.plainTop}>
          <BackButton />
        </View>
        <View style={styles.body}>
          {gone ? (
            <>
              <Notice>{`${gone}\nこの内容はあなたには表示されなくなりました。`}</Notice>
              <SecondaryButton label="みつけるへ戻る" onPress={() => router.navigate('/feed')} style={{ marginTop: 14 }} />
            </>
          ) : detail.phase === 'loading' || detail.phase === 'idle' ? (
            <Loading label="ルートを読み込んでいます…" />
          ) : (
            <ErrorState message={detail.message ?? 'このルートは見られません。公開が終わったか、削除された可能性があります。'} onRetry={detail.reload} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const r = merged as RouteDetail;
  const isPublic = r.visibility === 'public';
  const withPlaces = r.stops.some((s) => s.placeId);

  const startSame = async () => {
    if (starting) return;
    setStarting(true);
    const res = await callApi((opts) => startRouteFromPost(r.id, opts));
    setStarting(false);
    if (!res.ok) return flash(res.message);
    invalidateTodayPlan();
    router.push('/today');
  };

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 36 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View style={styles.hero}>
          <RoutePhoto path={r.coverPhotoPath} style={StyleSheet.absoluteFill} label="代表写真なし" />
          <BackButton overlay />
          {r.area ? (
            <Text style={styles.badge} numberOfLines={1}>
              {r.area}
            </Text>
          ) : null}
        </View>
        <View style={styles.body}>
          <Text style={styles.title} accessibilityRole="header">
            {r.title}
          </Text>
          <View style={styles.authorRow}>
            <Avatar name={r.authorName} size={24} />
            <Text style={styles.author} numberOfLines={2}>
              {r.isMine ? `${r.authorName}（あなた）` : r.authorName} のルート
              {r.visitedOn ? ` · ${dateText(r.visitedOn)}` : ''}
              {isPublic ? '' : ' · 非公開の記録'}
            </Text>
            {isPublic ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: r.liked }}
                accessibilityLabel={`${r.liked ? 'いいねを取り消す' : 'いいね'}（${r.likeCount}件）`}
                hitSlop={6}
                onPress={async () => {
                  const err = await toggleReaction(r, 'like');
                  if (err) flash(err);
                }}
                style={styles.like}>
                <Icon name="heart" size={16} color={r.liked ? '#DC554D' : V.sub} filled={r.liked} />
                <Text style={[styles.likeText, r.liked ? { color: '#B83E37' } : null]}>{r.likeCount}</Text>
              </Pressable>
            ) : null}
          </View>
          {r.lead ? <Text style={styles.copy}>{r.lead}</Text> : null}
          <View style={styles.stats}>
            <Stat icon="clock" text={durationText(r.durationMinutes)} />
            <Stat icon="wallet" text={budgetText(r.budgetYen)} />
            <Stat icon="pin" text={`${r.stops.length}スポット`} />
          </View>
          {r.isMine && r.memory ? <Notice tone="pale">{`記録したときのひと言：${r.memory}`}</Notice> : null}
          {r.isMine && r.hiddenByModeration ? (
            <Notice tone="warn">この投稿は、利用規約に反するおそれがあるため運営により非表示になっています。ほかの人には表示されません。心当たりがない場合は、設定の「ヘルプ・使い方」からお問い合わせください。</Notice>
          ) : null}

          <H2 style={{ marginTop: 6 }}>この日のルート</H2>
          <View style={styles.timeline}>
            {r.stops.map((s, i) => (
              <StopEntry key={s.sequence} stop={s} last={i === r.stops.length - 1} onMessage={flash} />
            ))}
          </View>

          <View style={styles.actions}>
            {isPublic && !r.isMine ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: r.wished }}
                accessibilityLabel={r.wished ? 'ルートの保存を外す' : 'ルートを保存'}
                onPress={async () => {
                  const err = await toggleReaction(r, 'wish');
                  flash(err ?? (r.wished ? 'ルートの保存を外しました' : 'ルートを保存しました。「保存」のルートから確認できます'));
                }}
                style={styles.outline}>
                <Icon name="heart" size={16} color={r.wished ? V.coral : V.ink} filled={r.wished} />
                <Text style={styles.outlineText}>{r.wished ? 'ルート保存済み' : 'ルートを保存'}</Text>
              </Pressable>
            ) : null}
            <PrimaryButton label={starting ? '準備しています…' : 'このルートで行く →'} busy={starting} disabled={!withPlaces} onPress={startSame} style={{ flex: 1.25 }} />
          </View>
          <View style={{ alignItems: 'center' }}>
            <TextButton
              label="時間や予算を今日向けに調整する →"
              onPress={() => (withPlaces ? router.push({ pathname: '/plan', params: { routeId: r.id, routeTitle: r.title } }) : flash('このルートには場所の情報がありません。'))}
            />
          </View>
          <Tiny style={{ textAlign: 'center' }}>店舗・営業時間・移動時間は未確認です。出かける前にご確認ください。</Tiny>

          {r.isMine ? (
            <SecondaryButton label={isPublic ? '投稿を編集する' : '投稿する'} onPress={() => router.push({ pathname: '/compose/[id]', params: { id: r.id } })} style={{ marginTop: 16 }} />
          ) : null}

          {isPublic ? (
            <Comments
              route={r}
              hidden={hiddenComments}
              onChanged={detail.reload}
              flash={flash}
              onReport={(c) => setReportTarget({ kind: 'comment', postId: r.id, commentId: c.id, authorName: c.authorName })}
            />
          ) : null}

          {!r.isMine && isPublic ? (
            <View style={styles.safetyRow}>
              <TextButton label="このルートを通報" color={V.sub} onPress={() => setReportTarget({ kind: 'post', postId: r.id, authorName: r.authorName })} />
              <TextButton label="投稿者をブロック" color={V.sub} onPress={() => confirmBlock({ kind: 'post', postId: r.id, authorName: r.authorName })} />
            </View>
          ) : null}
        </View>
      </ScrollView>
      <Toast message={toast} floating />
      <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} onDone={(o) => reportTarget && onReported(reportTarget, o)} />
    </SafeAreaView>
  );
}

function BackButton({ overlay }: { overlay?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="戻る" hitSlop={6} onPress={() => goBack('/feed')} style={[styles.back, overlay ? styles.backOverlay : null]}>
      <Icon name="arrowLeft" size={20} color="#35251F" />
    </Pressable>
  );
}

function Stat({ icon, text }: { icon: 'pin' | 'clock' | 'wallet'; text: string }) {
  return (
    <View style={styles.stat}>
      <Icon name={icon} size={14} color={V.ink} />
      <Text style={styles.statText}>{text}</Text>
    </View>
  );
}

/** 「この日のルート」の1か所。写真・名前 → その場所の詳細、行きたい は直接押せる */
function StopEntry({ stop, last, onMessage }: { stop: RouteStop; last: boolean; onMessage: (m: string) => void }) {
  const placeId = stop.placeId;
  const head = (
    <>
      <Text style={styles.stopName}>
        {stop.name}
        {placeId ? ' ↗' : ''}
      </Text>
      {stop.action ? <Text style={styles.stopAction}>{stop.action}</Text> : null}
      {stop.photoPath ? (
        <View style={{ marginTop: 11 }}>
          <StopPhoto path={stop.photoPath} accessibilityLabel={`${stop.name}の写真`} />
        </View>
      ) : null}
    </>
  );
  return (
    <View style={styles.stop}>
      {!last ? <View style={styles.stopLine} /> : null}
      <Text style={styles.stopTime}>{stop.visitedTime ?? ''}</Text>
      <View style={styles.stopDot} />
      <View style={styles.stopBody}>
        {placeId ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${stop.name}の詳細を見る`} onPress={() => openSpot(placeId)} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
            {head}
          </Pressable>
        ) : (
          head
        )}
        {stop.note ? <Text style={styles.stopComment}>{stop.note}</Text> : null}
        {placeId ? (
          <View style={{ alignItems: 'flex-start', marginTop: stop.note ? 0 : 10 }}>
            <WishButton placeId={placeId} name={stop.name} size="stop" state={{ liked: false, likeCount: 0, wished: stop.wished }} onResult={onMessage} />
          </View>
        ) : null}
        {!last ? <Text style={styles.next}>↓ 次のスポットへ</Text> : null}
      </View>
    </View>
  );
}

function Comments({
  route,
  hidden,
  onChanged,
  flash,
  onReport,
}: {
  route: RouteDetail;
  hidden: Set<string>;
  onChanged: () => void;
  flash: (m: string) => void;
  onReport: (c: RouteComment) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [added, setAdded] = useState<RouteComment[]>([]);
  const all = [...route.comments, ...added.filter((a) => !route.comments.some((c) => c.id === a.id))].filter((c) => !hidden.has(c.id));

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    const r = await callApi((opts) => addRouteComment(route.id, text, opts));
    setSending(false);
    if (!r.ok) return flash(r.message);
    setText('');
    setAdded((prev) => [...prev, r.data]);
    routeSync.bump('feed');
  };

  const remove = (c: RouteComment) =>
    Alert.alert('コメントを削除しますか？', c.body, [
      { text: 'やめる', style: 'cancel' },
      {
        text: '削除する',
        style: 'destructive',
        onPress: async () => {
          const r = await callApi((opts) => deleteRouteComment(c.id, opts));
          if (!r.ok) return flash(r.message);
          setAdded((prev) => prev.filter((a) => a.id !== c.id));
          onChanged();
        },
      },
    ]);

  return (
    <View style={styles.comments}>
      <H2>コメント {all.length}</H2>
      {all.map((c) => (
        <View key={c.id} style={styles.comment}>
          <Avatar name={c.authorName} />
          <View style={styles.flex}>
            <Text style={styles.commentAuthor}>{c.isMine ? `${c.authorName}（あなた）` : c.authorName}</Text>
            <Text style={styles.commentBody}>{c.body}</Text>
          </View>
          {c.isMine ? (
            <Pressable accessibilityRole="button" accessibilityLabel="自分のコメントを削除" hitSlop={8} onPress={() => remove(c)}>
              <Text style={styles.commentDelete}>削除</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={`${c.authorName}さんのコメントを通報・ブロック`} hitSlop={8} onPress={() => onReport(c)}>
              <Text style={styles.commentDelete}>通報</Text>
            </Pressable>
          )}
        </View>
      ))}
      <View style={styles.commentForm}>
        <Field
          value={text}
          onChangeText={setText}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder="感想をひと言"
          accessibilityLabel="コメント"
          style={styles.flex}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: sending || !text.trim() }} onPress={send} style={[styles.commentSend, !text.trim() ? { opacity: 0.5 } : null]}>
          <Text style={styles.commentSendText}>{sending ? '送信中' : '投稿'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: V.paper },
  plainTop: { paddingHorizontal: 12, paddingVertical: 6 },
  hero: { height: 233, backgroundColor: V.soft },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  backOverlay: { position: 'absolute', top: 12, left: 15, backgroundColor: '#FFFEFAED' },
  badge: { position: 'absolute', bottom: 14, left: 18, maxWidth: '75%', backgroundColor: '#FFFAF5ED', color: '#6F493A', borderRadius: 30, paddingHorizontal: 10, paddingVertical: 5, fontSize: 11, fontWeight: '800', overflow: 'hidden' },
  body: { paddingHorizontal: 20, paddingTop: 17 },
  title: { fontSize: 23, lineHeight: 30, fontWeight: '800', color: V.ink, letterSpacing: -0.6, marginTop: 3, marginBottom: 8 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  author: { flex: 1, fontSize: 12, color: V.sub },
  like: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 48, paddingHorizontal: 8, justifyContent: 'center' },
  likeText: { fontSize: 12, fontWeight: '800', color: V.sub },
  copy: { fontSize: 13, lineHeight: 22, color: V.sub },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 14, marginBottom: 16, paddingVertical: 11, borderTopWidth: 1, borderBottomWidth: 1, borderColor: V.line },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statText: { fontSize: 12, fontWeight: '800', color: V.ink },
  timeline: { marginTop: 19, paddingLeft: 2 },
  stop: { flexDirection: 'row', gap: 6, paddingBottom: 27 },
  stopLine: { position: 'absolute', left: 56, top: 17, bottom: 0, width: 2, backgroundColor: V.line },
  stopTime: { width: 44, fontSize: 11, fontWeight: '800', color: V.ink, paddingTop: 2 },
  stopDot: { width: 13, height: 13, borderRadius: 7, borderWidth: 3, borderColor: V.coral, backgroundColor: V.white, marginTop: 3, marginRight: 5 },
  stopBody: { flex: 1, minWidth: 0 },
  stopName: { fontSize: 15, lineHeight: 21, fontWeight: '800', color: V.ink },
  stopAction: { fontSize: 12, color: V.sub, marginTop: 1 },
  stopComment: { fontSize: 13, lineHeight: 23, color: V.ink, marginTop: 10, marginBottom: 11 },
  next: { fontSize: 11, color: V.deep, marginTop: 14 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6, marginBottom: 6 },
  outline: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  outlineText: { fontSize: 13, fontWeight: '800', color: V.ink },
  comments: { borderTopWidth: 1, borderTopColor: V.line, paddingTop: 17, marginTop: 22 },
  comment: { flexDirection: 'row', gap: 8, marginVertical: 10 },
  commentAuthor: { fontSize: 11, fontWeight: '800', color: V.ink },
  commentBody: { fontSize: 13, lineHeight: 20, color: V.ink },
  commentDelete: { fontSize: 11, color: V.sub, padding: 6 },
  commentForm: { flexDirection: 'row', gap: 7, marginTop: 12 },
  commentSend: { borderRadius: 11, paddingHorizontal: 13, backgroundColor: V.ink, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  commentSendText: { color: V.white, fontSize: 13, fontWeight: '700' },
  safetyRow: { flexDirection: 'row', justifyContent: 'center', gap: 22, borderTopWidth: 1, borderTopColor: V.line, marginTop: 22, paddingTop: 8 },
});

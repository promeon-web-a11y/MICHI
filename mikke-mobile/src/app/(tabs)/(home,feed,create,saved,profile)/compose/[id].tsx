/**
 * v3.0 ルートを投稿する（行った記録の編集と公開）。本人の記録だけ編集できる（update_route_post が auth.uid() で確認）。
 * - ルート名・一日の紹介・（任意）地域・系統・テーマ・使った金額の目安
 * - 立ち寄りごとに 行った時刻・その場所で撮った写真・何をした？・ひと言
 * - 「下書きとして保存」は非公開のまま。「公開する」は確認ダイアログのあとだけ公開（みんなの一覧・自分の投稿に表示）
 * - 写真は縮小して非公開バケットへ。見られるのは公開された投稿を見られる人だけ（署名付きURL）
 * - 保存できなかったときは今回上げた写真を消し、保存後は使われなくなった写真（以前の失敗分を含む）を片付ける
 */
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { apiOptions, callApi, useApiResource } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { useProfile } from '@/profile/use-profile';
import { pickPhoto, uploadRoutePhoto, type PickedPhoto } from '@/routes/photo-upload';
import { ROUTE_BUDGETS, ROUTE_GENRES, ROUTE_THEMES, yen } from '@/routes/route-format';
import {
  cleanupRoutePhotos,
  getRoutePost,
  normalizeTime,
  POST_LIMITS,
  removeRoutePhotos,
  unpublishRoutePost,
  updateRoutePost,
  validateDraft,
  type RouteDetail,
  type RoutePostDraft,
} from '@/routes/route-posts-client';
import { RoutePhoto } from '@/routes/route-views';
import { routeSync } from '@/routes/use-route-sync';
import { BackLink, ChoiceRow, ErrorState, Field, FormGroup, H1, H2, Loading, Muted, Notice, PrimaryButton, Screen, SecondaryButton, TextButton, V } from '@/ui/kit';

type StopDraft = { sequence: number; name: string; time: string; action: string; note: string; photoPath: string | null; picked: PickedPhoto | null };

export default function ComposeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = useApiResource(id ? `compose:${id}` : null, (opts) => getRoutePost(String(id), opts), { staleMs: 60 * 60_000 });
  if (post.phase === 'unauthorized') return <SavedPlacesUnauthorized description="投稿するにはログインしてください。" />;
  return (
    <Screen>
      <BackLink />
      {post.phase === 'loading' || post.phase === 'idle' ? (
        <Loading />
      ) : !post.data || !post.data.isMine ? (
        <ErrorState message={post.data ? '自分の記録だけ編集できます。' : post.message} onRetry={post.reload} />
      ) : (
        <Editor route={post.data} />
      )}
    </Screen>
  );
}

function Editor({ route }: { route: RouteDetail }) {
  const { profile } = useProfile();
  const [title, setTitle] = useState(route.title);
  const [lead, setLead] = useState(route.lead ?? '');
  // 未入力なら よく行く地域 を初期値に
  const [area, setArea] = useState(route.area ?? profile?.homeArea ?? '');
  const [genre, setGenre] = useState<string | null>(route.genre);
  const [theme, setTheme] = useState<string | null>(route.theme);
  const [budget, setBudget] = useState<number | null>(route.budgetYen);
  const [stops, setStops] = useState<StopDraft[]>(() =>
    route.stops.map((s) => ({ sequence: s.sequence, name: s.name, time: s.visitedTime ?? '', action: s.action ?? '', note: s.note ?? '', photoPath: s.photoPath, picked: null }))
  );
  const [busy, setBusy] = useState<'draft' | 'publish' | 'unpublish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPublic = route.visibility === 'public';

  const update = (seq: number, patch: Partial<StopDraft>) => setStops((prev) => prev.map((s) => (s.sequence === seq ? { ...s, ...patch } : s)));

  const choosePhoto = async (seq: number) => {
    try {
      const photo = await pickPhoto();
      if (photo) update(seq, { picked: photo });
    } catch {
      setError('写真を読み込めませんでした。別の写真を選んでください。');
    }
  };

  const buildDraft = (): RoutePostDraft | string => {
    const normalized = stops.map((s) => ({ ...s, t: normalizeTime(s.time) }));
    const bad = normalized.find((s) => s.t === undefined);
    if (bad) return `「${bad.name}」の時刻は 10:30 のように入力してください。`;
    return {
      title,
      lead,
      area,
      genre,
      theme,
      budgetYen: budget,
      stops: normalized.map((s) => ({ sequence: s.sequence, visitedTime: s.t ?? null, action: s.action, note: s.note, photoPath: s.photoPath })),
    };
  };

  const save = async (publish: boolean) => {
    if (busy) return;
    const draft = buildDraft();
    if (typeof draft === 'string') return setError(draft);
    const invalid = validateDraft(draft);
    if (invalid) return setError(invalid);
    setError(null);
    setBusy(publish ? 'publish' : 'draft');
    // 今回アップロードした写真。保存まで進めなかったら消す（2枚目で失敗したときの1枚目も含む）
    const uploaded = new Map<number, string>();
    let saved = false;
    try {
      // 1. 新しく選んだ写真をアップロード
      for (const s of stops) {
        if (s.picked) uploaded.set(s.sequence, await uploadRoutePhoto(s.picked, route.id, apiOptions()));
      }
      const finalDraft: RoutePostDraft = {
        ...draft,
        stops: draft.stops.map((s) => ({ ...s, photoPath: uploaded.get(s.sequence) ?? s.photoPath })),
      };
      // 2. 保存（公開は publish = true のときだけ）
      const r = await callApi((opts) => updateRoutePost(route.id, finalDraft, publish || isPublic, opts));
      if (!r.ok) return setError(r.message);
      saved = true;
      // 3. 差し替え・外した写真を消す。あわせて、以前に保存できなかったアップロードなどもサーバーの一覧で片付ける
      const used = new Set(finalDraft.stops.map((s) => s.photoPath).filter(Boolean));
      const unused = route.stops.map((s) => s.photoPath).filter((p): p is string => !!p && !used.has(p));
      void removeRoutePhotos(unused, apiOptions()).then(() => cleanupRoutePhotos(route.id, apiOptions()));
      setStops((prev) => prev.map((s) => ({ ...s, picked: null, photoPath: uploaded.get(s.sequence) ?? s.photoPath })));
      routeSync.bump('myPosts', 'feed');
      if (publish || isPublic) router.replace({ pathname: '/routes/[id]', params: { id: route.id } });
      else router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存できませんでした。');
    } finally {
      // どこからも使われない写真を残さない（消せなくても非公開バケットのため他人には見えず、次回の片付けで消える）
      if (!saved && uploaded.size > 0) void removeRoutePhotos([...uploaded.values()], apiOptions());
      setBusy(null);
    }
  };

  const confirmPublish = () =>
    Alert.alert(
      'みんなのルートに公開しますか？',
      'ルート名・紹介・立ち寄り先・時刻・写真・ひと言が、Mikke を使うほかの人に表示されます。記録したときのひと言は公開されません。あとから非公開に戻せます。',
      [
        { text: 'やめる', style: 'cancel' },
        { text: '公開する', onPress: () => void save(true) },
      ]
    );

  const confirmUnpublish = () =>
    Alert.alert('公開をやめますか？', 'みんなのルートに表示されなくなり、非公開の記録に戻ります。', [
      { text: 'やめる', style: 'cancel' },
      {
        text: '非公開にする',
        style: 'destructive',
        onPress: async () => {
          setBusy('unpublish');
          const r = await callApi((opts) => unpublishRoutePost(route.id, opts));
          setBusy(null);
          if (!r.ok) return setError(r.message);
          routeSync.bump('myPosts', 'feed');
          router.back();
        },
      },
    ]);

  return (
    <>
      <H1>{isPublic ? '投稿を編集する' : 'ルートを投稿する'}</H1>
      <Muted>行った場所ごとに、時刻・写真・ひと言を残せます。すべて任意です。</Muted>
      {route.memory ? <Notice tone="pale">{`記録したときのひと言（非公開）：${route.memory}`}</Notice> : null}
      {route.hiddenByModeration ? <Notice tone="warn">この投稿は運営により非表示になっています。編集しても、ほかの人には表示されません。</Notice> : null}

      <FormGroup label="ルートの名前">
        <Field value={title} onChangeText={setTitle} maxLength={POST_LIMITS.title} placeholder="例：秋のカフェ散歩" accessibilityLabel="ルートの名前" />
      </FormGroup>
      <FormGroup label="一日の紹介（任意）">
        <Field multiline value={lead} onChangeText={setLead} maxLength={POST_LIMITS.lead} placeholder="どんな一日だった？" accessibilityLabel="一日の紹介" />
      </FormGroup>

      <FormGroup label="地域（任意）" note="みんなのルートの「地域」で探すときに使われます。">
        <Field value={area} onChangeText={setArea} maxLength={POST_LIMITS.area} placeholder="例：円山" accessibilityLabel="地域" />
      </FormGroup>
      <FormGroup label="系統（任意）">
        <ChoiceRow allowClear value={genre} onChange={setGenre} options={ROUTE_GENRES.map((g) => ({ value: g, label: g }))} />
      </FormGroup>
      <FormGroup label="テーマ（任意）">
        <ChoiceRow allowClear value={theme} onChange={setTheme} options={ROUTE_THEMES.map((t) => ({ value: t, label: t }))} />
      </FormGroup>
      <FormGroup label="使った金額の目安（任意・1人あたり）">
        <ChoiceRow allowClear value={budget} onChange={setBudget} options={ROUTE_BUDGETS.map((b) => ({ value: b, label: `〜${yen(b)}` }))} />
      </FormGroup>

      {stops.map((s) => (
        <View key={s.sequence} style={styles.stop}>
          <H2 style={{ fontSize: 14, marginBottom: 2 }}>
            {s.sequence}. {s.name}
          </H2>
          <FormGroup label="行った時刻（任意）">
            <Field
              value={s.time}
              onChangeText={(t) => update(s.sequence, { time: t })}
              placeholder="10:30"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              accessibilityLabel={`${s.name}に行った時刻`}
              invalid={normalizeTime(s.time) === undefined}
            />
          </FormGroup>
          <FormGroup label="その場所で撮った写真（任意）">
            {s.picked ? (
              <Image source={{ uri: s.picked.uri }} style={styles.photo} contentFit="cover" accessibilityLabel={`${s.name}の写真（未保存）`} />
            ) : s.photoPath ? (
              <RoutePhoto path={s.photoPath} style={styles.photo} />
            ) : null}
            <View style={styles.photoActions}>
              <SecondaryButton label={s.picked || s.photoPath ? '写真を変える' : '写真を選ぶ'} onPress={() => choosePhoto(s.sequence)} style={{ flex: 1 }} />
              {s.picked || s.photoPath ? <TextButton label="写真を外す" color={V.sub} onPress={() => update(s.sequence, { picked: null, photoPath: null })} /> : null}
            </View>
          </FormGroup>
          <FormGroup label="何をした？（任意）">
            <Field
              value={s.action}
              onChangeText={(t) => update(s.sequence, { action: t })}
              maxLength={POST_LIMITS.action}
              placeholder="例：ケーキを食べた"
              accessibilityLabel={`${s.name}で何をした`}
            />
          </FormGroup>
          <FormGroup label="ひと言（任意）">
            <Field
              multiline
              value={s.note}
              onChangeText={(t) => update(s.sequence, { note: t })}
              maxLength={POST_LIMITS.note}
              placeholder="例：おいしかった！"
              accessibilityLabel={`${s.name}のひと言`}
            />
          </FormGroup>
        </View>
      ))}

      <Notice>
        {isPublic
          ? '更新すると、みんなのルートの表示も変わります。写真は、この投稿を見られる人にだけ表示されます。'
          : '「公開する」を押すまで、ほかの人には表示されません。設定の「投稿の表示」で、自分の投稿をみんなの一覧から隠すこともできます。'}
      </Notice>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <View style={{ gap: 10 }}>
        {isPublic ? (
          <>
            <PrimaryButton label="更新する" busy={busy === 'publish' || busy === 'draft'} disabled={!!busy} onPress={() => void save(false)} />
            <SecondaryButton label={busy === 'unpublish' ? '処理中…' : '公開をやめる'} disabled={!!busy} onPress={confirmUnpublish} />
          </>
        ) : (
          <>
            <PrimaryButton label="公開する" busy={busy === 'publish'} disabled={!!busy} onPress={confirmPublish} />
            <SecondaryButton label={busy === 'draft' ? '保存しています…' : '下書きとして保存（非公開）'} disabled={!!busy} onPress={() => void save(false)} />
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  stop: { padding: 13, borderRadius: 13, backgroundColor: V.paper, marginTop: 16 },
  photo: { height: 150, borderRadius: 12, marginBottom: 8 },
  photoActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});

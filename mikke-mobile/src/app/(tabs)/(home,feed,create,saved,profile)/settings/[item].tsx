/**
 * v3.0 設定の詳細: プロフィール（表示名）/ よく行く地域 / 通知 / 投稿の表示 / ブロックしたユーザー / ヘルプ・使い方。
 * 保存先は public.users（display_name / home_area は既存列、ほかは 202609280008 で追加）。
 * 通知は配信の仕組みがまだ無いため、希望だけを保存し「配信は準備中」と明示する。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { callApi, useAccessToken, useApiResource } from '@/lib/use-api-resource';
import { listBlockedUsers, unblockUser, type BlockedUser } from '@/moderation/moderation-client';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { AREA_PRESETS, DISPLAY_NAME_MAX, HOME_AREA_MAX, type ProfilePatch } from '@/profile/profile-client';
import { dateText } from '@/routes/route-format';
import { routeSync } from '@/routes/use-route-sync';
import { saveProfile, useProfile } from '@/profile/use-profile';
import { Icon } from '@/ui/icon';
import {
  BackLink,
  Field,
  FormGroup,
  H1,
  Loading,
  Muted,
  Notice,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SettingsGroup,
  Toast,
  ToggleRow,
  V,
} from '@/ui/kit';

const TITLES: Record<string, string> = {
  account: 'プロフィール',
  area: 'よく行く地域',
  notifications: '通知',
  privacy: '投稿の表示',
  blocked: 'ブロックしたユーザー',
  help: 'ヘルプ・使い方',
};

export default function SettingDetailScreen() {
  const { item } = useLocalSearchParams<{ item: string }>();
  const token = useAccessToken();
  const { profile, phase } = useProfile();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!token) return <SavedPlacesUnauthorized description="設定を変えるにはログインしてください。" />;
  const title = TITLES[item ?? ''] ?? '設定';

  const save = async (patch: ProfilePatch, done: string) => {
    setError(null);
    const err = await saveProfile(patch);
    if (err) setError(err);
    else setToast(done);
    return !err;
  };

  let body: React.ReactNode;
  if (item === 'help') body = <Help />;
  else if (item === 'blocked') body = <BlockedUsers onToast={setToast} onError={setError} />;
  else if (!profile) body = phase === 'error' ? <Notice tone="warn">設定を読み込めませんでした。通信環境を確認してください。</Notice> : <Loading />;
  else if (item === 'account') body = <AccountForm initial={profile.displayName ?? ''} onSave={(v) => save({ displayName: v }, '表示名を保存しました')} />;
  else if (item === 'area') body = <AreaForm current={profile.homeArea} onSave={(v) => save({ homeArea: v }, 'よく行く地域を保存しました')} />;
  else if (item === 'notifications') {
    body = (
      <>
        <ToggleRow
          title="週末のお出かけ提案"
          note="新しいルートのおすすめ"
          value={profile.notifyWeekendHints}
          onChange={(v) => void save({ notifyWeekendHints: v }, '保存しました')}
        />
        <ToggleRow
          title="保存したルートの更新"
          note="気になるルートのお知らせ"
          value={profile.notifySavedUpdates}
          onChange={(v) => void save({ notifySavedUpdates: v }, '保存しました')}
        />
        <Notice>通知の配信はまだ準備中です。いまは希望だけを保存し、配信が始まったらこの設定に従ってお知らせします。</Notice>
      </>
    );
  } else if (item === 'privacy') {
    body = (
      <>
        <ToggleRow
          title="自分の投稿を「みんな」に表示"
          note="オフにすると、公開した投稿もみんなの一覧・詳細に表示されません"
          value={profile.showPostsInFeed}
          onChange={(v) => void save({ showPostsInFeed: v }, v ? 'みんなに表示します' : 'みんなの一覧に出さないようにしました')}
        />
        <Notice>投稿ごとに公開・非公開を切り替えることもできます（投稿の編集 →「公開をやめる」）。非公開の記録はいつでも自分だけが見られます。</Notice>
        <SecondaryButton label="自分の投稿を見る →" onPress={() => router.push('/my-posts')} />
      </>
    );
  } else body = <Notice>この設定は見つかりませんでした。</Notice>;

  return (
    <Screen>
      <BackLink label={item === 'help' ? '戻る' : '設定へ'} fallback="/settings" />
      <H1>{title}</H1>
      <Toast message={toast} />
      {error ? <Notice tone="warn">{error}</Notice> : null}
      {body}
    </Screen>
  );
}

function BlockedUsers({ onToast, onError }: { onToast: (m: string) => void; onError: (m: string | null) => void }) {
  const list = useApiResource('blocked-users', listBlockedUsers, { staleMs: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const unblock = async (u: BlockedUser) => {
    if (busy) return;
    setBusy(u.id);
    onError(null);
    const r = await callApi((opts) => unblockUser(u.id, opts));
    setBusy(null);
    if (!r.ok) return onError(r.message);
    routeSync.bump('feed', 'wishes');
    list.reload();
    onToast(`${u.name}さんのブロックを解除しました`);
  };
  if (list.phase === 'loading' || list.phase === 'idle') return <Loading />;
  if (!list.data) return <Notice tone="warn">{list.message ?? '読み込めませんでした。'}</Notice>;
  return (
    <>
      <Muted style={{ marginVertical: 12 }}>ブロックした人とは、お互いの投稿・コメントが表示されず、いいね・コメントもできません。相手に通知はされません。</Muted>
      {list.data.length === 0 ? (
        <Notice>ブロックしているユーザーはいません。ルートの詳細やコメントの「通報」からブロックできます。</Notice>
      ) : (
        <View style={styles.list}>
          {list.data.map((u, i) => (
            <View key={u.id} style={[styles.row, i === list.data!.length - 1 ? { borderBottomWidth: 0 } : null]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{u.name}</Text>
                {u.blockedAt ? <Text style={styles.rowSub}>{`${dateText(u.blockedAt.slice(0, 10))}にブロック`}</Text> : null}
              </View>
              <SecondaryButton label={busy === u.id ? '解除中…' : '解除'} disabled={!!busy} onPress={() => void unblock(u)} style={{ minHeight: 40, paddingHorizontal: 14 }} />
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function AccountForm({ initial, onSave }: { initial: string; onSave: (v: string) => Promise<boolean> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <FormGroup label="表示名" note={`${DISPLAY_NAME_MAX}文字まで。公開した投稿・コメントに表示されます。`}>
        <Field value={name} onChangeText={setName} maxLength={DISPLAY_NAME_MAX} placeholder="例：さっぽろ散歩" accessibilityLabel="表示名" />
      </FormGroup>
      <PrimaryButton
        label="保存する"
        busy={busy}
        style={{ marginTop: 21 }}
        onPress={async () => {
          setBusy(true);
          await onSave(name);
          setBusy(false);
        }}
      />
    </>
  );
}

function AreaForm({ current, onSave }: { current: string | null; onSave: (v: string) => Promise<boolean> }) {
  const [custom, setCustom] = useState(current && !(AREA_PRESETS as readonly string[]).includes(current) ? current : '');
  return (
    <>
      <Muted style={{ marginVertical: 12 }}>ホームと画面右上に表示する地域です。投稿の地域の初期値にも使います。</Muted>
      <View style={styles.list}>
        {AREA_PRESETS.map((a, i) => {
          const on = current === a;
          return (
            <Pressable
              key={a}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => void onSave(a)}
              style={[styles.row, i === AREA_PRESETS.length - 1 ? { borderBottomWidth: 0 } : null]}>
              <Text style={styles.rowText}>{a}</Text>
              {on ? <Icon name="check" size={16} color={V.deep} /> : null}
            </Pressable>
          );
        })}
      </View>
      <SettingsGroup>ほかの地域</SettingsGroup>
      <Field value={custom} onChangeText={setCustom} maxLength={HOME_AREA_MAX} placeholder="例：小樽" accessibilityLabel="ほかの地域" />
      <SecondaryButton label="この地域にする" disabled={!custom.trim()} onPress={() => void onSave(custom)} style={{ marginTop: 10 }} />
    </>
  );
}

const FAQ = [
  ['ルートを作るには？', 'ホームで使える時間・予算を選んで「ルートを見つける」を押してください。画面下の＋からも始められます。提案は、あなたが保存した場所から作ります。'],
  ['場所を保存するには？', 'Instagram や TikTok などの投稿の「共有」から Mikke を選ぶか、保存一覧の「＋ 場所を追加」に投稿の URL を入力してください。'],
  ['行った記録を投稿するには？', '今日のルートの「お出かけを記録」で行った場所を選んで保存します（非公開）。保存一覧の「行った記録」から、時刻・写真・ひと言を付けて公開できます。'],
  ['保存したルートはどこで見られる？', '画面下の「保存」を開き、「行きたい」を選ぶと、みんなのルートで「行きたい」を押したルートが見られます。'],
  ['不快な投稿・コメントを見つけたら', 'ルートの詳細の下にある「このルートを通報」、またはコメントの「通報」から運営に知らせてください。通報した内容はあなたには表示されなくなり、運営が確認して、規約に反する場合は非表示などの対応をします。相手に通知はされません。'],
  ['特定の人の投稿を見たくない', '通報画面、またはルートの詳細の「投稿者をブロック」でブロックできます。お互いの投稿・コメントが表示されなくなります。解除は 設定 →「ブロックしたユーザー」から。'],
  ['投稿を非公開にしたい', '投稿の詳細 →「投稿を編集する」→「公開をやめる」で非公開の記録に戻せます。設定の「投稿の表示」をオフにすると、すべての投稿がみんなの一覧に出なくなります。'],
] as const;

function Help() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <SettingsGroup>よくある質問</SettingsGroup>
      {FAQ.map(([q, a], i) => (
        <View key={q} style={styles.faq}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open === i }} onPress={() => setOpen(open === i ? null : i)} style={styles.faqQ}>
            <Text style={styles.faqQText}>{q}</Text>
            <Text style={{ color: V.sub }}>{open === i ? '−' : '＋'}</Text>
          </Pressable>
          {open === i ? <Text style={styles.faqA}>{a}</Text> : null}
        </View>
      ))}
      <SecondaryButton label="お問い合わせ・利用規約など" onPress={() => router.push('/account')} style={{ marginTop: 18 }} />
    </>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderColor: V.line, borderRadius: 15, overflow: 'hidden' },
  row: { minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: V.line },
  rowText: { fontSize: 13, color: V.ink },
  rowSub: { fontSize: 11, color: V.sub, marginTop: 2 },
  faq: { borderBottomWidth: 1, borderBottomColor: V.line },
  faqQ: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 12 },
  faqQText: { fontSize: 12, fontWeight: '700', color: V.ink, flex: 1 },
  faqA: { fontSize: 12, lineHeight: 19, color: V.sub, paddingBottom: 14 },
});

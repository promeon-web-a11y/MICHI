/**
 * v3.0「行きたい場所を保存」（SNSで見つけた投稿の URL から）。
 * 共有メニューからの保存（/handle-share）と同じ処理: identify-place で URL・本文から場所を特定 →
 * 確定なら自動保存 / 候補が複数なら選んで保存（save-place）。入力された名前だけで架空の場所を作らない。
 */
import { router } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import { backendConfig, reportUnauthorized } from '@/auth/session-store';
import { palettes } from '@/constants/theme';
import { apiOptions, useAccessToken } from '@/lib/use-api-resource';
import { appLog } from '@/lib/logger';
import { callIdentifyPlace } from '@/place/identify-place-client';
import { callSavePlace } from '@/place/save-place-client';
import { markSavedPlacesChanged } from '@/place/saved-places-client';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { PillButton } from '@/plan/plan-option-views';
import { createShareFlow, type ShareFlow } from '@/share/share-flow';
import { Busy, Message, PlaceCard, ReviewCandidates } from '@/share/share-flow-view';
import { detectSource, normalizeSharedUrl, parseHttpUrl } from '@/share/url-utils';
import { BackLink, Field, FormGroup, H1, Muted, Notice, PrimaryButton, Screen } from '@/ui/kit';

const c = palettes.light;

function newFlow(): ShareFlow {
  return createShareFlow({
    identify: (request) => callIdentifyPlace(request, { config: backendConfig, accessToken: apiOptions().accessToken }),
    save: (request) => callSavePlace(request, { config: backendConfig, accessToken: apiOptions().accessToken }),
    onSaved: markSavedPlacesChanged,
    onUnauthorized: () => void reportUnauthorized(),
    onDevEvent: (message, detail) => appLog.info(message, detail),
  });
}

export default function AddPlaceScreen() {
  const token = useAccessToken();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [flow, setFlow] = useState<ShareFlow | null>(null);

  if (!token) return <SavedPlacesUnauthorized description="場所を保存するにはログインしてください。" />;

  const start = () => {
    const trimmed = url.trim();
    if (trimmed && !parseHttpUrl(trimmed)) {
      setInputError('投稿の URL（https://…）を確認してください。');
      return;
    }
    if (!trimmed && !text.trim()) {
      setInputError('投稿の URL か、場所の名前・投稿の文章を入力してください。');
      return;
    }
    setInputError(null);
    const f = newFlow();
    setFlow(f);
    const normalized = trimmed ? normalizeSharedUrl(trimmed) : null;
    void f.start({ url: normalized, text: text.trim() || null, source: normalized ? detectSource(normalized) : 'unknown' });
  };

  return (
    <Screen>
      <BackLink />
      <H1>行きたい場所を保存</H1>
      <Muted>SNSで見つけた投稿のリンクから、場所を探して保存します。</Muted>
      {flow ? (
        <FlowStatus flow={flow} onReset={() => setFlow(null)} />
      ) : (
        <>
          <FormGroup label="投稿のURL">
            <Field
              value={url}
              onChangeText={setUrl}
              placeholder="https://..."
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="投稿のURL"
            />
          </FormGroup>
          <FormGroup label="場所の名前・投稿の文章（任意）" note="店名や地域が分かると見つけやすくなります。">
            <Field multiline value={text} onChangeText={setText} maxLength={2000} placeholder="例：円山のカフェ ○○" accessibilityLabel="場所の名前・投稿の文章" />
          </FormGroup>
          <Notice>URL 先のページは読み込みません。入力された URL と文章から場所の候補を探し、見つかった実在の場所だけを保存します。</Notice>
          {inputError ? <Notice tone="warn">{inputError}</Notice> : null}
          <PrimaryButton label="場所を探して保存" onPress={start} />
          <Muted style={{ marginTop: 12 }}>Instagram や TikTok の投稿の「共有」から Mikke を選んでも保存できます。</Muted>
        </>
      )}
    </Screen>
  );
}

function FlowStatus({ flow, onReset }: { flow: ShareFlow; onReset: () => void }) {
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  const toSaved = () => {
    if (router.canDismiss()) router.dismissAll();
    router.navigate({ pathname: '/saved', params: { tab: 'places', notice: 'place' } });
  };
  switch (state.phase) {
    case 'waiting':
    case 'identifying':
      return <Busy c={c} label="投稿から場所を探しています…" hint="数秒〜数十秒かかることがあります" />;
    case 'saving':
      return <Busy c={c} label={`「${state.place.name}」を保存しています…`} />;
    case 'saved':
      return (
        <Message c={c} icon={state.alreadySaved ? '📌' : '🎉'} title={state.alreadySaved ? 'すでに保存されています' : '保存しました'}>
          <PlaceCard c={c} place={state.place} />
          <PillButton c={c} label="保存一覧を見る" primary onPress={toSaved} />
          <PillButton c={c} label="続けて保存する" onPress={onReset} />
        </Message>
      );
    case 'needs_review':
      return (
        <View style={styles.review}>
          <ReviewCandidates c={c} candidates={state.candidates} onChoose={(id) => void flow.choose(id)} onSkip={flow.skip} />
        </View>
      );
    case 'skipped':
      return (
        <Message c={c} icon="👌" title="保存しませんでした">
          <PillButton c={c} label="入力し直す" primary onPress={onReset} />
        </Message>
      );
    case 'no_place':
      return (
        <Message c={c} icon="🔍" title={state.title} body={state.body}>
          <PillButton c={c} label="入力し直す" primary onPress={onReset} />
        </Message>
      );
    case 'failed':
      return (
        <Message c={c} icon="⚠️" title={state.title} body={state.body}>
          <PillButton c={c} label="もう一度試す" primary onPress={() => void flow.retry()} />
          <PillButton c={c} label="入力し直す" onPress={onReset} />
        </Message>
      );
    case 'need_login':
      return <Busy c={c} label="ログイン状態を確認しています…" />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  review: { marginTop: 16 },
});

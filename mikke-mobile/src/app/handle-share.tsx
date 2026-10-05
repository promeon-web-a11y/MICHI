/**
 * 共有受信（Instagram / TikTok などの「共有」→ Mikke）。
 *
 * 流れ: 受信 → 解析 → 場所の特定（自動・1回だけ）→ confirmed は自動保存 / needs_review は候補から選んで保存
 * 処理が終わったら clearSharedPayloads() で端末の共有データを消す（同じ共有を二重に処理しない）。
 * 開発ビルド（__DEV__）では一番下に受信内容と開発ログを表示する。
 */
import { router, type ErrorBoundaryProps } from 'expo-router';
import { useIncomingShare, type ResolvedSharePayload, type SharePayload } from 'expo-sharing';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AuthForm } from '@/auth/auth-form';
import { backendConfig, getDevSession, reportUnauthorized, useAuthStatus, useDevSession } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { buildIdentifyRequest, callIdentifyPlace } from '@/place/identify-place-client';
import { callSavePlace } from '@/place/save-place-client';
import { markSavedPlacesChanged } from '@/place/saved-places-client';
import { PillButton } from '@/plan/plan-option-views';
import { usePlanPalette } from '@/plan/plan-theme';
import { appLog } from '@/lib/logger';
import { processSharePayloads, type ShareAnalysis } from '@/share/process-share-payloads';
import { Field, Json, Section, ShareLogList } from '@/share/share-debug-view';
import { createShareFlow, isShareFlowFinished, type ShareFlow } from '@/share/share-flow';
import { Busy, Message, PlaceCard, ReviewCandidates } from '@/share/share-flow-view';

type Snapshot = { raw: SharePayload[]; resolved: ResolvedSharePayload[]; analysis: ShareAnalysis };

const accessToken = () => {
  const s = getDevSession();
  return isSessionValid(s) ? s.accessToken : null;
};

function newFlow(): ShareFlow {
  return createShareFlow({
    identify: (request) => callIdentifyPlace(request, { config: backendConfig, accessToken: accessToken() }),
    save: (request) => callSavePlace(request, { config: backendConfig, accessToken: accessToken() }),
    onSaved: markSavedPlacesChanged,
    onUnauthorized: () => void reportUnauthorized(),
    onDevEvent: (message, detail) => appLog.info(message, detail),
  });
}

export default function HandleShareScreen() {
  const c = usePlanPalette();
  const session = useDevSession();
  const authStatus = useAuthStatus();
  const signedIn = isSessionValid(session);
  const { sharedPayloads, resolvedSharedPayloads, isResolving, clearSharedPayloads, refreshSharePayloads } = useIncomingShare();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [flow, setFlow] = useState<ShareFlow>(newFlow);
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  const cleared = useRef(false);

  // 新しい共有を受け取ったら解析し、flow を作り直す（解決処理の完了を待つ）
  const hasPayloads = Array.isArray(sharedPayloads) && sharedPayloads.length > 0;
  if (!isResolving && hasPayloads && (snapshot === null || snapshot.raw !== sharedPayloads)) {
    setSnapshot({ raw: sharedPayloads, resolved: resolvedSharedPayloads, analysis: processSharePayloads(sharedPayloads, resolvedSharedPayloads) });
    if (snapshot !== null) setFlow(newFlow());
  }

  // ログイン状態の確認が終わってから、1回だけ自動で特定を始める（flow.start は2回目以降を無視）
  useEffect(() => {
    if (!snapshot || authStatus === 'restoring') return;
    cleared.current = false;
    void flow.start(buildIdentifyRequest(snapshot.analysis));
  }, [flow, snapshot, authStatus]);

  // ログインできたら、止まった手順から再開する
  useEffect(() => {
    if (state.phase === 'need_login' && signedIn) void flow.resumeAfterLogin();
  }, [flow, state.phase, signedIn]);

  // 処理が終わったら端末の共有データを消す（再起動しても同じ共有を再処理しない）
  useEffect(() => {
    if (!isShareFlowFinished(state) || cleared.current) return;
    cleared.current = true;
    try {
      clearSharedPayloads();
      refreshSharePayloads(); // 同じ内容を再共有したときに受け取れるよう内部キャッシュも空にする
    } catch (e) {
      appLog.warn('共有データのクリアに失敗しました', e);
    }
  }, [state, clearSharedPayloads, refreshSharePayloads]);

  const goHome = () => router.replace('/');

  let body: React.ReactNode;
  if (!snapshot) {
    body = isResolving ? (
      <Busy c={c} label="共有された内容を読み込んでいます…" />
    ) : (
      <Message c={c} icon="📮" title="共有された内容はありません" body="Instagram や TikTok などの投稿で「共有」を押し、Mikke を選んでください。">
        <PillButton c={c} label="ホームへ" primary onPress={goHome} />
      </Message>
    );
  } else if (authStatus === 'restoring' || state.phase === 'waiting') {
    body = <Busy c={c} label="準備しています…" />;
  } else {
    switch (state.phase) {
      case 'identifying':
        body = <Busy c={c} label="投稿から場所を探しています…" hint="数秒〜数十秒かかることがあります" />;
        break;
      case 'saving':
        body = <Busy c={c} label={`「${state.place.name}」を保存しています…`} />;
        break;
      case 'saved':
        body = (
          <Message c={c} icon={state.alreadySaved ? '📌' : '🎉'} title={state.alreadySaved ? 'すでに保存されています' : '保存しました'}>
            <PlaceCard c={c} place={state.place} />
            <PillButton c={c} label="保存した場所を見る" primary onPress={() => router.replace('/saved')} />
            <PillButton c={c} label="ホームへ" onPress={goHome} />
          </Message>
        );
        break;
      case 'needs_review':
        body = <ReviewCandidates c={c} candidates={state.candidates} onChoose={(id) => void flow.choose(id)} onSkip={flow.skip} />;
        break;
      case 'skipped':
        body = (
          <Message c={c} icon="👌" title="保存しませんでした">
            <PillButton c={c} label="ホームへ" primary onPress={goHome} />
          </Message>
        );
        break;
      case 'no_place':
        body = (
          <Message c={c} icon="🔍" title={state.title} body={state.body}>
            <PillButton c={c} label="ホームへ" primary onPress={goHome} />
          </Message>
        );
        break;
      case 'failed':
        body = (
          <Message c={c} icon="⚠️" title={state.title} body={state.body}>
            <PillButton c={c} label="もう一度試す" primary onPress={() => void flow.retry()} />
            <PillButton c={c} label="ホームへ" onPress={goHome} />
          </Message>
        );
        break;
      case 'need_login':
        body = signedIn ? (
          <Busy c={c} label="ログイン状態を確認しています…" />
        ) : (
          <View style={styles.gap}>
            <Text style={[styles.title, { color: c.text }]}>ログインすると保存できます</Text>
            <Text style={{ color: c.textSecondary }}>ログイン後、この共有の続きから自動で保存します。</Text>
            <AuthForm />
          </View>
        );
        break;
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled">
      {body}
      {__DEV__ ? <DevDetails snapshot={snapshot} phase={state.phase} /> : null}
    </ScrollView>
  );
}

function DevDetails({ snapshot, phase }: { snapshot: Snapshot | null; phase: string }) {
  return (
    <>
      <Section title="開発者向け（開発ビルドのみ）">
        <Field label="phase" value={phase} />
        <Field label="source" value={snapshot?.analysis.source} />
        <Field label="正規化URL" value={snapshot?.analysis.normalizedUrl} mono />
        <Field label="受信テキスト" value={snapshot?.analysis.receivedText} />
      </Section>
      {snapshot ? (
        <Section title="raw / resolved payload">
          <Json value={{ raw: snapshot.raw, resolved: snapshot.resolved }} />
        </Section>
      ) : null}
      <Section title="開発ログ（新しい順）">
        <ShareLogList />
      </Section>
    </>
  );
}

/** 共有処理中に想定外の例外が起きてもアプリ全体を落とさない */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const c = usePlanPalette();
  useEffect(() => {
    appLog.error('handle-share で例外が発生しました', error);
  }, [error]);
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.container}>
      <Message c={c} icon="⚠️" title="共有の処理中に問題が発生しました" body="もう一度お試しください。">
        <PillButton c={c} label="もう一度試す" primary onPress={retry} />
        <PillButton c={c} label="ホームへ" onPress={() => router.replace('/')} />
      </Message>
      {__DEV__ ? (
        <Text selectable style={{ color: c.textSecondary }}>
          {error.name}: {error.message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, gap: 16, paddingBottom: 48 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 32 },
  gap: { gap: 12 },
  icon: { fontSize: 44 },
  title: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 4 },
  card: { alignSelf: 'stretch', borderRadius: 20, borderWidth: 1.5, padding: 16, gap: 4 },
  placeName: { fontSize: 17, fontWeight: '800' },
});

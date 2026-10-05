/**
 * Step 3-3 / 3-4 の開発確認用UI。共有データを identify-place へ送り、AI抽出と Google Places の結果を表示し、
 * save-place で保存する。
 * API コストがかかるため自動実行はせず「Placeを特定」ボタンで実行する。完成版 Mikke では表示しない。
 * 保存: confirmed は「このPlaceを保存」、needs_review はユーザーが候補を選んだときだけ保存（自動保存しない）。
 */
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { appLog } from '@/lib/logger';
import type { ShareAnalysis } from '@/share/process-share-payloads';
import { Button, Field, Json, Messages, Section } from '@/share/share-debug-view';

import { backendConfig, reportUnauthorized, setDevSession, useDevSession } from '@/auth/session-store';
import {
  buildIdentifyRequest,
  callIdentifyPlace,
  isSessionValid,
  resolveBackend,
  signInWithPassword,
  type AiCandidate,
  type IdentifyCallResult,
  type IdentifyPlaceRequest,
  type IdentifyPlaceResponse,
  type ScoredPlace,
} from './identify-place-client';
import { buildSaveRequest, callSavePlace, type SaveResult } from './save-place-client';
import { markSavedPlacesChanged } from './saved-places-client';

const fmt = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : null;

const STATUS_COLORS: Record<string, string> = {
  confirmed: '#188038',
  needs_review: '#C77700',
  not_found: '#5F6368',
  insufficient_information: '#5F6368',
  error: '#D93025',
};

const SAVE_COLORS: Record<string, string> = {
  saved: '#188038',
  already_saved: '#208AEF',
  unauthorized: '#C77700',
  invalid_request: '#D93025',
  error: '#D93025',
};

export function IdentifyPlacePanel({ analysis }: { analysis: ShareAnalysis | null | undefined }) {
  const theme = useTheme();
  const session = useDevSession();
  const loggedIn = isSessionValid(session);
  const configured = resolveBackend(backendConfig) !== null;
  const request = buildIdentifyRequest(analysis);

  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<IdentifyPlaceRequest | null>(null);
  const [result, setResult] = useState<IdentifyCallResult | null>(null);
  const requestSeq = useRef(0);

  const identify = async () => {
    if (!request || loading) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setSent(request);
    setResult(null);
    appLog.info('identify-place を呼び出します', { source: request.source, url: request.url, hasText: !!request.text });
    try {
      const res = await callIdentifyPlace(request, {
        config: backendConfig,
        accessToken: isSessionValid(session) ? session.accessToken : null,
      });
      if (seq !== requestSeq.current) return; // 古いリクエストの結果は捨てる
      if (res.ok) {
        appLog.info('identify-place の結果', {
          http: res.httpStatus,
          status: res.data.status,
          reason: res.data.reason,
          confidence: res.data.confidence,
          place: res.data.place?.name ?? null,
          error: res.data.error,
        });
      } else {
        appLog.error(`identify-place 呼び出し失敗 (${res.kind})`, res.devDetail);
        if (res.kind === 'auth') void reportUnauthorized();
      }
      setResult(res);
    } catch (e) {
      // callIdentifyPlace は例外を投げない想定だが、念のため画面を落とさない
      appLog.error('identify-place で想定外の例外', e);
      setResult({ ok: false, kind: 'network', httpStatus: null, userMessage: '予期しないエラーが発生しました。', devDetail: String(e) });
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  return (
    <Section title="Place特定（Step 3-3 開発確認）">
      {!configured ? (
        <Messages
          level="error"
          items={['EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が未設定です（mikke-mobile/.env.local）。']}
        />
      ) : loggedIn ? (
        <View style={styles.row}>
          <Text style={[styles.flex, { color: theme.textSecondary }]}>ログイン中: {session.email}</Text>
          <Button title="ログアウト" onPress={() => setDevSession(null)} />
        </View>
      ) : (
        <DevSignIn />
      )}

      <Text style={[styles.heading, { color: theme.text }]}>【送信する共有情報】</Text>
      {request ? (
        <>
          <Field label="source" value={request.source} />
          <Field label="normalized URL" value={request.url} mono />
          <Field label="text" value={request.text} />
        </>
      ) : (
        <Messages level="warn" items={['URL もテキストも無いため送信できません。']} />
      )}

      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator />
          <Text style={{ color: theme.textSecondary }}>AI解析・Google Places 検索中…</Text>
        </View>
      ) : (
        <Button
          title={loggedIn ? 'Placeを特定' : 'Placeを特定（要ログイン）'}
          tone="primary"
          onPress={identify}
        />
      )}

      {result ? <IdentifyResultView result={result} sent={sent} /> : null}
    </Section>
  );
}

export function DevSignIn() {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const res = await signInWithPassword(email, password, { config: backendConfig });
    setBusy(false);
    if (res.ok) {
      setPassword('');
      setDevSession(res.session);
      appLog.info('開発用ログインに成功しました');
    } else {
      setMessage(res.userMessage);
      // パスワード・トークンはログに出さない
      appLog.warn('開発用ログインに失敗しました', res.devDetail);
    }
  };

  const inputStyle = [styles.input, { color: theme.text, backgroundColor: theme.background }];
  return (
    <View style={styles.form}>
      <Text style={{ color: theme.textSecondary }}>
        identify-place はログインが必要です（mikke-frontend と同じ Supabase アカウント）。
      </Text>
      <TextInput
        style={inputStyle}
        placeholder="email"
        placeholderTextColor={theme.textSecondary}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={inputStyle}
        placeholder="password"
        placeholderTextColor={theme.textSecondary}
        secureTextEntry
        autoCapitalize="none"
        value={password}
        onChangeText={setPassword}
      />
      {message ? <Messages level="error" items={[message]} /> : null}
      {busy ? <ActivityIndicator /> : <Button title="ログイン" onPress={signIn} />}
    </View>
  );
}

function IdentifyResultView({ result, sent }: { result: IdentifyCallResult; sent: IdentifyPlaceRequest | null }) {

  if (!result.ok) {
    return (
      <View style={styles.block}>
        <Text style={[styles.heading, { color: STATUS_COLORS.error }]}>【呼び出し失敗】</Text>
        <Messages level="error" items={[result.userMessage]} />
        <Field label="種類 (開発用)" value={result.kind} />
        <Field label="HTTP" value={result.httpStatus === null ? null : String(result.httpStatus)} />
        <Field label="詳細 (開発用)" value={result.devDetail} mono />
      </View>
    );
  }

  return <IdentifySuccessView data={result.data} httpStatus={result.httpStatus} sent={sent} />;
}

/** 保存処理（save-place 呼び出し）。二重タップでは多重送信しない */
function useSavePlace(data: IdentifyPlaceResponse, sent: IdentifyPlaceRequest | null) {
  const session = useDevSession();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ placeId: string; result: SaveResult } | null>(null);

  const save = async (selectedPlaceId: string | null) => {
    if (savingId) return;
    const request = buildSaveRequest(data, sent, selectedPlaceId);
    if (!request) {
      appLog.warn('保存できない状態です（confirmed ではない / 候補未選択）', { status: data.status });
      return;
    }
    const placeId = request.place.google_place_id;
    setSavingId(placeId);
    appLog.info('save-place を呼び出します', {
      googlePlaceId: placeId,
      identification: request.identification,
      source: request.share.source,
    });
    try {
      const res = await callSavePlace(request, {
        config: backendConfig,
        accessToken: isSessionValid(session) ? session.accessToken : null,
      });
      const detail = { status: res.status, http: res.httpStatus, detail: res.devDetail, placeReused: res.data?.place_reused ?? null, warnings: res.data?.warnings ?? [] };
      if (res.status === 'saved' || res.status === 'already_saved') appLog.info('save-place の結果', detail);
      else appLog.error('save-place 失敗', detail);
      if (res.status === 'unauthorized') void reportUnauthorized();
      // 次に保存一覧を開いた時に最新を取得させる
      if (res.status === 'saved') markSavedPlacesChanged();
      setSaved({ placeId, result: res });
    } catch (e) {
      appLog.error('save-place で想定外の例外', e);
      setSaved({
        placeId,
        result: { status: 'error', message: '保存できませんでした', httpStatus: null, data: null, devDetail: String(e) },
      });
    } finally {
      setSavingId(null);
    }
  };

  return { save, savingId, saved };
}

function IdentifySuccessView({
  data,
  httpStatus,
  sent,
}: {
  data: IdentifyPlaceResponse;
  httpStatus: number;
  sent: IdentifyPlaceRequest | null;
}) {
  const theme = useTheme();
  const { save, savingId, saved } = useSavePlace(data, sent);
  const ai = data.extraction;
  const place = data.place;
  const showCandidates = data.candidates.length > 0 && data.status !== 'confirmed';
  // needs_review の候補だけ選択保存できる（not_found の参考候補は保存させない）
  const selectable = data.status === 'needs_review';

  return (
    <View style={styles.block}>
      <Text style={[styles.heading, { color: theme.text }]}>【AI抽出】</Text>
      {ai ? <AiCandidateFields candidate={ai} /> : <Field label="candidate" value={null} />}
      {data.insufficient_reason ? <Field label="情報不足の理由 (AI)" value={data.insufficient_reason} /> : null}
      {data.extraction_candidates.length > 1 ? (
        <Field
          label="その他のAI候補"
          value={data.extraction_candidates
            .filter((c) => c !== ai && c.candidate_name !== ai?.candidate_name)
            .map((c) => `${c.candidate_name ?? '（名前なし）'} (${fmt(c.confidence)})`)
            .join(' / ')}
        />
      ) : null}

      <Text style={[styles.heading, { color: theme.text }]}>【Google Places結果】</Text>
      <Text style={[styles.status, { color: STATUS_COLORS[data.status] ?? theme.text }]}>
        {data.status}（confidence {fmt(data.confidence)}）
      </Text>
      <Text style={{ color: theme.text }}>{data.message}</Text>
      <Field label="reason (開発用)" value={data.reason} mono />
      {data.error ? <Field label="error (開発用)" value={`${data.error.stage}: ${data.error.code}`} mono /> : null}
      <Field
        label="検索クエリ"
        value={data.searches.map((s) => `「${s.query}」→ ${s.result_count}件`).join('\n')}
      />
      {place ? (
        <>
          <Field label="Place名" value={place.name} />
          <Field label="住所" value={place.formatted_address} />
          <Field label="Place ID" value={place.google_place_id} mono />
          <Field label="緯度経度" value={place.latitude === null ? null : `${fmt(place.latitude, 6)}, ${fmt(place.longitude, 6)}`} mono />
          <Field label="primary type" value={place.primary_type} mono />
          <Field label="business status" value={place.business_status} mono />
        </>
      ) : null}
      <Field label="final confidence" value={fmt(data.confidence)} />

      {data.status === 'confirmed' && place ? (
        <>
          <Text style={[styles.heading, { color: theme.text }]}>【保存】</Text>
          {savingId === place.google_place_id ? (
            <ActivityIndicator />
          ) : (
            <Button title="このPlaceを保存" tone="primary" onPress={() => save(null)} />
          )}
          {saved?.placeId === place.google_place_id ? <SaveResultView result={saved.result} /> : null}
        </>
      ) : null}
      {data.status === 'not_found' || data.status === 'insufficient_information' || data.status === 'error' ? (
        <Text style={{ color: theme.textSecondary }}>この結果（{data.status}）は保存しません。</Text>
      ) : null}

      {showCandidates ? (
        <>
          <Text style={[styles.heading, { color: theme.text }]}>
            【候補Place（{data.candidates.length}件）】{selectable ? '正しい場所を1件選んで保存' : '参考表示（保存不可）'}
          </Text>
          {data.candidates.map((c, i) => (
            <CandidateRow
              key={c.google_place_id}
              index={i}
              place={c}
              onSave={selectable ? () => save(c.google_place_id) : undefined}
              saving={savingId === c.google_place_id}
              saveResult={saved?.placeId === c.google_place_id ? saved.result : null}
            />
          ))}
        </>
      ) : null}

      <Messages level="warn" items={data.input.warnings.map((w) => `入力警告: ${w}`)} />
      <Field label="送信URL" value={sent?.url} mono />
      <Text style={[styles.heading, { color: theme.textSecondary }]}>レスポンスJSON（HTTP {httpStatus}）</Text>
      <Json value={data} />
    </View>
  );
}

function AiCandidateFields({ candidate }: { candidate: AiCandidate }) {
  const area = [candidate.prefecture, candidate.city, candidate.area_hint].filter(Boolean).join(' / ');
  return (
    <>
      <Field label="candidate name" value={candidate.candidate_name} />
      <Field label="area" value={area} />
      <Field label="category" value={candidate.category_hint} />
      <Field label="search query" value={candidate.search_query} />
      <Field label="AI confidence" value={fmt(candidate.confidence)} />
      <Field label="根拠" value={candidate.evidence.join(' / ')} />
    </>
  );
}

function SaveResultView({ result }: { result: SaveResult }) {
  const theme = useTheme();
  const data = result.data;
  return (
    <View style={styles.saveResult}>
      <Text style={[styles.status, { color: SAVE_COLORS[result.status] ?? theme.text }]}>
        {result.message}（{result.status}）
      </Text>
      {data?.place ? (
        <>
          <Field label="places.id" value={data.place.place_id} mono />
          <Field label="places 再利用" value={data.place_reused === null ? null : data.place_reused ? 'はい（既存Place）' : 'いいえ（新規作成）'} />
          <Field label="category" value={data.place.category} mono />
        </>
      ) : null}
      {data?.saved_place ? (
        <>
          <Field label="saved_places.id" value={data.saved_place.id} mono />
          <Field label="source_platform / source_url" value={`${data.saved_place.source_platform} / ${data.saved_place.source_url}`} mono />
        </>
      ) : null}
      {data?.warnings.length ? <Messages level="warn" items={data.warnings.map((w) => `保存警告: ${w}`)} /> : null}
      {result.status === 'saved' || result.status === 'already_saved' ? (
        <Button title="保存した場所を見る" onPress={() => router.push('/saved')} />
      ) : null}
      <Field label="詳細 (開発用)" value={result.devDetail} mono />
    </View>
  );
}

function CandidateRow({
  index,
  place,
  onSave,
  saving,
  saveResult,
}: {
  index: number;
  place: ScoredPlace;
  onSave?: () => void;
  saving?: boolean;
  saveResult?: SaveResult | null;
}) {
  const theme = useTheme();
  const d = place.score_detail;
  return (
    <View style={[styles.candidate, { borderColor: theme.backgroundSelected }]}>
      <Text selectable style={{ color: theme.text, fontWeight: '600' }}>
        {index + 1}. {place.name}（score {fmt(place.score)}）
      </Text>
      <Text selectable style={{ color: theme.textSecondary }}>{place.formatted_address ?? '（住所なし）'}</Text>
      <Text selectable style={{ color: theme.textSecondary }}>
        name {fmt(d.name)} / area {fmt(d.area) ?? '-'} / category {fmt(d.category, 0) ?? '-'}
        {d.closed_penalty ? ' / 閉業' : ''}
      </Text>
      <Text selectable style={{ color: theme.textSecondary }}>
        {place.google_place_id} / {place.primary_type ?? '-'} / {fmt(place.latitude, 5)}, {fmt(place.longitude, 5)}
      </Text>
      {onSave ? (saving ? <ActivityIndicator /> : <Button title="この候補を保存" onPress={onSave} />) : null}
      {saveResult ? <SaveResultView result={saveResult} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  flex: { flex: 1 },
  form: { gap: 8 },
  block: { gap: 8, paddingTop: 4 },
  heading: { fontSize: 14, fontWeight: '700', marginTop: 4 },
  status: { fontSize: 18, fontWeight: '700' },
  input: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  candidate: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 4 },
  saveResult: { gap: 4, paddingTop: 4 },
});

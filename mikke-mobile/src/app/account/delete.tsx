/**
 * アカウント削除（2段階）。
 *   1. 説明: 何が削除されるか・取り消せないことを示す →「削除に進む」
 *   2. 最終確認: 内容を理解したことにチェックしてから「完全に削除する」（赤）
 * 成功: 端末のログイン情報とユーザー固有のキャッシュを消し、ログイン前のホームへ戻る
 * 失敗: ログイン状態は保ったまま、やり直せるメッセージを表示する
 */
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { createAccountDeleter, requestAccountDeletion } from '@/auth/account-deletion';
import { backendConfig, completeAccountDeletion, getDevSession, reportUnauthorized, useAuthStatus, useDevSession } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { SavedPlacesLoading } from '@/place/saved-place-views';
import { usePlanPalette, type PlanPalette } from '@/plan/plan-theme';
import { appLog } from '@/lib/logger';

// 画面を開き直しても削除リクエストが二重にならないよう、モジュールで1つだけ持つ
const deleter = createAccountDeleter({
  getAccessToken: () => {
    const s = getDevSession();
    return isSessionValid(s) ? s.accessToken : null;
  },
  request: (accessToken) => requestAccountDeletion({ config: backendConfig, accessToken }),
  refreshAfterUnauthorized: reportUnauthorized,
  onDeleted: completeAccountDeletion,
});

const DELETED_ITEMS = ['保存した場所', '作成したプランと、今日のプラン', '訪問の記録', 'ログイン情報（メールアドレスとパスワード）'];

export default function DeleteAccountScreen() {
  const c = usePlanPalette();
  const session = useDevSession();
  const authStatus = useAuthStatus();
  const [step, setStep] = useState<'explain' | 'confirm'>('explain');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(deleter.isRunning());
  const [error, setError] = useState<string | null>(null);

  const runDelete = async () => {
    if (busy || !understood) return; // 二重タップ防止（deleter 側でも1本にまとめる）
    setBusy(true);
    setError(null);
    const outcome = await deleter.delete();
    if (outcome.status === 'deleted') {
      if (router.canDismiss()) router.dismissAll();
      router.replace({ pathname: '/', params: { accountDeleted: '1' } });
      return;
    }
    if (outcome.status === 'failed') {
      appLog.warn('アカウント削除に失敗', outcome.devDetail);
      setError(outcome.message);
    }
    setBusy(false);
  };

  if (authStatus === 'restoring') return <SavedPlacesLoading label="ログイン状態を確認しています…" />;
  if (!busy && !isSessionValid(session)) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.body, { color: c.text }]}>アカウントを削除するには、ログインが必要です。</Text>
        <SoftButton c={c} label="ホームへ" onPress={() => router.replace('/')} />
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.container}>
      {/* 削除中は戻る操作で画面を離れないようにする */}
      <Stack.Screen options={{ gestureEnabled: !busy, headerBackVisible: !busy }} />
      <View style={[styles.warning, { backgroundColor: c.dangerSoft, borderColor: c.danger }]}>
        <Text style={[styles.warningTitle, { color: c.danger }]}>この操作は取り消せません</Text>
        <Text style={[styles.body, { color: c.text }]}>
          アカウントを削除すると、保存した場所・プラン・行った記録・投稿や投稿写真など、Mikke に保存されているあなたのアカウントデータがすべて削除されます。削除したデータは元に戻せません。
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.cardTitle, { color: c.text }]}>削除されるもの</Text>
        {DELETED_ITEMS.map((item) => (
          <Text key={item} style={[styles.body, { color: c.text }]}>
            ・{item}
          </Text>
        ))}
        <Text style={[styles.small, { color: c.textSecondary }]}>
          お店の名前や住所などの一般的な場所の情報は、ほかの利用者と共通のため残ります。利用状況の統計は、個人を特定できない形で残ることがあります。
        </Text>
        <Text style={[styles.small, { color: c.textSecondary }]}>同じメールアドレスで再登録はできますが、以前のデータは引き継がれません。</Text>
      </View>

      {step === 'explain' ? (
        <View style={styles.actions}>
          <SoftButton c={c} label="やめる" primary onPress={() => router.back()} />
          <DangerButton c={c} label="削除に進む" outline onPress={() => setStep('confirm')} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: understood, disabled: busy }}
            disabled={busy}
            onPress={() => setUnderstood((v) => !v)}
            style={[styles.check, { borderColor: understood ? c.danger : c.border, backgroundColor: c.card }]}>
            <View style={[styles.box, { borderColor: c.danger, backgroundColor: understood ? c.danger : 'transparent' }]}>
              {understood ? <Text style={styles.tick}>✓</Text> : null}
            </View>
            <Text style={[styles.checkText, { color: c.text }]}>データがすべて削除され、元に戻せないことを理解しました</Text>
          </Pressable>

          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>
              {error}
            </Text>
          ) : null}

          <DangerButton c={c} label={busy ? '削除しています…' : '完全に削除する'} disabled={!understood || busy} busy={busy} onPress={() => void runDelete()} />
          <SoftButton c={c} label="やめる" disabled={busy} onPress={() => router.back()} />
        </View>
      )}
    </ScrollView>
  );
}

function DangerButton({
  c,
  label,
  onPress,
  disabled,
  busy,
  outline,
}: {
  c: PlanPalette;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  outline?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        outline
          ? { backgroundColor: c.card, borderColor: c.danger, borderWidth: 1.5, opacity: pressed ? 0.7 : 1 }
          : { backgroundColor: disabled && !busy ? c.disabled : c.danger, opacity: pressed ? 0.8 : 1 },
      ]}>
      {busy ? <ActivityIndicator color="#FFFFFF" /> : null}
      <Text style={[styles.buttonText, { color: outline ? c.danger : disabled && !busy ? c.textSecondary : '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

function SoftButton({ c, label, onPress, primary, disabled }: { c: PlanPalette; label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: c.accent, opacity: pressed ? 0.85 : 1 } : { backgroundColor: 'transparent', opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}>
      <Text style={[styles.buttonText, { color: primary ? c.onAccent : c.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, gap: 16, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  warning: { borderRadius: 22, borderWidth: 1.5, padding: 18, gap: 8 },
  warningTitle: { fontSize: 18, fontWeight: '900' },
  card: { borderRadius: 22, borderWidth: 1, padding: 18, gap: 6 },
  cardTitle: { fontSize: 16, fontWeight: '800', marginBottom: 2 },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  actions: { gap: 12 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, borderWidth: 1.5, padding: 14 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#FFFFFF', fontWeight: '900' },
  checkText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  error: { fontSize: 14, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
  button: { minHeight: 52, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 },
  buttonText: { fontSize: 16, fontWeight: '800' },
});

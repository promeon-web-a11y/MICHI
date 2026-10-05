/**
 * ログイン / 新規登録フォーム（一般ユーザー向け）。Supabase Auth のメールアドレス＋パスワード。
 * 成功するとセッションを保存し（Keychain / Keystore）、次回起動時も自動でログイン状態に戻る。
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { openPublicPage } from '@/components/public-page-links';
import { appLog } from '@/lib/logger';
import { usePlanPalette } from '@/plan/plan-theme';

import { signInWithPassword, signUp, validateCredentials } from './auth-session';
import { backendConfig, setDevSession } from './session-store';

export function AuthForm({ intro }: { intro?: string }) {
  const c = usePlanPalette();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const submit = async () => {
    if (busy) return; // 二重送信防止
    const invalid = validateCredentials(email, password);
    if (invalid) {
      setMessage({ tone: 'error', text: invalid });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'login') {
        const r = await signInWithPassword(email, password, { config: backendConfig });
        if (r.ok) {
          setPassword('');
          setDevSession(r.session);
        } else {
          appLog.warn('ログイン失敗', r.devDetail); // パスワード・トークンは出さない
          setMessage({ tone: 'error', text: r.userMessage });
        }
      } else {
        const r = await signUp(email, password, { config: backendConfig });
        if (r.status === 'signed_in') {
          setPassword('');
          setDevSession(r.session);
        } else if (r.status === 'confirmation_required') {
          setPassword('');
          setMode('login');
          setMessage({ tone: 'info', text: '確認メールを送りました。メール内のリンクを開いてから、ログインしてください。' });
        } else {
          appLog.warn('新規登録失敗', r.devDetail);
          setMessage({ tone: 'error', text: r.userMessage });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, { color: c.text, backgroundColor: c.card, borderColor: c.border }];
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.title, { color: c.text }]}>{mode === 'login' ? 'ログイン' : '新規登録'}</Text>
      {intro ? <Text style={{ color: c.textSecondary }}>{intro}</Text> : null}
      <TextInput
        style={input}
        placeholder="メールアドレス"
        placeholderTextColor={c.textSecondary}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        accessibilityLabel="メールアドレス"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={input}
        placeholder={mode === 'signup' ? 'パスワード（6文字以上）' : 'パスワード'}
        placeholderTextColor={c.textSecondary}
        secureTextEntry
        autoCapitalize="none"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        textContentType={mode === 'signup' ? 'newPassword' : 'password'}
        accessibilityLabel="パスワード"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submit}
      />
      {message ? <Text style={{ color: message.tone === 'error' ? c.warning : c.text }}>{message.text}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={submit}
        style={({ pressed }) => [styles.primary, { backgroundColor: busy ? c.disabled : pressed ? c.accentPressed : c.accent }]}>
        {busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={[styles.primaryText, { color: c.onAccent }]}>{mode === 'login' ? 'ログイン' : '登録する'}</Text>}
      </Pressable>
      {mode === 'signup' ? (
        <Text style={[styles.consent, { color: c.textSecondary }]}>
          登録することで、
          <Text accessibilityRole="link" style={[styles.consentLink, { color: c.accentStrong }]} onPress={() => void openPublicPage('terms')}>
            利用規約
          </Text>
          および
          <Text accessibilityRole="link" style={[styles.consentLink, { color: c.accentStrong }]} onPress={() => void openPublicPage('privacy')}>
            プライバシーポリシー
          </Text>
          に同意したものとみなします。
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        hitSlop={8}
        onPress={() => {
          setMode(mode === 'login' ? 'signup' : 'login');
          setMessage(null);
        }}>
        <Text style={[styles.switch, { color: c.accentStrong }]}>
          {mode === 'login' ? 'はじめての方は新規登録' : 'アカウントをお持ちの方はログイン'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, borderWidth: 1, padding: 18, gap: 12 },
  title: { fontSize: 20, fontWeight: '800' },
  input: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, minHeight: 48 },
  primary: { borderRadius: 999, paddingVertical: 15, alignItems: 'center', minHeight: 50, justifyContent: 'center' },
  primaryText: { fontSize: 16, fontWeight: '800' },
  switch: { textAlign: 'center', fontWeight: '700', paddingVertical: 4 },
  consent: { fontSize: 12, lineHeight: 18 },
  consentLink: { fontWeight: '700', textDecorationLine: 'underline' },
});

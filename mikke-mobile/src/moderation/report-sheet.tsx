/**
 * 投稿・コメントの通報シート（ルート詳細から開く）。
 * - 理由（必須）と詳しい内容（任意）を送ると content_reports に記録され、運営が確認する
 * - あわせて「投稿者（コメントした人）も通報」「この人をブロック」を選べる
 * - 通報した内容は通報者には表示されなくなる（サーバー側）。画面は onDone で表示を切り替える
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { callApi } from '@/lib/use-api-resource';
import { ChoiceRow, Field, FormGroup, H1, Muted, Notice, PrimaryButton, TextButton, ToggleRow, V } from '@/ui/kit';

import { blockUser, MAX_REPORT_DETAIL, REPORT_REASONS, reportContent, type ReportReason, type UgcTarget } from './moderation-client';

export type ReportTarget = UgcTarget & { kind: 'post' | 'comment'; authorName: string };

export type ReportOutcome = { blocked: boolean; message: string };

export function ReportSheet({ target, onClose, onDone }: { target: ReportTarget | null; onClose: () => void; onDone: (r: ReportOutcome) => void }) {
  return (
    <Modal visible={!!target} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {target ? <ReportForm key={`${target.kind}:${target.commentId ?? target.postId}`} target={target} onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

function ReportForm({ target, onClose, onDone }: { target: ReportTarget; onClose: () => void; onDone: (r: ReportOutcome) => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [alsoUser, setAlsoUser] = useState(false);
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = target.kind === 'post' ? 'このルート' : 'このコメント';
  const who = target.kind === 'post' ? '投稿者' : 'コメントした人';

  const submit = async () => {
    if (busy) return;
    if (!reason) return setError('通報の理由を選んでください。');
    setBusy(true);
    setError(null);
    const r = await callApi((opts) => reportContent(target.kind, target, reason, detail, opts));
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    const notes: string[] = [r.data.alreadyReported ? 'この内容はすでに通報済みです。運営が確認します。' : '通報を受け付けました。運営が内容を確認します。'];
    if (alsoUser) {
      const u = await callApi((opts) => reportContent('user', target, reason, detail, opts));
      if (!u.ok) notes.push(`${who}の通報は送れませんでした（${u.message}）`);
    }
    let blocked = false;
    // ブロックは通報のあとに行う（ブロックすると相手の内容を対象として指定できなくなるため）
    if (block) {
      const b = await callApi((opts) => blockUser(target, opts));
      if (b.ok) {
        blocked = true;
        notes.push(`${b.data.name}さんをブロックしました。`);
      } else notes.push(`ブロックできませんでした（${b.message}）`);
    }
    setBusy(false);
    onDone({ blocked, message: notes.join('\n') });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <TextButton label="閉じる" color={V.sub} onPress={onClose} />
          </View>
          <H1>{`${what}を通報`}</H1>
          <Muted>{`${target.authorName}さんの${target.kind === 'post' ? '投稿' : 'コメント'}について、運営に知らせます。通報したことは相手に通知されません。`}</Muted>

          <FormGroup label="理由">
            <View style={{ gap: 6 }}>
              {REPORT_REASONS.map((o) => (
                <ChoiceRow key={o.value} value={reason} onChange={setReason} options={[o]} />
              ))}
            </View>
          </FormGroup>
          <FormGroup label="詳しい内容（任意）" note={`${MAX_REPORT_DETAIL}文字まで。個人情報の場合は、どの部分かを書いてください。`}>
            <Field multiline value={detail} onChangeText={setDetail} maxLength={MAX_REPORT_DETAIL} placeholder="例：同じ宣伝を何度も投稿している" accessibilityLabel="詳しい内容" />
          </FormGroup>

          <ToggleRow title={`${who}も通報する`} note="この人の投稿やコメント全体に問題がある場合" value={alsoUser} onChange={setAlsoUser} />
          <ToggleRow title={`${target.authorName}さんをブロックする`} note="お互いの投稿・コメントが表示されなくなります。設定からいつでも解除できます" value={block} onChange={setBlock} />

          <Text style={styles.tiny}>通報した内容は、あなたには表示されなくなります。運営が確認し、規約に反する場合は非表示などの対応をします。</Text>
          {error ? <Notice tone="warn">{error}</Notice> : null}
          <PrimaryButton label={busy ? '送信しています…' : '通報する'} busy={busy} disabled={!reason} onPress={() => void submit()} style={{ marginTop: 14 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: V.white },
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 6 },
  tiny: { fontSize: 11, lineHeight: 17, color: V.sub, marginTop: 14 },
});

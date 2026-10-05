/**
 * 開発者向けツール（ホームの一番下。開発ビルド（__DEV__）でだけ表示する）。
 * Step 3-2 / 3-3 の確認用: サンプル Payload の解析、共有受信画面、手入力での Place 特定。
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { IdentifyPlacePanel } from '@/place/identify-place-panel';
import { appLog } from '@/lib/logger';
import { processSharePayloads, type ShareAnalysis } from '@/share/process-share-payloads';
import { Button, Json, Section } from '@/share/share-debug-view';

/** 実機では再現しにくい入力（不正データ等）を解析処理に通して、クラッシュしないことを確認する */
const SAMPLE_PAYLOADS: { label: string; payloads: unknown }[] = [
  { label: 'Instagram URL', payloads: [{ shareType: 'url', mimeType: 'text/plain', value: 'https://www.instagram.com/reel/xxxxx/?igsh=abc' }] },
  { label: '文章＋URL', payloads: [{ shareType: 'text', mimeType: 'text/plain', value: 'この投稿をチェック！\nhttps://www.instagram.com/reel/xxxxx/' }] },
  { label: '未知のWebサイト', payloads: [{ shareType: 'url', value: 'https://tabelog.com/tokyo/?utm_source=x' }] },
  { label: '複数URL', payloads: [{ shareType: 'text', value: 'https://example.com と https://youtu.be/abc?si=1' }] },
  { label: 'URLなし', payloads: [{ shareType: 'text', value: 'URLのないテキスト' }] },
  { label: '空Payload', payloads: [] },
  { label: '不正データ', payloads: [null, 1, { shareType: 'url', value: 'https://' }] },
];

export function DevTools() {
  const theme = useTheme();
  const [results, setResults] = useState<unknown[] | null>(null);
  const [manualText, setManualText] = useState('');
  const [manualAnalysis, setManualAnalysis] = useState<ShareAnalysis | null>(null);

  const runSamples = () => {
    const output = SAMPLE_PAYLOADS.map(({ label, payloads }) => {
      try {
        const analysis = processSharePayloads(payloads);
        return { label, source: analysis.source, primaryUrl: analysis.primaryUrl, normalizedUrl: analysis.normalizedUrl, warnings: analysis.warnings, errors: analysis.errors };
      } catch (e) {
        appLog.error(`サンプル「${label}」で例外`, e);
        return { label, crashed: String(e) };
      }
    });
    appLog.info('サンプル検証を実行しました', output);
    setResults(output);
  };

  return (
    <>
      <Section title="開発者向け（開発ビルドのみ）">
        <Text style={{ color: theme.textSecondary }}>リリースビルドでは表示されません。</Text>
        <Button title="共有受信の確認画面を開く" onPress={() => router.push('/handle-share')} />
        <Button title="サンプルPayloadで解析を検証" onPress={runSamples} />
      </Section>
      {results ? (
        <Section title="サンプル検証結果">
          <Json value={results} />
        </Section>
      ) : null}
      <Section title="手入力で Place特定を試す（開発用）">
        <TextInput
          style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
          placeholder={'例: 札幌の #森彦 でモーニング\nhttps://www.instagram.com/p/xxxx/'}
          placeholderTextColor={theme.textSecondary}
          multiline
          autoCapitalize="none"
          value={manualText}
          onChangeText={setManualText}
        />
        <Button title="共有データとして解析" onPress={() => setManualAnalysis(processSharePayloads([{ shareType: 'text', value: manualText }]))} />
      </Section>
      {manualAnalysis ? <IdentifyPlacePanel analysis={manualAnalysis} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  input: { borderRadius: 8, padding: 10, minHeight: 80, fontSize: 15, textAlignVertical: 'top' },
});

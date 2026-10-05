/**
 * Mikke v3.0 の共通 UI（docs/v3-reference/Mikke-v3-reference.html の CSS を基準に React Native で再現）。
 * 色は constants/theme.ts の v0.2/v3 ブランド色（palettes.light）だけを使う。
 */
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';

import { palettes } from '@/constants/theme';
import { useProfile } from '@/profile/use-profile';

import { Gradient, Icon, type IconName } from './icon';

/**
 * v3 の色。2026-09-29 のデザイン実装仕様の視覚トークン（コーラル #ee6b50・アイボリー #fffaf6・本文 #292522・補助 #847d78・白）。
 * 小さい文字のコントラスト（WCAG AA 4.5:1）を満たすため、試作から次だけ濃くしている:
 * - sub（補助文字）#847d78 → #736c67（アイボリー上 3.9 → 4.8、淡いコーラル面上 4.6）
 * - deep（コーラル系の文字色）#e95e44 → #b8472f（白上 3.4 → 5.1）
 * - コーラルの主ボタンの文字は白（3.1）ではなく本文色（5.0）
 */
export const V = {
  paper: '#FFFAF6', // アイボリーの背景
  white: '#FFFFFF', // 白い面
  soft: '#FFF0E9', // コーラルの淡い面（選択・帯）
  ink: '#292522',
  sub: '#736C67',
  line: '#EEE5DF',
  coral: '#EE6B50',
  orange: palettes.light.orange, // #EFA15F
  pale: '#FFF0E9',
  deep: '#B8472F',
  onGradient: '#2B2320',
  placeholder: '#999A94',
  danger: palettes.light.danger,
} as const;

export const V3_IMAGES = {
  park: require('@/assets/images/v3/autumn-park.jpg'),
  cafe: require('@/assets/images/v3/cafe-window.jpg'),
  books: require('@/assets/images/v3/books-coffee.jpg'),
  sweets: require('@/assets/images/v3/afternoon-sweets.jpg'),
};

export const CORAL_GRADIENT = [
  { offset: 0, color: V.coral },
  { offset: 1, color: V.orange },
];

// ---------------------------------------------------------------------------------------------
// 画面の骨組み
// ---------------------------------------------------------------------------------------------

/** ホーム以外の上部: Mikke と よく行く地域 */
export function AppHeader() {
  const { profile } = useProfile();
  const area = profile?.homeArea ?? null;
  return (
    <View style={styles.header}>
      <Text style={styles.brand} accessibilityRole="header">
        Mikke
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={area ? `よく行く地域 ${area}` : 'よく行く地域を設定'}
        hitSlop={8}
        onPress={() => router.push('/settings/area')}
        style={styles.headerPlace}>
        <Icon name="pin" size={13} color={V.sub} />
        <Text style={styles.headerPlaceText}>{area ?? '地域を設定'}</Text>
      </Pressable>
    </View>
  );
}

/**
 * 上部ヘッダー＋スクロールする本文。下部タブの上で長い内容だけがスクロールする。
 * scroll=false のときは children が自分でスクロールする（FlatList など）
 */
export function Screen({
  children,
  scroll = true,
  header = true,
  refreshControl,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  header?: boolean;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      {header ? <AppHeader /> : null}
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.page, contentStyle]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // iOS: キーボードで入力欄が隠れないように下の余白を自動で調整する（Android は adjustResize）
          automaticallyAdjustKeyboardInsets
          refreshControl={refreshControl}>
          {children}
        </ScrollView>
      ) : (
        <View style={styles.flex}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** 呼び出し元へ戻る（履歴が無いときは fallback へ） */
export function goBack(fallback: Parameters<typeof router.navigate>[0] = '/') {
  if (router.canGoBack()) router.back();
  else router.navigate(fallback);
}

export function BackLink({ label = '戻る', onPress, fallback }: { label?: string; onPress?: () => void; fallback?: Parameters<typeof router.navigate>[0] }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={onPress ?? (() => goBack(fallback))}
      style={({ pressed }) => [styles.back, { opacity: pressed ? 0.6 : 1 }]}>
      <Icon name="chevronLeft" size={18} color={V.ink} />
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
}

export function PageBanner({ image, title, subtitle }: { image: number; title: string; subtitle: string }) {
  return (
    <View style={styles.banner}>
      <Image source={image} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} />
      <Gradient
        angle={90}
        stops={[
          { offset: 0, color: V.ink, opacity: 0.67 },
          { offset: 0.57, color: V.ink, opacity: 0.4 },
          { offset: 1, color: V.ink, opacity: 0 },
        ]}
      />
      <View style={styles.bannerCopy}>
        <Text style={styles.bannerTitle} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.bannerSub}>{subtitle}</Text>
      </View>
    </View>
  );
}

export function H1({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Text style={[styles.h1, style]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function H2({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Text style={[styles.h2, style]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Tiny({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.tiny, style]}>{children}</Text>;
}

export function SectionHead({ title, action, onAction, style }: { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.sectionHead, style]}>
      <H2>{title}</H2>
      {action && onAction ? <TextButton label={action} onPress={onAction} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// ボタン・入力
// ---------------------------------------------------------------------------------------------

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, { opacity: off ? 0.55 : pressed ? 0.85 : 1 }, style]}>
      {busy ? <ActivityIndicator color={V.onGradient} /> : null}
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled, style }: { label: string; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.secondary, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }, style]}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({ label, onPress, color = V.deep }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable accessibilityRole="button" hitSlop={10} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 5 })}>
      <Text style={[styles.textButton, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { invalid?: boolean }) {
  const { style, invalid, multiline, ...rest } = props;
  return (
    <TextInput
      placeholderTextColor={V.placeholder}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      {...rest}
      style={[styles.field, multiline ? styles.fieldMulti : null, invalid ? { borderColor: V.coral } : null, style]}
    />
  );
}

export function FormGroup({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <View style={styles.formGroup}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {note ? <Tiny style={{ marginTop: 4 }}>{note}</Tiny> : null}
    </View>
  );
}

/** 選択肢の横並び（参照画面の choice-row） */
export function ChoiceRow<T extends string | number | null>({
  options,
  value,
  onChange,
  allowClear,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** 選択中をもう一度押すと未選択（null）に戻す */
  allowClear?: boolean;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(on && allowClear ? (null as T) : o.value)}
            style={[styles.choice, on ? styles.choiceOn : null]}>
            <Text style={[styles.choiceText, on ? styles.choiceTextOn : null]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, on, onPress, icon }: { label: string; on?: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : null]}>
      {icon ? <Icon name={icon} size={13} color={on ? V.white : V.ink} /> : null}
      <Text style={[styles.chipText, on ? { color: V.white } : null]}>{label}</Text>
    </Pressable>
  );
}

/** 参照画面の select（地域・予算・並び順など）。押すと下から選択肢を出す */
export function SelectField<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  compact,
  style,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? '';
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${current}`}
        accessibilityHint="選択肢を開きます"
        onPress={() => setOpen(true)}
        style={[styles.select, compact ? styles.selectCompact : null, style]}>
        <Text style={[styles.selectText, compact ? { fontSize: 11 } : null]} numberOfLines={1}>
          {current}
        </Text>
        <Text style={styles.selectCaret}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setOpen(false)} accessibilityLabel="閉じる">
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <Text style={styles.sheetTitle}>{label}</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {options.map((o) => {
                const on = o.value === value;
                return (
                  <Pressable
                    key={String(o.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => {
                      setOpen(false);
                      onChange(o.value);
                    }}
                    style={({ pressed }) => [styles.sheetRow, pressed ? { backgroundColor: V.paper } : null]}>
                    <Text style={[styles.sheetRowText, on ? { color: V.deep, fontWeight: '700' } : null]}>{o.label}</Text>
                    {on ? <Icon name="check" size={16} color={V.deep} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </Pressable>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// 表示部品
// ---------------------------------------------------------------------------------------------

export function Notice({ children, tone = 'soft', style }: { children: ReactNode; tone?: 'soft' | 'pale' | 'warn'; style?: StyleProp<ViewStyle> }) {
  const bg = tone === 'pale' ? V.pale : tone === 'warn' ? palettes.light.warningSoft : V.soft;
  return (
    <View style={[styles.notice, { backgroundColor: bg }, style]}>
      {typeof children === 'string' ? <Text style={styles.noticeText}>{children}</Text> : children}
    </View>
  );
}

/** floating: 画面下部に重ねて出す（本文の流れに入れないので、表示してもスクロール位置・レイアウトがずれない） */
export function Toast({ message, floating }: { message: string | null; floating?: boolean }) {
  if (!message) return null;
  return (
    <View style={[styles.toast, floating ? styles.toastFloating : null]} accessibilityRole="alert" accessibilityLiveRegion="polite" pointerEvents="none">
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
}

export function Avatar({ name, size = 23 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.42) }]}>{(name.trim()[0] ?? 'M').toUpperCase()}</Text>
    </View>
  );
}

export function Loading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={V.coral} />
      <Muted>{label}</Muted>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <Notice tone="warn">
      <Text style={styles.noticeText}>{message ?? '読み込めませんでした。'}</Text>
      <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
        <TextButton label="もう一度読み込む" onPress={onRetry} />
      </View>
    </Notice>
  );
}

/** 設定の一覧（参照画面の settings-list） */
export function SettingsList({ items }: { items: { label: string; value?: string; onPress: () => void; danger?: boolean }[] }) {
  return (
    <View style={styles.settingsList}>
      {items.map((it, i) => (
        <Pressable
          key={it.label}
          accessibilityRole="button"
          accessibilityLabel={it.value ? `${it.label} ${it.value}` : it.label}
          onPress={it.onPress}
          style={({ pressed }) => [styles.settingsRow, i === items.length - 1 ? { borderBottomWidth: 0 } : null, pressed ? { backgroundColor: V.paper } : null]}>
          <Text style={[styles.settingsLabel, it.danger ? { color: V.danger } : null]}>{it.label}</Text>
          <Text style={styles.settingsValue} numberOfLines={1}>
            {it.value ? `${it.value} →` : '→'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsGroup({ children }: { children: string }) {
  return <Text style={styles.settingsGroup}>{children}</Text>;
}

export function ToggleRow({ title, note, value, onChange, disabled }: { title: string; note: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.flex}>
        <Text style={styles.toggleTitle}>{title}</Text>
        <Text style={styles.toggleNote}>{note}</Text>
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: '#DFE0D8', true: V.coral }}
        thumbColor={V.white}
      />
    </View>
  );
}

export function ListRow({ title, sub, action, onPress, footer }: { title: string; sub: string; action?: string; onPress?: () => void; footer?: ReactNode }) {
  return (
    <View style={styles.listRow}>
      <View style={styles.flex}>
        <Text style={styles.listTitle} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.listSub} numberOfLines={2}>
          {sub}
        </Text>
        {footer}
      </View>
      {action && onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${title} ${action}`} hitSlop={8} onPress={onPress} style={styles.listAction}>
          <Text style={styles.listActionText}>{action} →</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on ? styles.segmentOn : null]}>
            <Text style={[styles.segmentText, on ? styles.segmentTextOn : null]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: V.paper },
  page: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 32, backgroundColor: V.paper },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 21, paddingTop: 12, paddingBottom: 12, backgroundColor: V.paper },
  brand: { fontSize: 29, lineHeight: 32, fontWeight: '800', letterSpacing: -1.8, color: V.coral },
  headerPlace: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, maxWidth: '55%' },
  headerPlaceText: { color: V.sub, fontSize: 12 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingTop: 5, paddingBottom: 12, alignSelf: 'flex-start', minHeight: 40 },
  backText: { color: V.ink, fontSize: 13, fontWeight: '700' },
  banner: { height: 145, borderRadius: 17, overflow: 'hidden', marginTop: 5, marginBottom: 16, backgroundColor: V.soft },
  bannerCopy: { position: 'absolute', left: 16, right: 16, bottom: 15 },
  bannerTitle: { color: V.white, fontSize: 21, fontWeight: '800', marginBottom: 4 },
  bannerSub: { color: '#FFF9F1', fontSize: 11 },
  h1: { fontSize: 24, lineHeight: 31, letterSpacing: -0.5, fontWeight: '800', color: V.ink, marginTop: 8, marginBottom: 5 },
  h2: { fontSize: 17, lineHeight: 23, fontWeight: '800', color: V.ink },
  muted: { color: V.sub, fontSize: 12, lineHeight: 18 },
  tiny: { color: V.sub, fontSize: 11, lineHeight: 16 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 25, marginBottom: 12 },
  primary: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: V.coral,
    shadowColor: V.coral,
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  primaryText: { color: V.onGradient, fontSize: 14, fontWeight: '800' },
  secondary: { minHeight: 46, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: V.line, backgroundColor: V.white },
  secondaryText: { color: V.ink, fontSize: 13, fontWeight: '800' },
  textButton: { fontSize: 12, fontWeight: '800' },
  field: { minHeight: 44, borderWidth: 1, borderColor: V.line, borderRadius: 11, backgroundColor: V.white, color: V.ink, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  fieldMulti: { minHeight: 75 },
  formGroup: { marginTop: 19 },
  label: { fontSize: 12, fontWeight: '800', color: V.ink, marginBottom: 8 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexGrow: 1, flexBasis: '22%', minHeight: 40, paddingVertical: 10, paddingHorizontal: 7, borderWidth: 1, borderColor: V.line, borderRadius: 11, backgroundColor: V.white, alignItems: 'center', justifyContent: 'center' },
  choiceOn: { borderColor: V.coral, backgroundColor: V.pale },
  choiceText: { fontSize: 12, color: V.ink },
  choiceTextOn: { color: V.deep, fontWeight: '800' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: V.line, borderRadius: 999, backgroundColor: V.white, paddingHorizontal: 14, paddingVertical: 7, minHeight: 34 },
  chipOn: { backgroundColor: V.ink, borderColor: V.ink },
  chipText: { fontSize: 12, color: V.ink },
  select: { minHeight: 39, borderWidth: 1, borderColor: V.line, borderRadius: 11, backgroundColor: V.white, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
  selectCompact: { minHeight: 36 },
  selectText: { flex: 1, fontSize: 12, color: V.ink },
  selectCaret: { fontSize: 10, color: V.sub },
  sheetBackdrop: { flex: 1, backgroundColor: '#25272266', justifyContent: 'flex-end' },
  sheet: { backgroundColor: V.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, paddingHorizontal: 20, paddingBottom: 12 },
  sheetTitle: { fontSize: 13, fontWeight: '800', color: V.sub, marginBottom: 6 },
  sheetRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: V.line },
  sheetRowText: { fontSize: 15, color: V.ink },
  notice: { borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, marginVertical: 16 },
  noticeText: { fontSize: 11, lineHeight: 17, color: V.sub },
  toast: { backgroundColor: V.ink, borderRadius: 10, padding: 10, marginBottom: 13, marginTop: 4 },
  toastText: { color: V.white, fontSize: 12, textAlign: 'center' },
  toastFloating: { position: 'absolute', left: 18, right: 18, bottom: 14, marginTop: 0, marginBottom: 0, zIndex: 25, elevation: 6, paddingVertical: 11, borderRadius: 12 },
  avatar: { backgroundColor: V.pale, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: V.deep, fontWeight: '800' },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  settingsGroup: { marginTop: 21, marginBottom: 9, color: V.sub, fontSize: 11, fontWeight: '800' },
  settingsList: { borderWidth: 1, borderColor: V.line, borderRadius: 15, overflow: 'hidden', backgroundColor: V.white },
  settingsRow: { minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 15, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: V.line, backgroundColor: V.white },
  settingsLabel: { fontSize: 13, color: V.ink, flexShrink: 0 },
  settingsValue: { fontSize: 12, color: V.sub, flexShrink: 1, textAlign: 'right' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 17, paddingHorizontal: 2, borderBottomWidth: 1, borderBottomColor: V.line },
  toggleTitle: { fontSize: 13, fontWeight: '800', color: V.ink },
  toggleNote: { fontSize: 11, color: V.sub, marginTop: 3 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: V.line },
  listTitle: { fontSize: 13, fontWeight: '800', color: V.ink },
  listSub: { fontSize: 11, color: V.sub, marginTop: 2 },
  listAction: { padding: 8, minHeight: 44, justifyContent: 'center' },
  listActionText: { color: V.deep, fontSize: 12 },
  segmented: { flexDirection: 'row', backgroundColor: V.soft, borderRadius: 12, padding: 3, marginVertical: 16 },
  segment: { flex: 1, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 1, alignItems: 'center', minHeight: 36, justifyContent: 'center' },
  segmentOn: { backgroundColor: V.white, shadowColor: V.ink, shadowOpacity: 0.09, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segmentText: { fontSize: 11, color: V.sub },
  segmentTextOn: { color: V.ink, fontWeight: '800' },
});

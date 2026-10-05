/**
 * v3.0 ＋プラン（プラン作成の入口）。保存した場所から / みんなのルートから / 条件から探す。
 * 提案は既存の generate-plan-options（保存した場所から最大3案）を使う。
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAccessToken } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { useSavedPlaces } from '@/place/use-saved-places';
import { TodayPlanCard } from '@/today/today-plan-card';
import { Icon, type IconName } from '@/ui/icon';
import { PageBanner, Screen, Tiny, V, V3_IMAGES } from '@/ui/kit';

export default function CreateScreen() {
  const token = useAccessToken();
  const { view: saved } = useSavedPlaces();
  if (!token) return <SavedPlacesUnauthorized description="プランをつくるにはログインしてください。" />;
  const count = saved.phase === 'ready' ? saved.items.length : null;

  return (
    <Screen>
      <PageBanner image={V3_IMAGES.sweets} title="次のお出かけをつくる" subtitle="行きたい場所から、今日のルートへ。" />
      <TodayPlanCard />
      <View style={styles.options}>
        <Option
          icon="bookmark"
          title="保存した場所から"
          sub={count === null ? '行きたい場所を組み合わせる' : `保存した${count}か所を組み合わせる`}
          onPress={() => router.push({ pathname: '/plan', params: { source: 'saved' } })}
        />
        <Option icon="users" title="みんなのルートから" sub="気に入ったルートを自分向けに" onPress={() => router.navigate('/feed')} />
        <Option icon="sparkles" title="条件から探す" sub="時間と予算を決めて考える" onPress={() => router.push({ pathname: '/plan', params: { source: 'conditions' } })} />
      </View>
      <Tiny>提案は、あなたが保存した場所（みんなのルートから調整する場合はそのルートの場所）から作ります。店舗・営業時間は出かける前にご確認ください。</Tiny>
    </Screen>
  );
}

function Option({ icon, title, sub, onPress }: { icon: IconName; title: string; sub: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}。${sub}`} onPress={onPress} style={({ pressed }) => [styles.option, pressed ? { backgroundColor: V.pale } : null]}>
      <Icon name={icon} size={20} color={V.deep} />
      <View style={styles.flex}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <Text style={styles.arrow}>→</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  options: { gap: 9, marginVertical: 19 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 15, borderWidth: 1, borderColor: '#EFEEE6', backgroundColor: V.paper, minHeight: 64 },
  title: { fontSize: 14, fontWeight: '800', color: V.ink },
  sub: { fontSize: 11, color: V.sub, marginTop: 2 },
  arrow: { color: V.sub, fontSize: 14 },
});

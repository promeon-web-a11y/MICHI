/**
 * 下部の5つのメニュー（ホーム / みつける / 中央の＋プラン / 保存 / マイページ）。
 * 2026-09-29 のデザイン参照（.mk-nav）を再現。中央だけ少し浮いた角丸のコーラルのボタン。
 * 選択中のタブをもう一度押すと、そのタブの最初の画面に戻る（Stack が tabPress を受けて popToTop する）。
 */
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { V } from './kit';
import { Icon, type IconName } from './icon';

export const TAB_ITEMS: { route: string; label: string; icon: IconName | null; a11y: string }[] = [
  { route: '(home)', label: 'ホーム', icon: 'house', a11y: 'ホーム' },
  { route: '(feed)', label: 'みつける', icon: 'compass', a11y: 'みつける（みんなのルート・お店・スポット）' },
  { route: '(create)', label: 'プラン', icon: null, a11y: 'プランを作る' },
  { route: '(saved)', label: '保存', icon: 'bookmark', a11y: '保存一覧' },
  { route: '(profile)', label: 'マイページ', icon: 'user', a11y: 'マイページ' },
];

export function MikkeTabBar({ state, navigation, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8), height: 67 + Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
      {TAB_ITEMS.map((item) => {
        const route = state.routes.find((r) => r.name === item.route);
        if (!route) return null;
        const focused = state.routes[state.index]?.key === route.key;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        const color = focused ? V.deep : V.sub;
        const center = item.icon === null;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={item.a11y}
            onPress={onPress}
            style={[styles.item, center ? styles.center : null]}>
            {center ? (
              <View style={[styles.plus, focused ? styles.plusOn : null]}>
                <Icon name="plus" size={24} color={V.onGradient} strokeWidth={2.2} />
              </View>
            ) : (
              <Icon name={item.icon!} size={19} color={color} />
            )}
            <Text style={[styles.label, { color }, focused ? styles.labelOn : null]} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: V.white,
    borderTopWidth: 1,
    borderTopColor: V.line,
    paddingHorizontal: 5,
  },
  item: { flex: 1, height: 53, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 2 },
  center: { height: 68, justifyContent: 'flex-end' },
  plus: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    backgroundColor: V.coral,
    shadowColor: V.coral,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  plusOn: { borderWidth: 2, borderColor: V.pale },
  label: { fontSize: 10, fontWeight: '700' },
  labelOn: { fontWeight: '800' },
});

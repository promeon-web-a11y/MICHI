/**
 * v3 参照画面と同じ線画アイコン（24x24・線幅1.8）。react-native-svg で描く。
 */
import { useId } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

const PATHS = {
  house: ['m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  user: ['M4 21a8 8 0 0 1 16 0'],
  pin: ['M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z'],
  clock: ['M12 7v5h5'],
  wallet: ['M2 9V5a2 2 0 0 1 2-2h14M16 14h4', 'M4 6h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'],
  message: [
    'M21 11.5a8.4 8.4 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 20a8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  ],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  coffee: ['M4 9h14v4a7 7 0 0 1-14 0V9ZM18 10h2a2 2 0 0 1 0 4h-2M3 21h16', 'M8 3v3M13 3v3'],
  trees: ['m8 4-5 8h10L8 4Zm0 5-6 9h12L8 9ZM8 18v4M18 5l-3 5h6l-3-5Zm0 5-4 7h8l-4-7ZM18 17v5'],
  map: ['m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15'],
  sparkles: ['m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM19 17l.7 1.3L21 19l-1.3.7L19 21l-.7-1.3L17 19l1.3-.7L19 17Z'],
  search: ['m21 21-4.3-4.3'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z'],
  check: ['M20 6 9 17l-5-5'],
  plus: ['M12 5v14M5 12h14'],
  compass: ['m16.2 7.8-2.1 6.4-6.4 2.1 2.1-6.4 6.4-2.1Z'],
  sliders: ['M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4'],
  arrowLeft: ['m12 19-7-7 7-7M19 12H5'],
  arrowUpRight: ['M7 7h10v10M7 17 17 7'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  settings: [
    'M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z',
  ],
} as const;

const CIRCLES: Partial<Record<IconName, { cx: number; cy: number; r: number }[]>> = {
  users: [{ cx: 9, cy: 7, r: 4 }],
  user: [{ cx: 12, cy: 8, r: 4 }],
  pin: [{ cx: 12, cy: 10, r: 2.5 }],
  compass: [{ cx: 12, cy: 12, r: 9 }],
  clock: [{ cx: 12, cy: 12, r: 9 }],
  search: [{ cx: 11, cy: 11, r: 7 }],
  camera: [{ cx: 12, cy: 13, r: 3.5 }],
  settings: [{ cx: 12, cy: 12, r: 3 }],
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  color,
  strokeWidth = 1.8,
  filled = false,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
  /** ハート・しおりの塗り（押下済みの表示） */
  filled?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {PATHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={filled ? color : 'none'}
        />
      ))}
      {(CIRCLES[name] ?? []).map((c) => (
        <Circle key={`${c.cx}-${c.cy}`} cx={c.cx} cy={c.cy} r={c.r} stroke={color} strokeWidth={strokeWidth} fill="none" />
      ))}
    </Svg>
  );
}

/**
 * 親いっぱいに広がる線形グラデーション（写真の上の暗幕・主ボタン・中央の＋）。
 * angle は CSS と同じ向き（180 = 上→下、90 = 左→右）
 */
export function Gradient({
  stops,
  angle = 180,
  style,
  borderRadius,
}: {
  stops: { offset: number; color: string; opacity?: number }[];
  angle?: number;
  style?: StyleProp<ViewStyle>;
  borderRadius?: number;
}) {
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const rad = ((angle - 90) * Math.PI) / 180;
  const x = Math.cos(rad) / 2;
  const y = Math.sin(rad) / 2;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1={0.5 - x} y1={0.5 - y} x2={0.5 + x} y2={0.5 + y}>
            {stops.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity ?? 1} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" rx={borderRadius} ry={borderRadius} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

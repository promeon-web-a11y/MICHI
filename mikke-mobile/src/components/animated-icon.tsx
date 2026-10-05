/**
 * 起動直後のスプラッシュ → アプリ画面へのつなぎ（Mikke ロゴがふわっと消える）。
 * ネイティブのスプラッシュ（app.json の expo-splash-screen）と同じ画像・大きさ・背景色で重ねてから消すので、
 * 切り替わりで見た目が跳ねない。色は plan-theme.ts の背景色（ライト: アイボリー / ダーク: ダークブラウン）と同じ。
 */
import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { usePlanPalette } from '@/plan/plan-theme';

const DURATION = 600;
/** app.json の expo-splash-screen の imageWidth と同じ値にする */
const SPLASH_IMAGE_SIZE = 200;

const splashKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1 }],
    opacity: 1,
  },
  20: {
    opacity: 1,
  },
  70: {
    opacity: 0,
    easing: Easing.out(Easing.quad),
  },
  100: {
    opacity: 0,
    transform: [{ scale: 1.08 }],
    easing: Easing.out(Easing.quad),
  },
});

export function AnimatedSplashOverlay() {
  const c = usePlanPalette();
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const background = [styles.splashOverlay, { backgroundColor: c.background }];
  const image = (
    <Image style={styles.image} source={require('@/assets/images/splash-icon.png')} contentFit="contain" accessibilityLabel="Mikke" />
  );

  return animate ? (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={background}>
      {image}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          setAnimate(true);
        });
      }}
      style={background}>
      {image}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: SPLASH_IMAGE_SIZE,
    height: SPLASH_IMAGE_SIZE,
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
});

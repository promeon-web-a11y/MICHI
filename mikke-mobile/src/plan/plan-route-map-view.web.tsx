/**
 * プラン地図の Web 版。react-native-maps は Web 非対応なので読み込まず、訪問順の一覧を表示する。
 */
import { PlanRouteMapFallback } from './plan-route-map-fallback';
import type { PlanRouteMapViewProps } from './plan-route-map-types';

export function PlanRouteMapView(props: PlanRouteMapViewProps) {
  return <PlanRouteMapFallback {...props} reason="Web ではネイティブ地図に対応していないため、回る順番を一覧で表示しています。" />;
}

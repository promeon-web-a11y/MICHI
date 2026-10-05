import type { RouteMapModel } from './plan-route-map-data';
import type { PlanPalette } from './plan-theme';

/** プラン地図（ネイティブ / Web 代替）の共通 props */
export type PlanRouteMapViewProps = {
  c: PlanPalette;
  model: RouteMapModel;
  /** 選択中の場所（route.stops の index） */
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** 下部カードに隠れないよう確保する余白(px) */
  bottomInset: number;
};

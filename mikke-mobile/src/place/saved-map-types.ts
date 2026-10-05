import type { CurrentLocation } from '@/location/current-location-types';

import type { MapPin, MapRegion } from './saved-map-data';

/**
 * 地図の表示範囲の指示。key が変わった時だけ地図を動かす（ユーザーの操作を勝手に戻さない）。
 * fitPoints があればそれらが収まるように合わせ、無ければ region に移動する。
 */
export type MapCamera = {
  key: string;
  region: MapRegion;
  fitPoints: { latitude: number; longitude: number }[];
};

/** 地図コンポーネント（ネイティブ / Web 代替）の共通 props */
export type SavedMapViewProps = {
  pins: MapPin[];
  selectedId: string | null;
  /** ピンをタップ → id / 地図の何もない所をタップ → null */
  onSelect: (id: string | null) => void;
  /** 下部カードに隠れないよう確保する余白(px) */
  bottomInset: number;
  /** 取得済みの現在地（未取得・未許可なら null。null の間は現在地を描かない） */
  currentLocation: CurrentLocation | null;
  camera: MapCamera | null;
};

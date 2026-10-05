/**
 * 保存マップの Web 版。react-native-maps は Web 非対応なので、地図の代わりにピン一覧を表示する。
 * （localhost:8081 での開発確認用。データ取得・座標の振り分け・選択・下部カードは実機と同じ処理を通る）
 */
import { SavedMapFallback } from './saved-map-fallback';
import type { SavedMapViewProps } from './saved-map-types';

export function SavedMapView(props: SavedMapViewProps) {
  return (
    <SavedMapFallback
      {...props}
      reason="Web ではネイティブ地図に対応していないため、ピンの一覧を表示しています。地図は Android / iOS の Development Build で確認してください。"
    />
  );
}

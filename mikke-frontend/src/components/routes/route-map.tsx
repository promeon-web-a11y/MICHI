// ルートの概略図（立ち寄り先の位置関係と回る順番を示す図。実際の地図タイルではない）。
// 横は「西から東への並び順」で等間隔に、縦は緯度の南北で配置しているだけなので、距離・縮尺は正確ではない
// （近い場所どうしの名前が重ならないようにするため）。
// 実際の地図（Google Maps など）に差し替えるときは、このコンポーネントの中身だけを置き換える。
import type { RouteStop } from "@/content/route-plans";
import { ROUTE_COPY } from "@/content/site";

import { ArrowRightIcon } from "../icons";

const WIDTH = 940;
const HEIGHT = 150;
const PAD_X = 110;
const PAD_Y = 46;
const GRID = 47;

function project(stops: RouteStop[]): { x: number; y: number }[] {
  const lats = stops.map((stop) => stop.latitude);
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  // 西から東への順位（0 が最も西）
  const westToEast = stops.map((_, i) => i).sort((a, b) => stops[a].longitude - stops[b].longitude);
  const step = stops.length > 1 ? (WIDTH - PAD_X * 2) / (stops.length - 1) : 0;
  return stops.map((stop, i) => ({
    x: stops.length > 1 ? PAD_X + westToEast.indexOf(i) * step : WIDTH / 2,
    y: PAD_Y + (maxLat === minLat ? 0.5 : (maxLat - stop.latitude) / (maxLat - minLat)) * (HEIGHT - PAD_Y * 2),
  }));
}

export function RouteMap({ stops, href }: { stops: RouteStop[]; href: string }) {
  const points = project(stops);
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-map">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ROUTE_COPY.map} className="block h-auto w-full">
        <g stroke="var(--border)" strokeWidth="1">
          {Array.from({ length: Math.floor(WIDTH / GRID) }, (_, i) => (
            <path key={`v${i}`} d={`M${(i + 1) * GRID} 0V${HEIGHT}`} />
          ))}
          {Array.from({ length: Math.floor(HEIGHT / GRID) }, (_, i) => (
            <path key={`h${i}`} d={`M0 ${(i + 1) * GRID}H${WIDTH}`} />
          ))}
        </g>
        <polyline
          points={points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="var(--text-primary)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {points.map((p, i) => {
          // 名前は点の下に出す。下寄りの点だけ上に出して、枠からはみ出さないようにする
          const labelAbove = p.y > HEIGHT / 2;
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="12" fill="var(--primary)" />
              <text x={p.x} y={p.y + 4.5} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--on-primary)">
                {i + 1}
              </text>
              <text
                x={p.x}
                y={labelAbove ? p.y - 20 : p.y + 30}
                textAnchor="middle"
                fontSize="14"
                fill="var(--text-primary)"
                stroke="var(--map-background)"
                strokeWidth="4"
                paintOrder="stroke"
              >
                {stops[i].name}
              </text>
            </g>
          );
        })}
      </svg>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute right-3 top-3 flex h-8 items-center gap-1.5 rounded-full bg-background px-3.5 text-xs font-medium transition-colors hover:bg-surface-3"
      >
        {ROUTE_COPY.openMap}
        <ArrowRightIcon width={14} height={14} />
      </a>
    </div>
  );
}

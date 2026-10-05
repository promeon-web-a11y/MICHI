// Google Place Photos の画像を中継する（API キーをブラウザに渡さないため）。
// name は /api/plan が返した「places/…/photos/…」だけを受け付ける。
import { fetchPlacePhoto, PHOTO_NAME_PATTERN } from "@/services/places/google-places";

const PHOTO_WIDTH_PX = 800;

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!PHOTO_NAME_PATTERN.test(name)) return new Response(null, { status: 400 });

  const upstream = await fetchPlacePhoto(name, PHOTO_WIDTH_PX);
  const contentType = upstream?.headers.get("content-type") ?? "";
  if (!upstream || !contentType.startsWith("image/")) return new Response(null, { status: 404 });

  return new Response(upstream.body, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400, immutable" },
  });
}

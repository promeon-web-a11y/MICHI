/**
 * 投稿写真の縮小・アップロード（モバイル版 routes/photo-upload.ts の Web 版）。
 * - <input type="file"> で選んだ写真を、ブラウザの canvas で長辺 1600px・JPEG 品質 0.75 に縮小してから送る
 *   （位置情報などの Exif もこの変換で落ちる。iPhone の HEIC は Safari が選択時に JPEG へ変換する）
 * - アップロード先は非公開バケット route-photos/<user_id>/<post_id>/<ランダム>.jpg（RLS で本人の投稿のフォルダーだけ）
 */
'use client';

import { jwtSubject } from '@/core/auth/jwt';
import { ROUTE_PHOTO_BUCKET, routePhotoPath } from '@/core/routes/route-posts-client';
import { resolveBackend } from '@/core/services/backend';
import type { ApiOptions } from '@/core/services/rest';

const MAX_EDGE = 1600;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** 縮小前の上限（極端に大きいファイルでブラウザが固まらないように） */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('写真（画像ファイル）を選んでください。');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('写真が大きすぎます。別の写真を選んでください。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('この写真は読み込めませんでした。別の写真を選んでください。');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('写真を処理できませんでした。');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  if (!blob) throw new Error('写真を処理できませんでした。');
  return blob;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** アップロードして Storage 上のパスを返す。失敗は利用者向けの文言で投げる */
export async function uploadRoutePhoto(file: File, postId: string, opts: ApiOptions): Promise<string> {
  const backend = resolveBackend(opts.config);
  const userId = jwtSubject(opts.accessToken);
  if (!backend || !opts.accessToken || !userId) throw new Error('ログインが必要です。');
  const blob = await shrink(file);
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('写真が大きすぎます。別の写真を選んでください。');
  const path = routePhotoPath(userId, postId, randomId());
  const res = await fetch(`${backend.baseUrl}/storage/v1/object/${ROUTE_PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: backend.anonKey,
      Authorization: `Bearer ${opts.accessToken}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'false',
    },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403 ? '写真を保存できませんでした（権限）。ログインし直してお試しください。' : '写真を保存できませんでした。通信環境を確認してもう一度お試しください。');
  }
  return path;
}

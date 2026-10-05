/**
 * 投稿写真の選択・縮小・アップロード（端末のみ。Node のテスト対象外）。
 * - 写真ライブラリから1枚選ぶ（expo-image-picker。ライブラリの閲覧に権限の確認は不要）
 * - 長辺 1600px・JPEG 品質 0.75 に縮小してから送る（通信量と Storage の容量を抑える。バケット上限は 5MB）
 * - アップロード先は非公開バケット route-photos/<user_id>/<post_id>/<ランダム>.jpg（RLS で本人の投稿のフォルダーだけ）
 */
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { jwtSubject } from '@/auth/jwt';
import { resolveBackend } from '@/services/backend';
import type { ApiOptions } from '@/services/rest';

import { ROUTE_PHOTO_BUCKET, routePhotoPath } from './route-posts-client';

const MAX_EDGE = 1600;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type PickedPhoto = { uri: string; width: number; height: number };

/** 写真を1枚選ぶ。キャンセルなら null */
export async function pickPhoto(): Promise<PickedPhoto | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
  if (result.canceled || !result.assets?.[0]) return null;
  const a = result.assets[0];
  return { uri: a.uri, width: a.width, height: a.height };
}

async function shrink(photo: PickedPhoto): Promise<string> {
  const context = ImageManipulator.ImageManipulator.manipulate(photo.uri);
  const longEdge = Math.max(photo.width, photo.height);
  if (longEdge > MAX_EDGE) {
    context.resize(photo.width >= photo.height ? { width: MAX_EDGE, height: null } : { width: null, height: MAX_EDGE });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
  return saved.uri;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some((b) => b !== 0)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** アップロードして Storage 上のパスを返す。失敗は利用者向けの文言で投げる */
export async function uploadRoutePhoto(photo: PickedPhoto, postId: string, opts: ApiOptions): Promise<string> {
  const backend = resolveBackend(opts.config);
  const userId = jwtSubject(opts.accessToken);
  if (!backend || !opts.accessToken || !userId) throw new Error('ログインが必要です。');
  const uri = await shrink(photo);
  const blob = await (await fetch(uri)).blob();
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
    const detail = await res.text().catch(() => '');
    throw new Error(res.status === 401 || res.status === 403 ? `写真を保存できませんでした（権限）。${__DEV__ ? detail.slice(0, 80) : ''}` : '写真を保存できませんでした。通信環境を確認してもう一度お試しください。');
  }
  return path;
}

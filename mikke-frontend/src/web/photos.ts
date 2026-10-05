/**
 * 投稿写真（非公開バケット route-photos）の署名付きURLを、画面に出ている分だけまとめて取得してキャッシュする
 * （モバイル版 routes/use-photo-url.ts と同じ仕組み）。見る権限の無い写真は URL が発行されない（「写真なし」表示）。
 */
'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { signRoutePhotoUrls } from '@/core/routes/route-posts-client';

import { apiOptions, registerUserCacheReset } from './auth';

const EXPIRES_IN_S = 3600;
/** 期限の少し前に取り直す */
const MARGIN_MS = 5 * 60_000;

type Entry = { url: string | null; expiresAt: number };
let cache = new Map<string, Entry>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

registerUserCacheReset(() => {
  cache = new Map();
  queue = new Set();
  emit();
});

function flush() {
  timer = null;
  const paths = [...queue];
  queue = new Set();
  if (paths.length === 0) return;
  void signRoutePhotoUrls(paths, { ...apiOptions(), expiresIn: EXPIRES_IN_S }).then((r) => {
    const expiresAt = Date.now() + EXPIRES_IN_S * 1000 - MARGIN_MS;
    const found = new Map(r.ok ? r.data.map((s) => [s.path, s.url]) : []);
    // 失敗・権限なしは短時間だけ「無し」として覚える（何度も問い合わせない）
    paths.forEach((p) => cache.set(p, { url: found.get(p) ?? null, expiresAt: found.has(p) ? expiresAt : Date.now() + 60_000 }));
    emit();
  });
}

function request(path: string) {
  const hit = cache.get(path);
  if (hit && hit.expiresAt > Date.now()) return;
  queue.add(path);
  if (!timer) timer = setTimeout(flush, 30);
}

/** 写真を差し替えた直後など、次の表示で取り直す */
export function forgetPhotoUrl(path: string) {
  cache.delete(path);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function cachedUrl(path: string): string | null {
  const hit = cache.get(path);
  return hit && hit.expiresAt > Date.now() ? hit.url : null;
}

export function usePhotoUrl(path: string | null | undefined): string | null {
  const url = useSyncExternalStore(
    subscribe,
    () => (path ? cachedUrl(path) : null),
    () => null
  );
  useEffect(() => {
    if (path) request(path);
  }, [path]);
  return url;
}

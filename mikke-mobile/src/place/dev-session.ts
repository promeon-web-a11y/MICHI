/**
 * 互換レイヤー。ログイン状態の正本は auth/session-store.ts。
 * 既存の import（@/place/dev-session）を壊さないために残している。新しいコードは auth/session-store を使う。
 */
export * from '@/auth/session-store';

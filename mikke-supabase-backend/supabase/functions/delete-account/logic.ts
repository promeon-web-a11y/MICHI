// delete-account の判定ロジック（Deno / Node 両方で動く。Supabase への通信は deps で注入してテストする）。
//
// 設計:
//   - 削除対象はリクエストの JWT から Supabase Auth が確定したユーザーだけ。本文の user_id / email 等は受け付けない
//   - 削除は auth.users の hard delete（soft delete は CASCADE が動かず個人データが残るため使わない）
//     → public.users / saved_places / plans / plan_items / visits は既存の FK CASCADE で削除され、
//       events は既存トリガー（anonymize_events_before_user_delete）で匿名化される（docs/account-deletion-runbook.md）
//   - 誤呼び出し防止に confirm の固定値を必須にする

export const CONFIRM_VALUE = "delete_my_account";

export type DeleteStatus = "deleted" | "unauthorized" | "invalid_request" | "error";

export type DeleteResponse = { status: DeleteStatus; reason: string };

export type DeleteDeps = {
  /** JWT を Supabase Auth で検証し、本人の user id を返す（無効なら null） */
  getUserId: (jwt: string) => Promise<string | null>;
  /** auth.users を hard delete する。notFound: すでに存在しない */
  deleteUser: (userId: string) => Promise<{ ok: true } | { ok: false; notFound: boolean; detail: string }>;
  /** user id・JWT・メールは渡さない */
  log: (event: string, detail: Record<string, unknown>) => void;
};

export function makeResponse(status: DeleteStatus, reason: string): DeleteResponse {
  return { status, reason };
}

export function httpStatusFor(status: DeleteStatus): number {
  switch (status) {
    case "deleted":
      return 200;
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    default:
      return 500;
  }
}

/** "Bearer <jwt>" から JWT を取り出す */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** 本文は { confirm: "delete_my_account" } だけを受け付ける（user_id 等の指定は拒否） */
export function validateDeleteRequest(body: unknown): { ok: true } | { ok: false; code: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "invalid_body" };
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((k) => k !== "confirm")) return { ok: false, code: "unexpected_field" };
  if ((body as Record<string, unknown>).confirm !== CONFIRM_VALUE) return { ok: false, code: "confirmation_required" };
  return { ok: true };
}

export async function deleteAccount(
  input: { authorization: string | null; body: unknown },
  deps: DeleteDeps,
): Promise<DeleteResponse> {
  const jwt = bearerToken(input.authorization);
  if (!jwt) return makeResponse("unauthorized", "authentication_required");

  const validation = validateDeleteRequest(input.body);
  if (!validation.ok) return makeResponse("invalid_request", validation.code);

  let userId: string | null;
  try {
    userId = await deps.getUserId(jwt);
  } catch (e) {
    deps.log("delete_account_auth_check_failed", { message: String(e).slice(0, 200) });
    return makeResponse("error", "auth_check_failed");
  }
  if (!userId) return makeResponse("unauthorized", "invalid_session");

  let result: Awaited<ReturnType<DeleteDeps["deleteUser"]>>;
  try {
    result = await deps.deleteUser(userId);
  } catch (e) {
    deps.log("delete_account_failed", { message: String(e).slice(0, 200) });
    return makeResponse("error", "delete_failed");
  }
  if (result.ok) {
    deps.log("delete_account_succeeded", {});
    return makeResponse("deleted", "account_deleted");
  }
  if (result.notFound) {
    // 同時に届いた2回目のリクエスト等。結果として削除済み
    deps.log("delete_account_already_deleted", {});
    return makeResponse("deleted", "already_deleted");
  }
  deps.log("delete_account_failed", { message: result.detail.slice(0, 200) });
  return makeResponse("error", "delete_failed");
}

// ---------------------------------------------------------------------------------------------
// 投稿写真（route-photos/<user_id>/<post_id>/<file>）の削除
// ---------------------------------------------------------------------------------------------
// DB の行は CASCADE で消えるが Storage のファイルは消えないため、auth.users を消す前に消す。
// Storage の list は1回1000件までなので、フォルダー（投稿）・ファイルとも最後までページングする。
// 一覧を取り終えてから消す（消しながら offset で進めると取りこぼすため）。

export const ROUTE_PHOTO_BUCKET = "route-photos";
export const PHOTO_LIST_PAGE = 1000;
export const PHOTO_REMOVE_CHUNK = 100;
/** 異常な量で関数が止まらないようにする上限（投稿写真は1投稿4枚程度） */
export const PHOTO_MAX_ENTRIES = 50_000;

export type StorageEntry = { name: string; id: string | null };
export type PhotoStorage = {
  list: (
    prefix: string,
    options: { limit: number; offset: number },
  ) => Promise<{ data: StorageEntry[] | null; error: { message: string } | null }>;
  remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
};
export type PhotoCleanupResult = { listed: number; removed: number; failed: number; complete: boolean };

async function listAll(storage: PhotoStorage, prefix: string, budget: { left: number }): Promise<StorageEntry[] | null> {
  const out: StorageEntry[] = [];
  for (let offset = 0; ; offset += PHOTO_LIST_PAGE) {
    const { data, error } = await storage.list(prefix, { limit: PHOTO_LIST_PAGE, offset });
    if (error) return null;
    const page = data ?? [];
    out.push(...page);
    budget.left -= page.length;
    if (page.length < PHOTO_LIST_PAGE || budget.left <= 0) return out;
  }
}

export async function removeUserRoutePhotos(
  storage: PhotoStorage,
  userId: string,
  log: DeleteDeps["log"],
): Promise<PhotoCleanupResult> {
  const budget = { left: PHOTO_MAX_ENTRIES };
  let complete = true;
  const top = await listAll(storage, userId, budget);
  if (!top) {
    log("delete_account_photo_list_failed", {});
    return { listed: 0, removed: 0, failed: 0, complete: false };
  }
  const paths: string[] = [];
  for (const entry of top) {
    if (entry.id !== null) {
      paths.push(`${userId}/${entry.name}`); // フォルダー直下のファイル（通常は無い）
      continue;
    }
    const files = await listAll(storage, `${userId}/${entry.name}`, budget);
    if (!files) {
      complete = false;
      continue;
    }
    for (const f of files) if (f.id !== null) paths.push(`${userId}/${entry.name}/${f.name}`);
  }
  if (budget.left <= 0) complete = false;

  let removed = 0;
  let failed = 0;
  for (let i = 0; i < paths.length; i += PHOTO_REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + PHOTO_REMOVE_CHUNK);
    let { error } = await storage.remove(chunk);
    if (error) ({ error } = await storage.remove(chunk)); // 一時的な失敗に1回だけ再試行
    if (error) failed += chunk.length;
    else removed += chunk.length;
  }
  if (failed > 0) complete = false;
  // user_id・パスは出さない（件数だけ）
  log(complete ? "delete_account_photos_removed" : "delete_account_photo_cleanup_incomplete", {
    listed: paths.length,
    removed,
    failed,
  });
  return { listed: paths.length, removed, failed, complete };
}

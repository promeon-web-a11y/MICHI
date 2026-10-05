/**
 * 採用済みプランを ID で読み、v3 の画面共通の ApiResult 形式にする（記録入力・過去のルート）。
 */
import { apiFail, type ApiOptions, type ApiResult } from '../services/rest';

import { fetchAcceptedPlan, type TodayPlan } from './today-plan-client';

export async function loadAcceptedPlan(planId: string, opts: ApiOptions): Promise<ApiResult<TodayPlan>> {
  const r = await fetchAcceptedPlan(planId, opts);
  if (r.status === 'ok') return { ok: true, data: r.plan };
  if (r.status === 'none') return apiFail('not_found', 'plan not found', 'このルートは見つかりませんでした。');
  return apiFail(r.status === 'unauthorized' ? 'unauthorized' : 'server', r.devDetail, r.message);
}

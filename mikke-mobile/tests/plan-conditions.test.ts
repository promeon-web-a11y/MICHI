/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCurrentLocationStore, toPlanOrigin } from '../src/location/current-location-service';
import type { CurrentLocation } from '../src/location/current-location-types';
import { locationProvider as webLocationProvider } from '../src/location/location-provider.web';
import {
  budgetLabel,
  buildPlanConditions,
  DEFAULT_PLAN_DRAFT,
  durationLabel,
  PLAN_CONDITIONS_VERSION,
  PLAN_ISSUE_MESSAGES,
  sanitizeDraft,
  setBudget,
  setDuration,
  summarizeConditions,
  togglePreference,
  toggleTransport,
  type PlanDraft,
} from '../src/plan/plan-conditions';
import { createPlanDraftStore } from '../src/plan/plan-draft-store';

const LOCATION: CurrentLocation = {
  latitude: 43.0687,
  longitude: 141.3508,
  accuracy: 42.4,
  timestamp: Date.UTC(2026, 8, 26, 1, 0, 0),
  source: 'current',
};
const NOW = () => new Date(Date.UTC(2026, 8, 26, 1, 5, 0));

describe('初期状態・下書きの操作', () => {
  it('1. 初期状態: 現在地から・3時間・〜3,000円・徒歩＋電車＋バス・おまかせ', () => {
    assert.deepEqual(DEFAULT_PLAN_DRAFT, {
      origin: { type: 'current_location' },
      durationMinutes: 180,
      budgetYen: 3000,
      transportModes: ['walking', 'train', 'bus'],
      preferences: ['omakase'],
    });
    assert.deepEqual(createPlanDraftStore().getState(), { draft: DEFAULT_PLAN_DRAFT, submitted: null });
  });

  it('2. 時間変更（分に正規化）', () => {
    for (const [minutes, label] of [[60, '1時間'], [120, '2時間'], [180, '3時間'], [240, '4時間'], [360, '6時間'], [480, '半日']] as const) {
      const d = setDuration(DEFAULT_PLAN_DRAFT, minutes);
      assert.equal(d.durationMinutes, minutes);
      assert.equal(durationLabel(minutes), label);
    }
    // 将来の自由入力にも対応できる範囲（30分〜12時間）
    assert.equal(setDuration(DEFAULT_PLAN_DRAFT, 90).durationMinutes, 90);
    assert.equal(durationLabel(90), '1時間30分');
  });

  it('3. 予算変更（気にしない = null）', () => {
    assert.equal(setBudget(DEFAULT_PLAN_DRAFT, 1000).budgetYen, 1000);
    assert.equal(setBudget(DEFAULT_PLAN_DRAFT, 10000).budgetYen, 10000);
    assert.equal(setBudget(DEFAULT_PLAN_DRAFT, null).budgetYen, null);
    assert.equal(budgetLabel(null), '予算は気にしない');
    assert.equal(budgetLabel(5000), '〜5,000円');
  });

  it('4. 移動手段の複数選択（順序は選択肢の並び）', () => {
    let d = toggleTransport(DEFAULT_PLAN_DRAFT, 'car');
    assert.deepEqual(d.transportModes, ['walking', 'train', 'bus', 'car']);
    d = toggleTransport(d, 'train');
    assert.deepEqual(d.transportModes, ['walking', 'bus', 'car']);
  });

  it('5. 最後の移動手段は解除できない', () => {
    let d: PlanDraft = { ...DEFAULT_PLAN_DRAFT, transportModes: ['walking', 'car'] };
    d = toggleTransport(d, 'walking');
    assert.deepEqual(d.transportModes, ['car']);
    const same = toggleTransport(d, 'car');
    assert.equal(same, d, '変更なし（同じオブジェクト）');
    assert.deepEqual(same.transportModes, ['car']);
  });

  it('6. 気分: 複数選択・おまかせは排他・3つまで・全部外すとおまかせ', () => {
    let d = togglePreference(DEFAULT_PLAN_DRAFT, 'cafe');
    assert.deepEqual(d.preferences, ['cafe'], 'おまかせは外れる');
    d = togglePreference(d, 'eat');
    d = togglePreference(d, 'sightseeing');
    assert.deepEqual(d.preferences, ['eat', 'cafe', 'sightseeing']);
    assert.equal(togglePreference(d, 'active'), d, '4つ目は追加しない');
    d = togglePreference(d, 'omakase');
    assert.deepEqual(d.preferences, ['omakase'], 'おまかせを選ぶと他は外れる');
    d = togglePreference(togglePreference(d, 'relaxing'), 'relaxing');
    assert.deepEqual(d.preferences, ['omakase'], '全部外すとおまかせに戻る');
  });

  it('15. 不正な値は入らない', () => {
    for (const bad of [0, 29, 721, 90.5, -60, NaN, '180', null, undefined]) {
      assert.equal(setDuration(DEFAULT_PLAN_DRAFT, bad), DEFAULT_PLAN_DRAFT, `duration ${String(bad)}`);
    }
    for (const bad of [0, -1000, 1500.5, 2_000_000, '3000', undefined, NaN]) {
      assert.equal(setBudget(DEFAULT_PLAN_DRAFT, bad), DEFAULT_PLAN_DRAFT, `budget ${String(bad)}`);
    }
    assert.equal(toggleTransport(DEFAULT_PLAN_DRAFT, 'plane'), DEFAULT_PLAN_DRAFT);
    assert.equal(togglePreference(DEFAULT_PLAN_DRAFT, 'nightlife'), DEFAULT_PLAN_DRAFT);
    assert.deepEqual(
      sanitizeDraft({
        durationMinutes: 9999,
        budgetYen: -5,
        transportModes: ['plane', 'car', 'car'],
        preferences: ['cafe', 'eat', 'active', 'shopping', 'x'],
      }),
      {
        origin: { type: 'current_location' },
        durationMinutes: 180,
        budgetYen: 3000,
        transportModes: ['car'],
        preferences: ['eat', 'cafe', 'shopping'],
      }
    );
    assert.deepEqual(sanitizeDraft({ transportModes: [], preferences: ['omakase', 'cafe'] }).transportModes, ['walking', 'train', 'bus']);
    assert.deepEqual(sanitizeDraft({ preferences: ['omakase', 'cafe'] }).preferences, ['omakase']);
    assert.deepEqual(sanitizeDraft(null), DEFAULT_PLAN_DRAFT);
  });
});

describe('buildPlanConditions', () => {
  it('14・7・10. 現在地あり＋保存Placeあり → PlanConditions（toPlanOrigin を再利用）', () => {
    const draft = togglePreference(toggleTransport(setBudget(setDuration(DEFAULT_PLAN_DRAFT, 240), null), 'car'), 'cafe');
    const r = buildPlanConditions({ draft, location: LOCATION, savedPlaceCount: 23, now: NOW });
    assert.ok(r.ok);
    assert.deepEqual(r.conditions, {
      version: PLAN_CONDITIONS_VERSION,
      origin: { type: 'current_location', ...toPlanOrigin(LOCATION) },
      duration_minutes: 240,
      budget_yen: null,
      transport_modes: ['walking', 'train', 'bus', 'car'],
      preferences: ['cafe'],
      saved_place_count: 23,
      created_at: '2026-09-26T01:05:00.000Z',
    });
    assert.deepEqual(r.conditions.origin, {
      type: 'current_location',
      latitude: 43.0687,
      longitude: 141.3508,
      accuracy_m: 42,
      captured_at: '2026-09-26T01:00:00.000Z',
    });
  });

  it('8・9. 現在地未取得 / 拒否（location=null）→ origin_missing', () => {
    const r = buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: null, savedPlaceCount: 5 });
    assert.deepEqual(r, { ok: false, issues: ['origin_missing'] });
    assert.equal(PLAN_ISSUE_MESSAGES.origin_missing, '出発地点（現在地）を取得してください');
  });

  it('11. 保存Place 0件 → no_saved_places', () => {
    assert.deepEqual(buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: LOCATION, savedPlaceCount: 0 }), {
      ok: false,
      issues: ['no_saved_places'],
    });
  });

  it('12. 未ログイン → unauthorized', () => {
    assert.deepEqual(buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: LOCATION, savedPlaceCount: 'unauthorized' }), {
      ok: false,
      issues: ['unauthorized'],
    });
  });

  it('13. 保存Place取得エラー・読み込み中（count=null）→ saved_places_unavailable', () => {
    assert.deepEqual(buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: null, savedPlaceCount: null }), {
      ok: false,
      issues: ['saved_places_unavailable', 'origin_missing'],
    });
  });

  it('移動手段0件などの壊れた下書きでも最終値は検証済み', () => {
    const broken = { ...DEFAULT_PLAN_DRAFT, transportModes: [], durationMinutes: -1 } as unknown as PlanDraft;
    const r = buildPlanConditions({ draft: broken, location: LOCATION, savedPlaceCount: 1, now: NOW });
    assert.ok(r.ok);
    assert.deepEqual(r.conditions.transport_modes, ['walking', 'train', 'bus']);
    assert.equal(r.conditions.duration_minutes, 180);
  });

  it('確認表示は日本語の要約（JSON を見せない）', () => {
    const r = buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: LOCATION, savedPlaceCount: 23, now: NOW });
    assert.ok(r.ok);
    const lines = summarizeConditions(r.conditions);
    assert.deepEqual(lines, [
      '📍 現在地から',
      '⏰ 3時間',
      '💴 〜3,000円',
      '🚶 徒歩・電車・地下鉄・バス',
      '✨ おまかせ',
      '🗂 保存した23スポットから',
    ]);
    assert.ok(!lines.join('').includes('43.0687'), '座標は表示しない');
  });
});

describe('条件ストア（画面遷移で消えない）', () => {
  it('操作が保持され、条件を変えると確定済みの条件は破棄される', () => {
    const store = createPlanDraftStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.setDuration(60);
    store.toggleTransport('car');
    store.togglePreference('eat');
    assert.equal(store.getState().draft.durationMinutes, 60);
    const r = buildPlanConditions({ draft: store.getState().draft, location: LOCATION, savedPlaceCount: 3, now: NOW });
    assert.ok(r.ok);
    store.submit(r.conditions);
    assert.equal(store.getState().submitted?.duration_minutes, 60);
    store.setBudget(1000);
    assert.equal(store.getState().submitted, null);
    assert.ok(notified >= 5);
  });

  it('無効な操作では通知しない', () => {
    const store = createPlanDraftStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.setDuration(-1);
    store.toggleTransport('plane');
    assert.equal(notified, 0);
  });
});

describe('16. Web（位置情報未対応）でも条件画面のロジックは例外なし', () => {
  it('現在地は unsupported → 出発地点が未取得として扱われる', async () => {
    const store = createCurrentLocationStore({ provider: webLocationProvider });
    const r = await store.locate({ prompt: true });
    assert.deepEqual(r, { ok: false, reason: 'unsupported' });
    const built = buildPlanConditions({ draft: DEFAULT_PLAN_DRAFT, location: store.getState().location, savedPlaceCount: 3 });
    assert.deepEqual(built, { ok: false, issues: ['origin_missing'] });
  });
});

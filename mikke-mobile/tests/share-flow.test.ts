/**
 * Step 4-9: 共有 → 特定 → 保存 の流れ（一般ユーザー向け）。API はモック。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IdentifyCallResult, IdentifyPlaceRequest, IdentifyPlaceResponse, ScoredPlace } from '../src/place/identify-place-client';
import type { SavePlaceRequest, SaveResult, SaveStatus } from '../src/place/save-place-client';
import { createShareFlow, isShareFlowFinished, MAX_LOGIN_RESUMES, MAX_REVIEW_CANDIDATES } from '../src/share/share-flow';

const request: IdentifyPlaceRequest = { url: 'https://www.instagram.com/p/abc/', text: '札幌 #森彦', source: 'instagram' };

const place = (id: string, name = `店${id}`): ScoredPlace => ({
  google_place_id: id,
  name,
  formatted_address: `札幌市 ${id}`,
  latitude: 43,
  longitude: 141,
  primary_type: 'cafe',
  types: ['cafe'],
  business_status: 'OPERATIONAL',
  score: 0.7,
  score_detail: { name: 0.7, area: null, category: null, closed_penalty: false },
});

function response(status: IdentifyPlaceResponse['status'], extra: Partial<IdentifyPlaceResponse> = {}): IdentifyCallResult {
  return {
    ok: true,
    httpStatus: 200,
    data: {
      status,
      confidence: 0.9,
      reason: 'test',
      message: '',
      input: { source: 'instagram', url: request.url, has_text: true, warnings: [] },
      extraction: null,
      extraction_candidates: [],
      insufficient_reason: null,
      searches: [],
      place: null,
      candidates: [],
      error: null,
      ...extra,
    },
  };
}

const saveResult = (status: SaveStatus): SaveResult => ({ status, message: '', httpStatus: 200, data: null, devDetail: null });

function harness(identifyResults: IdentifyCallResult[], saveResults: SaveResult[] = []) {
  const identifyCalls: IdentifyPlaceRequest[] = [];
  const saveCalls: SavePlaceRequest[] = [];
  let saved = 0;
  let unauthorized = 0;
  const flow = createShareFlow({
    identify: async (r) => {
      identifyCalls.push(r);
      return identifyResults.shift() ?? response('error');
    },
    save: async (r) => {
      saveCalls.push(r);
      return saveResults.shift() ?? saveResult('error');
    },
    onSaved: () => saved++,
    onUnauthorized: () => unauthorized++,
  });
  return { flow, identifyCalls, saveCalls, saved: () => saved, unauthorized: () => unauthorized };
}

describe('share flow', () => {
  it('confirmed は自動で保存し、特定は1回だけ', async () => {
    const h = harness([response('confirmed', { place: place('p1') })], [saveResult('saved')]);
    const phases: string[] = [];
    h.flow.subscribe(() => phases.push(h.flow.getState().phase));
    await h.flow.start(request);
    await h.flow.start(request); // 2回目は無視
    assert.deepEqual(phases, ['identifying', 'saving', 'saved']);
    assert.equal(h.identifyCalls.length, 1);
    assert.equal(h.saveCalls.length, 1);
    assert.equal(h.saveCalls[0].place.google_place_id, 'p1');
    assert.equal(h.saveCalls[0].identification.selected_by_user, false);
    assert.equal(h.saved(), 1);
    const s = h.flow.getState();
    assert.equal(s.phase === 'saved' && s.alreadySaved, false);
    assert.equal(isShareFlowFinished(s), true);
  });

  it('already_saved は「すでに保存されています」として完了', async () => {
    const h = harness([response('confirmed', { place: place('p1') })], [saveResult('already_saved')]);
    await h.flow.start(request);
    const s = h.flow.getState();
    assert.equal(s.phase === 'saved' && s.alreadySaved, true);
  });

  it('needs_review は自動保存せず、選んだ候補だけを保存する', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => place(`c${i}`));
    const h = harness([response('needs_review', { candidates })], [saveResult('saved')]);
    await h.flow.start(request);
    const s = h.flow.getState();
    assert.equal(s.phase, 'needs_review');
    assert.equal(s.phase === 'needs_review' && s.candidates.length, MAX_REVIEW_CANDIDATES);
    assert.equal(h.saveCalls.length, 0);

    await h.flow.choose('unknown-id'); // 候補にない ID は保存しない
    assert.equal(h.saveCalls.length, 0);
    await h.flow.choose('c2');
    assert.equal(h.saveCalls.length, 1);
    assert.equal(h.saveCalls[0].place.google_place_id, 'c2');
    assert.equal(h.saveCalls[0].identification.selected_by_user, true);
    assert.equal(h.flow.getState().phase, 'saved');
  });

  it('needs_review で「保存しない」を選べる', async () => {
    const h = harness([response('needs_review', { candidates: [place('c1')] })]);
    await h.flow.start(request);
    h.flow.skip();
    assert.equal(h.flow.getState().phase, 'skipped');
    assert.equal(h.saveCalls.length, 0);
    assert.equal(isShareFlowFinished(h.flow.getState()), true);
  });

  it('保存中の二重タップは無視する', async () => {
    let release!: (r: SaveResult) => void;
    const saveCalls: string[] = [];
    const flow = createShareFlow({
      identify: async () => response('needs_review', { candidates: [place('c1'), place('c2')] }),
      save: (r) => {
        saveCalls.push(r.place.google_place_id);
        return new Promise((resolve) => (release = resolve));
      },
    });
    await flow.start(request);
    const first = flow.choose('c1');
    await flow.choose('c2');
    flow.skip();
    assert.deepEqual(saveCalls, ['c1']);
    release(saveResult('saved'));
    await first;
    assert.equal(flow.getState().phase, 'saved');
  });

  it('not_found / insufficient_information は保存せず理由を表示（技術用語なし）', async () => {
    for (const status of ['not_found', 'insufficient_information'] as const) {
      const h = harness([response(status)]);
      await h.flow.start(request);
      const s = h.flow.getState();
      assert.equal(s.phase, 'no_place');
      if (s.phase === 'no_place') assert.doesNotMatch(s.title + s.body, /HTTP|JSON|API|Edge|Supabase|OpenAI/);
      assert.equal(h.saveCalls.length, 0);
    }
  });

  it('URL も文章も無い共有は通信せずに終える', async () => {
    const h = harness([]);
    await h.flow.start(null);
    assert.equal(h.flow.getState().phase, 'no_place');
    assert.equal(h.identifyCalls.length, 0);
  });

  it('特定の失敗はやり直せる（失敗中は完了扱いにしない）', async () => {
    const h = harness(
      [
        { ok: false, kind: 'timeout', httpStatus: null, userMessage: '時間内に応答がありませんでした。', devDetail: 'x' },
        response('confirmed', { place: place('p1') }),
      ],
      [saveResult('saved')]
    );
    await h.flow.start(request);
    const s = h.flow.getState();
    assert.equal(s.phase, 'failed');
    assert.equal(isShareFlowFinished(s), false);
    await h.flow.retry();
    assert.equal(h.flow.getState().phase, 'saved');
    assert.equal(h.identifyCalls.length, 2);
  });

  it('保存の失敗は、特定をやり直さずに保存だけやり直す', async () => {
    const h = harness([response('confirmed', { place: place('p1') })], [saveResult('error'), saveResult('saved')]);
    await h.flow.start(request);
    assert.equal(h.flow.getState().phase, 'failed');
    await h.flow.retry();
    assert.equal(h.flow.getState().phase, 'saved');
    assert.equal(h.identifyCalls.length, 1);
    assert.equal(h.saveCalls.length, 2);
  });

  it('未ログインなら need_login になり、ログイン後に続きから再開する', async () => {
    const h = harness(
      [{ ok: false, kind: 'auth', httpStatus: 401, userMessage: 'ログインが必要です', devDetail: '' }, response('confirmed', { place: place('p1') })],
      [saveResult('saved')]
    );
    await h.flow.start(request);
    assert.equal(h.flow.getState().phase, 'need_login');
    assert.equal(h.unauthorized(), 1);
    await h.flow.resumeAfterLogin();
    assert.equal(h.flow.getState().phase, 'saved');
  });

  it('保存でログイン切れ → ログイン後は保存から再開（特定は再実行しない）', async () => {
    const h = harness([response('confirmed', { place: place('p1') })], [saveResult('unauthorized'), saveResult('saved')]);
    await h.flow.start(request);
    assert.equal(h.flow.getState().phase, 'need_login');
    await h.flow.resumeAfterLogin();
    assert.equal(h.flow.getState().phase, 'saved');
    assert.equal(h.identifyCalls.length, 1);
  });

  it('ログイン後の自動再開には上限がある（認証が通り続けない場合の無限ループ防止）', async () => {
    const auth: IdentifyCallResult = { ok: false, kind: 'auth', httpStatus: 401, userMessage: '', devDetail: '' };
    const h = harness(Array.from({ length: 10 }, () => auth));
    await h.flow.start(request);
    for (let i = 0; i < 5; i++) await h.flow.resumeAfterLogin();
    assert.equal(h.identifyCalls.length, 1 + MAX_LOGIN_RESUMES);
    assert.equal(h.flow.getState().phase, 'failed');
  });
});

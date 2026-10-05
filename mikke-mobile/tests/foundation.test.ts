/**
 * 工程1-B の共通基盤: logger の秘密情報の伏せ字と、旧 path からの互換 re-export。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as authSession from '../src/auth/auth-session';
import { appLog, clearLogEntries, getLogEntries, redactSecrets } from '../src/lib/logger';
import * as identifyClient from '../src/place/identify-place-client';
import * as backend from '../src/services/backend';
import * as shareLogger from '../src/share/logger';

describe('redactSecrets', () => {
  it('JWT・Bearer・APIキー・メールアドレスを伏せる', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
    const text = `token ${jwt} / Authorization: Bearer abc.def-123 / sk-proj-abcdefghijkl / AIzaSyA1234567890abcdefghijk / user@example.com`;
    const out = redactSecrets(text);
    assert.ok(!out.includes(jwt));
    assert.ok(!out.includes('abc.def-123'));
    assert.ok(!out.includes('sk-proj-abcdefghijkl'));
    assert.ok(!out.includes('AIzaSyA1234567890abcdefghijk'));
    assert.ok(!out.includes('user@example.com'));
    assert.match(out, /\[jwt\]/);
    assert.match(out, /\[email\]/);
  });

  it('JSON の秘密情報キーの値を伏せ、それ以外は残す', () => {
    const json = JSON.stringify({ password: 'hunter2hunter2', refresh_token: 'r-123', duration_minutes: 120 });
    const out = redactSecrets(json);
    assert.ok(!out.includes('hunter2hunter2'));
    assert.ok(!out.includes('r-123'));
    assert.match(out, /"duration_minutes":120/);
  });

  it('秘密情報を含まない文字列は変えない', () => {
    const text = 'プラン条件を確定しました https://www.instagram.com/p/abc/';
    assert.equal(redactSecrets(text), text);
  });
});

describe('appLog', () => {
  it('メッセージと detail を伏せ字にして保持する', () => {
    clearLogEntries();
    appLog.warn('認証: user@example.com', { accessToken: 'secret-access', plan_id: 'p1' });
    const [entry] = getLogEntries();
    assert.equal(entry.level, 'warn');
    assert.ok(!entry.message.includes('user@example.com'));
    assert.ok(!entry.detail?.includes('secret-access'));
    assert.match(entry.detail ?? '', /"plan_id": "p1"/);
    clearLogEntries();
  });
});

describe('旧 path からの互換 re-export', () => {
  it('share/logger は lib/logger と同じ実体', () => {
    assert.equal(shareLogger.shareLog, appLog);
    assert.equal(shareLogger.getShareLogEntries, getLogEntries);
  });

  it('identify-place-client は services/backend・auth/auth-session と同じ実体', () => {
    assert.equal(identifyClient.resolveBackend, backend.resolveBackend);
    assert.equal(identifyClient.fetchWithTimeout, backend.fetchWithTimeout);
    assert.equal(identifyClient.isAbortError, backend.isAbortError);
    assert.equal(identifyClient.isSessionValid, authSession.isSessionValid);
    assert.equal(identifyClient.signInWithPassword, authSession.signInWithPassword);
    assert.equal(identifyClient.EMAIL_NOT_CONFIRMED_MESSAGE, authSession.EMAIL_NOT_CONFIRMED_MESSAGE);
  });
});

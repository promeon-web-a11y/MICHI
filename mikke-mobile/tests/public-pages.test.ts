/**
 * Step 5-1: 公開ページ（利用規約など）の URL の一元管理。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_WEB_BASE_URL, PUBLIC_PAGES, publicPageUrl, resolveWebBaseUrl } from '../src/constants/public-pages';

describe('public pages', () => {
  it('未設定・不正な値なら既定の Web URL を使う', () => {
    for (const raw of [undefined, null, '', '   ', 'not a url', 'http://example.com', 'javascript:alert(1)', 'https://example.com/?a=1', 'https://example.com/#x']) {
      assert.equal(resolveWebBaseUrl(raw), DEFAULT_WEB_BASE_URL, String(raw));
    }
  });

  it('独自ドメインなどの https URL に切り替えられる（末尾の / は除く）', () => {
    assert.equal(resolveWebBaseUrl(' https://mikke.example.jp/ '), 'https://mikke.example.jp');
    assert.equal(resolveWebBaseUrl('https://example.com/mikke/'), 'https://example.com/mikke');
  });

  it('4つの公開ページの URL を作る', () => {
    assert.deepEqual(Object.keys(PUBLIC_PAGES).sort(), ['accountDelete', 'contact', 'privacy', 'terms']);
    assert.equal(publicPageUrl('terms', 'https://mikke-frontend.vercel.app'), 'https://mikke-frontend.vercel.app/terms');
    assert.equal(publicPageUrl('privacy', 'https://mikke-frontend.vercel.app'), 'https://mikke-frontend.vercel.app/privacy');
    assert.equal(publicPageUrl('contact', 'https://mikke-frontend.vercel.app'), 'https://mikke-frontend.vercel.app/contact');
    assert.equal(publicPageUrl('accountDelete', 'https://mikke-frontend.vercel.app'), 'https://mikke-frontend.vercel.app/account/delete');
  });

  it('既定値は本番の Web URL', () => {
    assert.equal(DEFAULT_WEB_BASE_URL, 'https://mikke-frontend.vercel.app');
  });
});

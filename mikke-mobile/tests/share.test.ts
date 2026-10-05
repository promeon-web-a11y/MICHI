/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processSharePayloads } from '../src/share/process-share-payloads';
import { detectSource, extractUrls, normalizeSharedUrl } from '../src/share/url-utils';

describe('extractUrls', () => {
  it('URL単体', () => {
    assert.deepEqual(extractUrls('https://www.instagram.com/reel/abc123/'), [
      'https://www.instagram.com/reel/abc123/',
    ]);
  });

  it('文章＋URL（改行区切り）', () => {
    assert.deepEqual(extractUrls('この投稿をチェック！\nhttps://www.instagram.com/reel/abc123/'), [
      'https://www.instagram.com/reel/abc123/',
    ]);
  });

  it('日本語と隣接・末尾の句読点を含めない', () => {
    assert.deepEqual(extractUrls('見て！https://youtu.be/xyz。すごい'), ['https://youtu.be/xyz']);
    assert.deepEqual(extractUrls('(https://example.com/a).'), ['https://example.com/a']);
  });

  it('括弧を含むURLは保持', () => {
    assert.deepEqual(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)'), [
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('複数URLは出現順・重複なし', () => {
    assert.deepEqual(extractUrls('https://a.com/1 https://b.com/2 https://a.com/1'), [
      'https://a.com/1',
      'https://b.com/2',
    ]);
  });

  it('URLなし・不正入力でも例外なし', () => {
    assert.deepEqual(extractUrls('URLはありません'), []);
    assert.deepEqual(extractUrls(''), []);
    assert.deepEqual(extractUrls(undefined), []);
    assert.deepEqual(extractUrls(123), []);
    assert.deepEqual(extractUrls('ftp://example.com/file https://localhost/'), []);
  });
});

describe('detectSource', () => {
  const cases: [string, string][] = [
    ['https://www.instagram.com/reel/abc/', 'instagram'],
    ['https://instagram.com/p/abc/', 'instagram'],
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://vt.tiktok.com/ZSabc/', 'tiktok'],
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://m.youtube.com/shorts/abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://tabelog.com/tokyo/', 'web'],
    ['https://notinstagram.com/p/abc', 'web'],
    ['https://instagram.com.evil.example/p/abc', 'web'],
    ['not a url', 'web'],
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => assert.equal(detectSource(url), expected));
  }
});

describe('normalizeSharedUrl', () => {
  it('Instagram: igsh / utm_* のみ削除', () => {
    assert.equal(
      normalizeSharedUrl('https://www.instagram.com/reel/abc123/?igsh=MTIzNDU2&utm_source=ig_web_copy_link'),
      'https://www.instagram.com/reel/abc123/'
    );
    assert.equal(
      normalizeSharedUrl('https://www.instagram.com/p/abc/?img_index=2&igshid=xx'),
      'https://www.instagram.com/p/abc/?img_index=2'
    );
  });

  it('TikTok: 共有用パラメータを削除', () => {
    assert.equal(
      normalizeSharedUrl(
        'https://www.tiktok.com/@shop/video/7300000000000000000?_r=1&_t=8abc&is_from_webapp=1&sender_device=pc'
      ),
      'https://www.tiktok.com/@shop/video/7300000000000000000'
    );
    assert.equal(normalizeSharedUrl('https://vt.tiktok.com/ZSabc123/'), 'https://vt.tiktok.com/ZSabc123/');
  });

  it('YouTube: si / feature を削除し v / t / list は保持', () => {
    assert.equal(
      normalizeSharedUrl('https://youtu.be/abc?si=XYZ&t=42'),
      'https://youtu.be/abc?t=42'
    );
    assert.equal(
      normalizeSharedUrl('https://www.youtube.com/watch?v=abc&list=PL1&feature=shared'),
      'https://www.youtube.com/watch?v=abc&list=PL1'
    );
  });

  it('Web: 不明パラメータは残し utm_* / fbclid のみ削除', () => {
    assert.equal(
      normalizeSharedUrl('https://example.com/shop?id=10&ref=abc&utm_medium=social&fbclid=xyz#menu'),
      'https://example.com/shop?id=10&ref=abc#menu'
    );
  });

  it('ホストを小文字化し、パスとエンコードは保持', () => {
    assert.equal(
      normalizeSharedUrl('https://WWW.Example.COM/%E3%82%AB%E3%83%95%E3%82%A7?q=a+b%20c'),
      'https://www.example.com/%E3%82%AB%E3%83%95%E3%82%A7?q=a+b%20c'
    );
  });

  it('SNS固有パラメータは他サイトでは削除しない', () => {
    assert.equal(normalizeSharedUrl('https://example.com/?si=1&_t=2'), 'https://example.com/?si=1&_t=2');
  });

  it('不正URLはそのまま返す', () => {
    assert.equal(normalizeSharedUrl('not a url'), 'not a url');
  });
});

describe('processSharePayloads', () => {
  it('URL共有（shareType=url）', () => {
    const result = processSharePayloads([
      { shareType: 'url', mimeType: 'text/plain', value: 'https://www.instagram.com/reel/abc/?igsh=1' },
    ]);
    assert.equal(result.primaryUrl, 'https://www.instagram.com/reel/abc/?igsh=1');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/reel/abc/');
    assert.equal(result.source, 'instagram');
    assert.equal(result.receivedText, null);
    assert.deepEqual(result.errors, []);
  });

  it('文章＋URL（shareType=text）', () => {
    const result = processSharePayloads([
      { shareType: 'text', mimeType: 'text/plain', value: 'この投稿をチェック！\nhttps://vt.tiktok.com/ZSabc/' },
    ]);
    assert.equal(result.receivedText, 'この投稿をチェック！\nhttps://vt.tiktok.com/ZSabc/');
    assert.equal(result.primaryUrl, 'https://vt.tiktok.com/ZSabc/');
    assert.equal(result.source, 'tiktok');
  });

  it('未知のWebサイト → web', () => {
    const result = processSharePayloads([{ shareType: 'url', value: 'https://tabelog.com/tokyo/A1301/' }]);
    assert.equal(result.source, 'web');
  });

  it('複数URLではSNSを優先し警告', () => {
    const result = processSharePayloads([
      { shareType: 'text', value: '詳細 https://example.com/x と https://youtu.be/abc?si=1' },
    ]);
    assert.equal(result.primaryUrl, 'https://youtu.be/abc?si=1');
    assert.equal(result.normalizedUrl, 'https://youtu.be/abc');
    assert.equal(result.urls.length, 2);
    assert.ok(result.warnings.some((w) => w.includes('2 件')));
  });

  it('text と url が同時に来た場合は url を優先', () => {
    const result = processSharePayloads([
      { shareType: 'text', value: 'おすすめ https://example.com/blog' },
      { shareType: 'url', value: 'https://www.instagram.com/p/xyz/' },
    ]);
    assert.equal(result.primaryUrl, 'https://www.instagram.com/p/xyz/');
    assert.equal(result.receivedText, 'おすすめ https://example.com/blog');
  });

  it('resolved の contentUri からもURLを拾う', () => {
    const result = processSharePayloads(
      [{ shareType: 'url', value: '' }],
      [{ contentType: 'website', contentUri: 'https://youtube.com/watch?v=1', contentMimeType: 'text/html' }]
    );
    assert.equal(result.primaryUrl, 'https://youtube.com/watch?v=1');
    assert.equal(result.items[0].contentType, 'website');
  });

  it('不正・空の Payload でも例外なし', () => {
    const inputs: unknown[] = [
      [],
      undefined,
      null,
      'string',
      [null, 1, 'x', {}],
      [{ shareType: 'text', value: 'URLなし' }],
      [{ shareType: 'url', value: 'https://' }],
      [{ shareType: 'image', value: 'file:///tmp/a.jpg', mimeType: 'image/jpeg' }],
    ];
    for (const input of inputs) {
      const result = processSharePayloads(input, 'broken');
      assert.equal(result.primaryUrl, null);
      assert.equal(result.source, null);
      assert.ok(result.warnings.length + result.errors.length > 0);
    }
  });
});

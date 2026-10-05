/**
 * ページを再読み込みしても、作ったプランの提案と出発地点を失わないようにする（このタブの sessionStorage だけ。
 * タブを閉じると消える）。iPhone の Safari は、Google マップなどへ移って戻ると再読み込みすることがあるため。
 * 保存・読み込みに失敗しても（プライベートブラウズ等）何もしない。
 */
'use client';

export function readSession<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: unknown) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても画面は動く
  }
}

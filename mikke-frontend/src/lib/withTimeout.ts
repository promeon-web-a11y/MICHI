// 通信のタイムアウトだけを検知する汎用ラッパー。API呼び出し自体の実装には手を入れない。
// 元のPromiseが先に解決/拒否すればそのまま結果を返し、指定時間内に終わらなければ
// TimeoutErrorで拒否する（元のリクエストを中断するわけではない）。

export class TimeoutError extends Error {
  constructor() {
    super("request_timeout");
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// OpenAI（Responses API・Structured Outputs）呼び出し。サーバー専用（Route Handler からだけ使う）。
// mikke-supabase-backend の Edge Functions（generate-plan-options / identify-place）と同じ呼び出し方・同じ環境変数名。
//   OPENAI_API_KEY    … API キー（NEXT_PUBLIC_ を付けない。ブラウザには渡らない）
//   OPENAI_PLAN_MODEL … Structured Outputs に対応したモデル名

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 30_000;

export type AiResult = { ok: true; text: string } | { ok: false; code: string; retryable: boolean };

export function openAiConfig(): { apiKey: string; model: string } | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_PLAN_MODEL?.trim();
  return apiKey && model ? { apiKey, model } : null;
}

/** ログに API キー・トークンを残さない */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_\-*]{6,}/g, "sk-[redacted]")
    .replace(/AIza[A-Za-z0-9_\-]{10,}/g, "AIza[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}

function outputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { output_text?: unknown; output?: unknown };
  if (typeof p.output_text === "string" && p.output_text) return p.output_text;
  for (const item of Array.isArray(p.output) ? p.output : []) {
    const contents = (item as { content?: unknown })?.content;
    for (const content of Array.isArray(contents) ? contents : []) {
      const c = content as { type?: unknown; text?: unknown };
      if (c?.type === "refusal") return null;
      if (typeof c?.text === "string" && c.text) return c.text;
    }
  }
  return null;
}

/** JSON Schema どおりの JSON 文字列を1回だけ取りに行く（再試行は呼び出し側で決める） */
export async function callStructured(args: {
  schemaName: string;
  schema: unknown;
  system: string;
  user: string;
}): Promise<AiResult> {
  const config = openAiConfig();
  if (!config) return { ok: false, code: "not_configured", retryable: false };

  let response: Response;
  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        store: false,
        input: [
          { role: "system", content: [{ type: "input_text", text: args.system }] },
          { role: "user", content: [{ type: "input_text", text: args.user }] },
        ],
        text: { format: { type: "json_schema", name: args.schemaName, strict: true, schema: args.schema } },
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error("[mikke] openai_request_failed", redactSecrets(String(e)));
    return { ok: false, code: timedOut ? "timeout" : "network_error", retryable: !timedOut };
  }
  if (!response.ok) {
    const detail = redactSecrets((await response.text().catch(() => "")).slice(0, 300));
    console.error("[mikke] openai_http_error", response.status, detail);
    return { ok: false, code: `http_${response.status}`, retryable: response.status === 429 || response.status >= 500 };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: "response_not_json", retryable: true };
  }
  const status = (payload as { status?: unknown })?.status;
  if (typeof status === "string" && status !== "completed") return { ok: false, code: `response_${status}`, retryable: true };
  const text = outputText(payload);
  return text ? { ok: true, text } : { ok: false, code: "output_missing_or_refused", retryable: true };
}

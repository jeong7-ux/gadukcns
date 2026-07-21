// =====================================================================
// lib/ai/openrouter.ts — OpenRouter chat 공용 헬퍼 (scripts/ai.mjs 패턴 재사용)
//   수집 시 AI 분류(FR-23)·온디맨드 요약 등 서버 측 LLM 호출에 공통 사용.
// =====================================================================
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

export function openRouterKey(): string | null {
  return process.env.OPENROUTER_API_KEY || null;
}

// 저수준 chat 호출(1회 재시도). 실패 시 throw.
export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number; tries?: number } = {}
): Promise<string> {
  const key = openRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY 미설정");
  const model = opts.model || process.env.CLASSIFY_MODEL || process.env.AI_LLM_MODEL || "anthropic/claude-haiku-4.5";
  const tries = opts.tries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 900 * attempt));
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? 400,
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const out: string | undefined = j?.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error("빈 응답");
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// JSON 강제 파서 — ```json 펜스/앞뒤 텍스트를 관대하게 벗겨 첫 JSON 오브젝트를 파싱.
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// chat + JSON 파싱(파싱 실패 시 1회 재시도). 실패하면 null.
export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number } = {}
): Promise<T | null> {
  const raw = await chat(messages, { ...opts, temperature: 0 });
  const parsed = parseJsonLoose<T>(raw);
  return parsed;
}

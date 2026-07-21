// =====================================================================
// lib/ai/google.ts — Google AI Studio(Gemini) generateContent 공용 헬퍼
//   수집 시 AI 분류(FR-23)·온디맨드 요약(FR-06) 등 서버 측 LLM 호출에 공통 사용.
//   (구 lib/ai/openrouter.ts 대체 — 프로바이더 전면 교체)
//
// OpenAI 호환 레이어(/v1beta/openai/...) 대신 **네이티브 generateContent**를 쓴다.
//   이유: thinkingConfig(사고 예산)·responseMimeType(JSON 강제)를 정식으로 제어해야
//   하기 때문. Gemini 2.5 계열은 기본으로 '사고'가 켜져 있어, 사고 토큰이
//   maxOutputTokens 를 먼저 소진하면 text 가 빈 채 finishReason=MAX_TOKENS 로 끝난다.
//   분류(320토큰)·검증(120토큰)처럼 상한이 작은 호출에서 치명적이라 기본 예산을 0으로 둔다.
// =====================================================================
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const GOOGLE_BASE =
  process.env.GOOGLE_AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

// 기본 모델(저비용·고속). env(AI_LLM_MODEL / CLASSIFY_MODEL)로 재정의 가능.
export const DEFAULT_MODEL = "gemini-2.5-flash";

export function resolveModel(model?: string): string {
  return model || process.env.CLASSIFY_MODEL || process.env.AI_LLM_MODEL || DEFAULT_MODEL;
}

// 키: GOOGLE_AI_API_KEY 우선, GEMINI_API_KEY 별칭 허용(AI Studio 문서 표기 혼용 대응).
export function llmKey(): string | null {
  return process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || null;
}

// 사고 예산: 기본 0(비활성). 음수면 미지정(모델 자동). pro 계열은 0 불가 → 미지정으로 폴백.
function thinkingConfig(model: string): { thinkingBudget: number } | undefined {
  const raw = process.env.GEMINI_THINKING_BUDGET;
  const budget = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(budget) || budget < 0) return undefined;
  if (budget === 0 && /pro/i.test(model)) return undefined; // pro는 사고 비활성 불가
  return { thinkingBudget: budget };
}

// ChatMessage[] → Gemini contents/systemInstruction
//   Gemini는 system을 별도 필드로 받고, assistant를 'model' 역할로 부른다.
function toGeminiPayload(messages: ChatMessage[]) {
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  return {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: sys || "" }] }],
    systemInstruction: sys && contents.length ? { parts: [{ text: sys }] } : undefined,
  };
}

// 저수준 chat 호출(1회 재시도). 실패 시 throw.
export async function chat(
  messages: ChatMessage[],
  opts: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    tries?: number;
    json?: boolean;
  } = {}
): Promise<string> {
  const key = llmKey();
  if (!key) throw new Error("GOOGLE_AI_API_KEY 미설정");
  const model = resolveModel(opts.model);
  const tries = opts.tries ?? 2;
  const { contents, systemInstruction } = toGeminiPayload(messages);
  const think = thinkingConfig(model);

  const body = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig: {
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxTokens ?? 400,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
      ...(think ? { thinkingConfig: think } : {}),
    },
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 900 * attempt));
      const res = await fetch(
        `${GOOGLE_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const cand = j?.candidates?.[0];
      const out: string = (cand?.content?.parts ?? [])
        .map((p: { text?: string }) => p?.text ?? "")
        .join("")
        .trim();
      // 빈 응답의 대부분은 안전차단(SAFETY) 또는 사고 토큰이 상한을 소진(MAX_TOKENS)한 경우.
      if (!out) throw new Error(`빈 응답(finishReason=${cand?.finishReason ?? "unknown"})`);
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

// chat + JSON 파싱. responseMimeType 으로 1차 강제하고, 파서로 2차 방어.
export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number } = {}
): Promise<T | null> {
  const raw = await chat(messages, { ...opts, temperature: 0, json: true });
  const parsed = parseJsonLoose<T>(raw);
  return parsed;
}

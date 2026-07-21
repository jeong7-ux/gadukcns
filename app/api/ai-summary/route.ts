// 온디맨드 AI 요약 (FR-06 실시간) — S-06에서 요약 없을 때 호출.
// 브라우저(anon)는 LLM·bids write 불가 → 서버에서 service_key + Google AI Studio로 생성·저장.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { chat, llmKey, DEFAULT_MODEL } from "@/lib/ai/google";

export const runtime = "nodejs";

// 요약은 분류(CLASSIFY_MODEL)와 독립적으로 지정한다.
const LLM_MODEL = process.env.AI_LLM_MODEL || DEFAULT_MODEL;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const bidNo: string | undefined = body?.bid_no;
    if (!bidNo) return NextResponse.json({ error: "bid_no가 필요합니다." }, { status: 400 });

    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !serviceKey || !llmKey()) {
      return NextResponse.json(
        { error: "서버 환경변수(SUPABASE/GOOGLE_AI_API_KEY)가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    // 인증: 요청자 세션 검증 (active 사용자만 허용)
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
    const authClient = createClient(url, anonKey!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData } = await authClient.auth.getUser();
    if (!userData?.user) return NextResponse.json({ error: "유효하지 않은 세션입니다." }, { status: 401 });

    // 서비스 키로 공고 + 첨부 본문 로드
    const sb = createClient(url, serviceKey);
    const { data: bid } = await sb
      .from("bids")
      .select("bid_no,bid_seq,title,order_org,demand_org,contract_method,est_price,ai_flags")
      .eq("bid_no", bidNo)
      .order("bid_seq", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!bid) return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });

    const { data: atts } = await sb
      .from("bid_attachments")
      .select("extracted_text")
      .eq("bid_no", bidNo)
      .not("extracted_text", "is", null)
      .limit(20);
    const extracted = (atts ?? [])
      .map((a: { extracted_text: string | null }) => a.extracted_text)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000);

    // LLM 요약 (제공 범위 내 요약 — 환각 최소화)
    const sys =
      "당신은 공공조달 입찰공고 분석가입니다. 제공된 정보 범위 내에서만 한국어로 요약하세요. 제공되지 않은 내용은 '명시되지 않음'으로 표기하고 지어내지 마세요.";
    const userMsg = [
      `공고명: ${bid.title ?? "-"}`,
      `발주기관: ${bid.order_org ?? "-"} / 수요기관: ${bid.demand_org ?? "-"}`,
      `계약방법: ${bid.contract_method ?? "-"}`,
      `추정가격: ${bid.est_price ?? "-"}`,
      extracted ? `첨부 본문:\n${extracted}` : "(첨부 본문 없음 — 메타데이터만으로 요약)",
      "",
      "위 정보를 3~5줄 불릿으로 요약한 뒤, '**핵심 요건**' 제목과 함께 항목별(과업범위/참가자격/사업규모/평가방식/주요 일정) Markdown 표를 작성하세요.",
    ].join("\n");

    let summary: string;
    try {
      // 요약은 표(Markdown)까지 생성하므로 분류 호출보다 출력 상한을 넉넉히 준다.
      summary = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        { model: LLM_MODEL, temperature: 0.2, maxTokens: 2000 }
      );
    } catch (e) {
      return NextResponse.json(
        { error: `LLM 호출 실패: ${(e as Error).message.slice(0, 200)}` },
        { status: 502 }
      );
    }
    if (!summary) return NextResponse.json({ error: "요약 생성에 실패했습니다." }, { status: 502 });

    // 저장 (ai_flags 병합)
    const flags = {
      ...((bid.ai_flags as Record<string, unknown> | null) || {}),
      summary_ok: true,
      on_demand: true,
      model: { llm: LLM_MODEL },
      enriched_at: new Date().toISOString(),
    };
    const { error: upErr } = await sb
      .from("bids")
      .update({ ai_summary: summary, ai_flags: flags, updated_at: new Date().toISOString() })
      .eq("bid_no", bid.bid_no)
      .eq("bid_seq", bid.bid_seq);
    if (upErr) return NextResponse.json({ error: `저장 실패: ${upErr.message}` }, { status: 500 });

    return NextResponse.json({ ai_summary: summary, saved: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

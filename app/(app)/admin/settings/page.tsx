"use client";

// S-13 API 키 설정 — FR-12. admin 전용. masked_hint 표시 + 키 변경.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ADMIN_ONLY } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { fmtDateTime } from "@/lib/utils/format";
import type { AppSetting } from "@/lib/supabase/types";

export default function SettingsPage() {
  return (
    <RoleGuard allow={ADMIN_ONLY}>
      <SettingsInner />
    </RoleGuard>
  );
}

// 3종 키 (계약: setting_key = narat_api / supabase_key / llm_key)
const KEYS: { key: string; label: string; desc: string }[] = [
  { key: "narat_api", label: "나라장터 API 키", desc: "입찰공고 수집(collect.mjs)" },
  { key: "supabase_key", label: "DB API (Supabase Service Key)", desc: "서버 적재" },
  {
    key: "llm_key",
    label: "AI API (Google AI Studio)",
    desc: "Gemini — 수집 시 AI 사업분류·공고 요약 (env: GOOGLE_AI_API_KEY)",
  },
];

function SettingsInner() {
  const supabase = getSupabaseClient();

  // value_enc(bytea)는 절대 조회하지 않는다. 마스킹 힌트/메타만.
  const q = useQuery({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("setting_key,key_version,masked_hint,updated_by,updated_at");
      if (error) throw error;
      const map = new Map<string, AppSetting>();
      for (const s of (data as AppSetting[]) ?? []) map.set(s.setting_key, s);
      return map;
    },
  });

  return (
    <div>
      <PageHeader
        title="API 키 설정"
        screen="S-13"
        desc="외부 API 키를 관리합니다. 값은 AES-256-GCM으로 암호화되어 마스킹 힌트만 노출됩니다."
      />

      <div className="space-y-3">
        {KEYS.map((k) => (
          <KeyRow key={k.key} meta={k} setting={q.data?.get(k.key) ?? null} />
        ))}
      </div>

      <p className="mt-4 text-xs text-subtle">
        보안 원칙: 평문 키는 브라우저에 저장/전송하지 않습니다. 실제 암호화(AES-256-GCM,
        APP_MASTER_KEY)와 저장은 서버(Edge Function/스크립트)에서 수행되어야 합니다.
      </p>
    </div>
  );
}

function KeyRow({
  meta,
  setting,
}: {
  meta: { key: string; label: string; desc: string };
  setting: AppSetting | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  function submit() {
    // 클라이언트는 평문을 암호화할 수 없다(마스터키 미보유).
    // 실제 저장은 서버 엔드포인트로 위임 — 여기서는 안내만.
    setMsg(
      "키는 서버(Edge Function)에서 암호화 후 저장됩니다. 서버 엔드포인트 연결이 필요합니다."
    );
    setValue("");
    setEditing(false);
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {meta.label}
            {setting ? (
              <Pill tone="success">설정됨 v{setting.key_version}</Pill>
            ) : (
              <Pill tone="muted">미설정</Pill>
            )}
          </span>
        }
        action={
          !editing && (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              키 변경
            </Button>
          )
        }
      />
      <div className="p-4">
        <p className="text-xs text-subtle">{meta.desc}</p>
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span className="text-subtle">현재:</span>
          <code className="rounded bg-bg px-2 py-0.5 font-mono text-xs">
            {setting?.masked_hint ?? "—"}
          </code>
          {setting && (
            <span className="text-xs text-subtle">
              최종 변경 {fmtDateTime(setting.updated_at)}
            </span>
          )}
        </div>

        {editing && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="새 키 입력"
              className="flex-1 min-w-[220px] rounded-md border border-border px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            />
            <Button onClick={submit} disabled={!value.trim()}>
              저장
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
            >
              취소
            </Button>
          </div>
        )}
        {msg && <p className="mt-2 text-xs text-accent">{msg}</p>}
      </div>
    </Card>
  );
}

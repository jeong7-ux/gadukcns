"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * FR-07 실시간: 지정 테이블 변경 시 react-query 캐시를 무효화한다.
 * 연결 실패/미지원 시 connected=false → 화면은 수동 새로고침으로 폴백.
 */
export function useRealtimeInvalidate(table: string, queryKey: unknown[]) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`realtime:${table}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          qc.invalidateQueries({ queryKey });
        }
      )
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  return { connected };
}

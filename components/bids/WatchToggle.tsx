"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { has, CAN_WATCH_WRITE } from "@/lib/auth/roles";
import { Button } from "@/components/ui/Button";
import type { Bid } from "@/lib/supabase/types";

/**
 * 관심목록 추가/해제 (FR-08). write=strategy/pm/admin (§5).
 * exec은 버튼 미노출(읽기만).
 */
export function WatchToggle({
  bidNo,
  bidSeq,
  bid,
}: {
  bidNo: string;
  bidSeq: string;
  bid: Pick<Bid, "notice_dt" | "deadline_dt">;
}) {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const { role, session } = useSession();
  const canWrite = has(role, CAN_WATCH_WRITE);

  const watchedQ = useQuery({
    queryKey: ["watch", bidNo, bidSeq],
    queryFn: async () => {
      const { data } = await supabase
        .from("watchlist")
        .select("bid_no")
        .eq("bid_no", bidNo)
        .eq("bid_seq", bidSeq)
        .maybeSingle();
      return !!data;
    },
  });

  if (!canWrite) return null;

  async function toggle() {
    if (watchedQ.data) {
      await supabase
        .from("watchlist")
        .delete()
        .eq("bid_no", bidNo)
        .eq("bid_seq", bidSeq);
    } else {
      await supabase.from("watchlist").upsert(
        {
          bid_no: bidNo,
          bid_seq: bidSeq,
          owner: session?.user.id ?? null,
          notice_dt: bid.notice_dt,
          deadline_dt: bid.deadline_dt,
        },
        { onConflict: "bid_no,bid_seq" }
      );
    }
    qc.invalidateQueries({ queryKey: ["watch", bidNo, bidSeq] });
    qc.invalidateQueries({ queryKey: ["watchlist"] });
  }

  return (
    <Button variant={watchedQ.data ? "ghost" : "primary"} onClick={toggle}>
      {watchedQ.data ? "★ 관심 해제" : "☆ 관심 추가"}
    </Button>
  );
}

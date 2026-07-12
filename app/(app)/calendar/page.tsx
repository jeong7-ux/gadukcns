"use client";

// S-08 캘린더 — FR-15. active 전체. 공고일(#2563EB)/마감일(#DC2626).
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventInput } from "@fullcalendar/core";
import { getSupabaseClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import type { Bid } from "@/lib/supabase/types";

// 토큰 값(캘린더 이벤트 색은 FullCalendar에 HEX로 넘겨야 하므로 CSS 변수에서 읽음)
function tokenColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim() || fallback
  );
}

export default function CalendarPage() {
  const supabase = getSupabaseClient();
  const router = useRouter();
  const [show, setShow] = useState<{ notice: boolean; deadline: boolean }>({
    notice: true,
    deadline: true,
  });

  const q = useQuery({
    queryKey: ["calendar-bids"],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10); // 시스템 날짜(오늘)
      const { data, error } = await supabase
        .from("bids")
        .select("bid_no,bid_seq,title,notice_dt,deadline_dt")
        .is("archived_at", null) // 정리(아카이브)된 공고 숨김
        .gte("score", 4) // 현황 기준: 스코어링 가중치 4이상 룰 매칭 공고만
        .or(`deadline_dt.gte.${today},deadline_dt.is.null`) // 마감된 사업 제외(마감일 미정은 유지)
        .limit(500);
      if (error) throw error;
      return (data as Pick<
        Bid,
        "bid_no" | "bid_seq" | "title" | "notice_dt" | "deadline_dt"
      >[]) ?? [];
    },
  });

  const events = useMemo<EventInput[]>(() => {
    const noticeColor = tokenColor("--color-accent", "#2563EB");
    const deadlineColor = tokenColor("--color-danger", "#DC2626");
    const out: EventInput[] = [];
    for (const b of q.data ?? []) {
      if (show.notice && b.notice_dt) {
        out.push({
          id: `n-${b.bid_no}`,
          title: `[공고] ${b.title ?? b.bid_no}`,
          start: b.notice_dt,
          backgroundColor: noticeColor,
          borderColor: noticeColor,
          extendedProps: { bidNo: b.bid_no },
        });
      }
      if (show.deadline && b.deadline_dt) {
        out.push({
          id: `d-${b.bid_no}`,
          title: `[마감] ${b.title ?? b.bid_no}`,
          start: b.deadline_dt,
          backgroundColor: deadlineColor,
          borderColor: deadlineColor,
          extendedProps: { bidNo: b.bid_no },
        });
      }
    }
    return out;
  }, [q.data, show]);

  return (
    <div>
      <PageHeader
        title="캘린더"
        screen="S-08"
        desc="공고일/마감일을 월 단위로 확인합니다. (스코어링 가중치 4이상 관련 공고 기준)"
        action={
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={show.notice}
                onChange={(e) => setShow({ ...show, notice: e.target.checked })}
              />
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
              공고일
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={show.deadline}
                onChange={(e) =>
                  setShow({ ...show, deadline: e.target.checked })
                }
              />
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-danger" />
              마감일
            </label>
          </div>
        }
      />
      <Card className="p-4">
        <FullCalendar
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          locale="ko"
          height="auto"
          headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
          buttonText={{ today: "오늘" }}
          events={events}
          eventClick={(info) => {
            const bidNo = info.event.extendedProps.bidNo as string;
            if (bidNo) router.push(`/bids/${encodeURIComponent(bidNo)}`);
          }}
        />
      </Card>
    </div>
  );
}

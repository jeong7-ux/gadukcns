/**
 * data-architect 계약(01_data-architect_contract.md) / supabase/schema.sql 정렬 타입.
 * 필드/타입 추측 금지 — 계약과 어긋나면 여기부터 고친다.
 */

export type Role = "exec" | "strategy" | "pm" | "admin";
export type UserStatus =
  | "unverified"
  | "pending"
  | "active"
  | "rejected"
  | "suspended";
export type BidStatus = "ongoing" | "today" | "closed"; // 생성 컬럼(§3)
export type MatchLogic = "AND" | "OR";

export interface UserRow {
  user_id: string;
  email_hash: string;
  name: string;
  dept: "경영진" | "전략기획" | "사업관리" | "경영지원";
  role: Role;
  status: UserStatus;
  phone_hash: string | null;
  subscribe_cond: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KeywordGroup {
  group_id: number;
  name: string;
  keywords: string[];
  match_logic: MatchLogic;
  exclude: string[];
  owner: string | null;
  created_at: string;
}

export interface Bid {
  bid_no: string;
  bid_seq: string;
  title: string | null;
  order_org: string | null;
  demand_org: string | null;
  contract_method: string | null;
  notice_dt: string | null;
  deadline_dt: string | null;
  open_dt: string | null;
  est_price: number | null;
  status: BidStatus | null; // 읽기 전용 생성 컬럼
  score: number;
  tags: string[] | null;
  ai_summary: string | null;
  ai_score: number | null;
  ai_flags: AiFlags | null;
  raw: Record<string, unknown> | null;
  updated_at: string;
  /** 수집 시 AI 사업분류(감리/컨설팅). null이면 미분류 */
  biz_category?: "감리" | "컨설팅" | null;
  /** 목록 표시용 파생값 — bid_attachments 개수(fetchBids에서 채움) */
  attachment_count?: number;
  /** 목록 표시용 파생값 — 발주/수요기관이 우선 고객사와 매칭되면 채움(FR-18) */
  client_name?: string | null;
}

/** 고객사 카테고리(FR-16) */
export type ClientCategory =
  | "중앙정부부처"
  | "지방자치단체"
  | "공공기관"
  | "의료기관"
  | "교육기관"
  | "금융기관"
  | "기타";

/** 고객사 마스터(FR-16) */
export interface Client {
  client_id: number;
  name: string;
  category: ClientCategory;
  aliases: string[] | null;
  sector: string | null;
  region: string | null;
  is_priority: boolean;
  weight: number;
  memo: string | null;
  source_url: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

/**
 * ai-engineer 계약(03_ai_scripts.md §3.4) 확정.
 * ai.mjs는 추천 인력(FR-10)을 ai_flags.matches 에 기록한다(최대 5명, match_score 내림차순).
 */
export interface AiFlags {
  matches?: MatchedMember[];
  requirements?: string[];
  [k: string]: unknown;
}

export interface MatchedMember {
  member_id: string;
  name: string;
  tech_grade: string;
  specialty_field: string | null;
  license_name: string | null;
  career_years: number | null;
  work_type: string;
  match_score?: number;
  reasons?: string[];
}

export interface BidPrice {
  bid_no: string;
  base_amount: number | null;
  est_price: number | null;
  preprice_range: string | null;
  eval_base_amount: number | null;
  public_dt: string | null;
}

export interface BidChange {
  id: number;
  bid_no: string;
  change_item: string | null;
  before_val: string | null;
  after_val: string | null;
  changed_dt: string | null;
}

export interface BidAttachment {
  id: number;
  bid_no: string;
  bid_seq: string;
  seq: number | null;
  doc_type: string | null;
  file_name: string | null;
  file_url: string | null;
  storage_path: string | null;
  extracted_text: string | null;
  downloaded: boolean;
  fetched_at: string;
}

export type AnalysisStatus = "none" | "requested" | "in_progress" | "done";

export interface WatchItem {
  bid_no: string;
  bid_seq: string;
  owner: string | null;
  analysis_status: AnalysisStatus;
  proposal_status: "none" | "writing" | "done";
  decision: "review" | "join" | "drop";
  notice_dt: string | null;
  deadline_dt: string | null;
  memo: string | null;
  updated_at: string;
}

/** AI 분석 결과파일 종류(FR-22, 7종) */
export const ANALYSIS_DOC_TYPES = [
  "분석보고서",
  "1페이지상세요약",
  "1페이지인포그래픽",
  "PT요약보고서",
  "영역별감리계획",
  "논리구조서",
  "통합감리제안서초안",
] as const;
export type AnalysisDocType = (typeof ANALYSIS_DOC_TYPES)[number];

export interface AnalysisReport {
  id: number;
  bid_no: string;
  bid_seq: string;
  doc_type: AnalysisDocType;
  file_name: string;
  storage_path: string;
  size_bytes: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface Member {
  member_id: string;
  name: string;
  work_type: "상근" | "비상근";
  tech_grade: string;
  license_name: string | null;
  association_no: string | null;
  status: "재직" | "휴직" | "퇴직";
  specialty_field: string | null;
  career_years: number | null;
  license_expiry: string | null;
  reg_date: string;
  updated_at: string;
}

export interface Rule {
  id: number;
  type: "keyword" | "org" | "exclude" | "contract";
  pattern: string;
  weight: number;
  is_active: boolean;
}

export interface AppSetting {
  setting_key: string; // narat_api / supabase_key / llm_key
  key_version: number;
  masked_hint: string | null;
  updated_by: string | null;
  updated_at: string;
  // value_enc(bytea)는 클라이언트에 노출하지 않는다.
}

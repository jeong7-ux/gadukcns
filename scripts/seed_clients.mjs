// 고객사 39곳 시드 (라이브 수집 결과, gadukcns.com/41). 멱등 upsert(name 유니크).
// 사용: node --env-file=.env.local scripts/seed_clients.mjs
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SRC = 'http://www.gadukcns.com/41';

const DATA = {
  '중앙정부부처': ['경찰청','국가기록원','국민권익위원회','문화재청','보건복지부','산림청','소방청','질병관리청','해양수산부','행정안전부','헌법재판소','농림축산검역본부','대통령기록관'],
  '지방자치단체': ['서울특별시','울산광역시','인천시 서구'],
  '공공기관': ['한국광해관리공단','한국등산트래킹지원센터','한국보건의료정보원','한국사회복지정보원','한국지역정보개발원'],
  '금융기관': ['금융감독원'],
  '의료기관': ['건양대학교병원','경북대학교병원','고려대학교의료원','국립재활원','국립정신건강센터','부산대학교병원','분당서울대학교병원','삼성서울병원','서울대학교병원','서울아산병원','연세세브란스병원','전국의료원연합회','전남대학교병원','전북대학교병원','충북대학교병원','가톨릭대학교 서울성모병원','한림대학교성심병원'],
};

const rows = [];
for (const [category, names] of Object.entries(DATA)) {
  for (const name of names) {
    rows.push({ name, category, is_priority: true, weight: 10, sector: category === '의료기관' ? '보건·의료' : null, source_url: SRC });
  }
}

const { error } = await sb.from('clients').upsert(rows, { onConflict: 'name' });
if (error) { console.error('[FATAL] clients upsert 실패:', error.message); process.exit(1); }
const { count } = await sb.from('clients').select('client_id', { count: 'exact', head: true });
console.log(`[done] 고객사 시드 완료 — upsert ${rows.length}건, 현재 clients ${count}건`);

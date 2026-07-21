// 아주 단순한 인메모리 TTL 캐시.
// 같은 (날짜·시도·박수·인원) 조회를 짧은 시간 반복해도 사이트를 다시 안 때리게 한다.
// (실서비스에선 Redis/SQLite 등으로 교체)

const store = new Map();

export function getCached(key, ttlMs) {
  const e = store.get(key);
  if (e && Date.now() - e.at < ttlMs) return e.value;
  return null;
}

export function setCached(key, value) {
  store.set(key, { at: Date.now(), value });
}

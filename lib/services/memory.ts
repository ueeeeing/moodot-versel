import { getSupabaseBrowserClient } from "@/lib/supabase/client"
import logger from "@/lib/logger"
import type { MemoryMutationInput } from "@/lib/memory-validation"

// ---------- Types ----------

export type MemoryRow = {
  id: number
  title: string | null
  text: string | null
  image_url: string | null
  emotion_id: number | null
  with_whom: string | null
  memory_at: string | null
  place_name: string | null
  location_label: string | null
  location_lat: number | null
  location_lng: number | null
  processed: boolean | null
}

export type CreateMemoryInput = MemoryMutationInput

export type UpdateMemoryInput = MemoryMutationInput

type ApiErrorResponse = {
  error?: string
}

async function getErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as ApiErrorResponse
    if (typeof data.error === "string" && data.error.trim() !== "") {
      return data.error
    }
  } catch {
    // 응답 본문이 JSON이 아니어도 기존 흐름 유지
  }

  return `요청이 실패했습니다. (${response.status})`
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(input, {
    ...init,
    headers,
  })

  if (!response.ok) {
    throw new Error(await getErrorMessage(response))
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

// ---------- Queries ----------

/** 목록 조회 (memory_at 내림차순). limit/offset 미전달 시 전체 반환. 에러 시 throw. */
export async function getMemories(limit?: number, offset?: number): Promise<MemoryRow[]> {
  if (limit !== undefined) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset ?? 0) })
    return requestJson<MemoryRow[]>(`/api/memories?${params.toString()}`)
  }
  return requestJson<MemoryRow[]>("/api/memories")
}

const RECENT_MEMORIES_TTL_MS = 30_000

type RecentCacheEntry = { data: MemoryRow[]; ts: number }
const _recentMemoriesCache = new Map<string, RecentCacheEntry>()
let _recentMemoriesCacheGen = 0

const _recentMemoriesInflight = new Map<string, Promise<MemoryRow[]>>()

/**
 * recent memories 캐시를 무효화한다.
 *
 * generation을 증가시켜 두 가지를 동시에 보장한다.
 * 1. 이미 진행 중인 fetch가 완료되어도 캐시에 저장되지 않는다 (gen 불일치).
 * 2. getRecentMemories의 in-flight 키가 generation을 포함하므로, 이 시점 이후의
 *    호출자는 구 gen의 in-flight를 공유하지 않고 새 fetch를 시작한다.
 *    → auth 전환 전 시작된 fetch 결과가 새 auth 사용자의 UI에 반영되지 않는다.
 *
 * limit 미지정(전체 무효화) 시 in-flight Map도 함께 비운다.
 * gen-scoped 키 덕분에 이후 같은 gen의 동시 호출은 여전히 dedup된다.
 */
export function invalidateRecentMemoriesCache(limit?: number): void {
  _recentMemoriesCacheGen++
  if (limit !== undefined) {
    _recentMemoriesCache.delete(`recent:${limit}`)
  } else {
    _recentMemoriesCache.clear()
    _recentMemoriesInflight.clear()
  }
}

/**
 * 최신 N개 (memory_at 내림차순).
 * in-flight 키에 현재 auth generation을 포함해 auth 전환 전후 요청을 격리한다.
 * 동일 gen의 동시 호출은 하나의 요청으로 합산된다.
 * 에러 시 throw.
 */
export function getRecentMemories(limit: number): Promise<MemoryRow[]> {
  const cacheKey = `recent:${limit}`
  const cached = _recentMemoriesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < RECENT_MEMORIES_TTL_MS) {
    return Promise.resolve(cached.data)
  }

  const url = `/api/memories?${new URLSearchParams({ limit: String(limit) })}`
  // in-flight 키에 gen을 포함한다.
  // gen이 바뀐 이후의 호출자는 다른 키를 보게 되어 구 세션의 Promise를 공유하지 않는다.
  // 401/4xx/5xx는 requestJson이 throw하므로 .then()이 실행되지 않아 캐시에 저장되지 않는다.
  const gen = _recentMemoriesCacheGen
  const inflightKey = `${gen}:${url}`

  const inflight = _recentMemoriesInflight.get(inflightKey)
  if (inflight) return inflight

  const promise = requestJson<MemoryRow[]>(url)
    .then((data) => {
      if (_recentMemoriesCacheGen === gen) {
        _recentMemoriesCache.set(cacheKey, { data, ts: Date.now() })
      }
      return data
    })
    .finally(() => {
      _recentMemoriesInflight.delete(inflightKey)
    })

  _recentMemoriesInflight.set(inflightKey, promise)
  return promise
}

/** 단건 조회. 에러 시 throw. */
export async function getMemoryById(id: number): Promise<MemoryRow> {
  return requestJson<MemoryRow>(`/api/memories/${id}`)
}

// ---------- Mutations ----------

/** 새 메모리 생성. 에러 시 throw. */
export async function createMemory(input: CreateMemoryInput): Promise<number> {
  const supabase = getSupabaseBrowserClient()

  // 세션 확인 — 없으면 익명 로그인 후 재시도
  let { data: { user } } = await supabase.auth.getUser()
  logger.debug("[createMemory] getUser:", user?.id ?? "null", "| is_anonymous:", user?.is_anonymous ?? "-")

  if (!user) {
    logger.debug("[createMemory] 세션 없음 → signInAnonymously")
    const { data, error: anonErr } = await supabase.auth.signInAnonymously()
    if (anonErr || !data.user) {
      console.error("[createMemory] signInAnonymously 실패:", anonErr)
      throw new Error("인증에 실패했습니다. 잠시 후 다시 시도해주세요.")
    }
    user = data.user
    logger.debug("[createMemory] 익명 사용자 생성:", user.id)
  }

  const { data: sessionData } = await supabase.auth.getSession()
  logger.debug("[createMemory] access_token:", sessionData.session?.access_token ? "있음" : "없음(MISSING)")

  const data = await requestJson<{ id: number }>("/api/memories", {
    method: "POST",
    body: JSON.stringify(input),
  })

  invalidateRecentMemoriesCache()
  return data.id
}

/** 기존 메모리 수정. 에러 시 throw. */
export async function updateMemory(id: number, input: UpdateMemoryInput): Promise<void> {
  await requestJson<void>(`/api/memories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
  invalidateRecentMemoriesCache()
}

/** 메모리 삭제. 에러 시 throw. */
export async function deleteMemory(id: number): Promise<void> {
  const supabase = getSupabaseBrowserClient()
  const { error } = await supabase.from("memories").delete().eq("id", id)
  if (error) throw error
  invalidateRecentMemoriesCache()
}

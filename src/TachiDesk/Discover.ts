import {
    RequestManager,
    SourceStateManager
} from '@paperback/types'

import {
    graphqlRequest,
    tachiSources
} from './Common'

// Crunchyroll-style discovery rows, built from one Suwayomi source's own
// filters (sort, genre tags, anime adaptation, adult content). Filters are
// looked up by name, so positions shifting between source versions is fine;
// a source without a matching filter just skips that part of the row.

export const DISCOVER_SOURCE_NAME = "Weeb Central"

export type DiscoverRowStyle = "featured" | "singleRowNormal" | "singleRowLarge" | "doubleRow"

export interface DiscoverRow {
    key: string
    title: string
    style: DiscoverRowStyle
    sort: string
    animeOnly?: boolean
    ongoingOnly?: boolean
    tag?: string
    seriesTypes?: string[]
}

const GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Mystery", "Romance",
    "Sci-fi", "Slice of Life", "Supernatural", "Horror", "Psychological",
    "Sports", "Historical"
]

export const DISCOVER_ROWS: DiscoverRow[] = [
    // Same large portrait tiles as Most Popular; the user preferred them to banner art
    { key: "hero", title: "Trending Now", style: "singleRowLarge", sort: "Popularity", ongoingOnly: true },
    { key: "new", title: "Newly Added", style: "singleRowNormal", sort: "Recently Added" },
    { key: "popular", title: "Most Popular", style: "singleRowLarge", sort: "Popularity" },
    { key: "anime", title: "Now an Anime", style: "singleRowNormal", sort: "Popularity", animeOnly: true },
    // Webtoons: Korean manhwa and Chinese manhua (vertical-scroll, usually full color)
    { key: "webtoonPopular", title: "Popular Webtoons", style: "singleRowNormal", sort: "Popularity", seriesTypes: ["Manhwa", "Manhua"] },
    { key: "webtoonNew", title: "New Webtoons", style: "singleRowNormal", sort: "Recently Added", seriesTypes: ["Manhwa", "Manhua"] },
    ...GENRES.map((genre): DiscoverRow => ({
        key: "genre" + genre.replace(/[^A-Za-z]/g, ""),
        title: genre,
        style: "singleRowNormal",
        sort: "Popularity",
        tag: genre
    }))
]

export function getDiscoverRow(key: string): DiscoverRow | undefined {
    return DISCOVER_ROWS.find(row => row.key === key)
}

export function findDiscoverSource(sources: Record<string, tachiSources>): tachiSources | undefined {
    return Object.values(sources).find(source => source.displayName.startsWith(DISCOVER_SOURCE_NAME))
}

// ! Source filters

const GQL_SOURCE_FILTERS = `
    query SourceFilters($id: LongString!) {
        source(id: $id) {
            filters {
                __typename
                ... on SelectFilter { name values }
                ... on GroupFilter {
                    name
                    filters {
                        ... on CheckBoxFilter { name }
                        ... on TriStateFilter { name }
                    }
                }
            }
        }
    }
`

interface SourceFilter {
    type: string
    name: string
    values: string[]
    children: string[]
}

// Filter lists only change when the source extension updates; cache per source
const filterCache: Record<string, SourceFilter[]> = {}

async function getSourceFilters(stateManager: SourceStateManager, requestManager: RequestManager, sourceId: string): Promise<SourceFilter[]> {
    const cached = filterCache[sourceId]
    if (cached) return cached

    const res = await graphqlRequest(stateManager, requestManager, GQL_SOURCE_FILTERS, { id: sourceId })
    const filters: SourceFilter[] = (res.data.source.filters ?? []).map((filter: any) => ({
        type: filter.__typename,
        name: filter.name ?? "",
        values: filter.values ?? [],
        children: (filter.filters ?? []).map((child: any) => child.name ?? "")
    }))
    filterCache[sourceId] = filters
    return filters
}

function selectChange(filters: SourceFilter[], name: string, value: string) {
    const position = filters.findIndex(filter => filter.type === "SelectFilter" && filter.name === name)
    const valueIndex = position === -1 ? -1 : (filters[position]?.values.indexOf(value) ?? -1)
    return valueIndex === -1 ? [] : [{ position, selectState: valueIndex }]
}

function groupChange(filters: SourceFilter[], name: string, child: string, change: Record<string, any>) {
    const position = filters.findIndex(filter => filter.type === "GroupFilter" && filter.name === name)
    const childIndex = position === -1 ? -1 : (filters[position]?.children.indexOf(child) ?? -1)
    return childIndex === -1 ? [] : [{ position, groupChange: { position: childIndex, ...change } }]
}

function buildFilterChanges(filters: SourceFilter[], row: DiscoverRow, adultContent: string) {
    return [
        ...selectChange(filters, "Sort", row.sort),
        ...selectChange(filters, "Adult Content", adultContent),
        ...(row.animeOnly ? selectChange(filters, "Anime Adaptation", "True") : []),
        ...(row.ongoingOnly ? groupChange(filters, "Series Status", "Ongoing", { checkBoxState: true }) : []),
        ...(row.tag ? groupChange(filters, "Tags", row.tag, { triState: "INCLUDE" }) : []),
        ...(row.seriesTypes ?? []).flatMap(kind => groupChange(filters, "Series Type", kind, { checkBoxState: true }))
    ]
}

// ! Fetching

const GQL_DISCOVER = `
    mutation Discover($sourceId: LongString!, $page: Int!, $filters: [FilterChangeInput!]) {
        fetchSourceManga(input: { source: $sourceId, type: SEARCH, page: $page, query: "", filters: $filters }) {
            hasNextPage
            mangas {
                id
                title
                thumbnailUrl
                inLibrary
            }
        }
    }
`

export async function fetchDiscoverRow(
    stateManager: SourceStateManager,
    requestManager: RequestManager,
    sourceId: string,
    row: DiscoverRow,
    page: number,
    adultContent: string
): Promise<{ mangas: any[], hasNextPage: boolean }> {
    const filters = await getSourceFilters(stateManager, requestManager, sourceId)
    const res = await graphqlRequest(stateManager, requestManager, GQL_DISCOVER, {
        sourceId,
        page,
        filters: buildFilterChanges(filters, row, adultContent)
    })

    return {
        // Discovery only surfaces series not already in the library
        mangas: res.data.fetchSourceManga.mangas.filter((manga: any) => !manga.inLibrary),
        hasNextPage: res.data.fetchSourceManga.hasNextPage
    }
}

// ! Row cache + concurrency

// Every row waits in Suwayomi's per-source queue (shared with the downloader),
// so firing all rows at once pushed the slowest past the request timeout and
// they rendered empty. Cap parallel fetches and serve rows from a cache.
const MAX_PARALLEL_FETCHES = 3
const ROW_CACHE_TTL_MS = 6 * 60 * 60 * 1000

let activeFetches = 0
const waitingFetches: Array<() => void> = []

async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (activeFetches >= MAX_PARALLEL_FETCHES) {
        await new Promise<void>(resolve => waitingFetches.push(resolve))
    }
    activeFetches++
    try {
        return await task()
    } finally {
        activeFetches--
        waitingFetches.shift()?.()
    }
}

export async function getDiscoverRowMangas(
    stateManager: SourceStateManager,
    requestManager: RequestManager,
    sourceId: string,
    row: DiscoverRow,
    adultContent: string
): Promise<any[]> {
    const cacheKey = "discover_cache_" + row.key
    const cached = await stateManager.retrieve(cacheKey) as { at: number, mangas: any[] } | undefined
    if (cached && Date.now() - cached.at < ROW_CACHE_TTL_MS) return cached.mangas

    try {
        const mangas = (await limited(() => fetchDiscoverRow(stateManager, requestManager, sourceId, row, 1, adultContent))).mangas
        await stateManager.store(cacheKey, { at: Date.now(), mangas })
        return mangas
    } catch (error) {
        // A stale row beats an empty one
        if (cached) return cached.mangas
        throw error
    }
}

// ! Precached feed

// manga-feed (feed/ in this repo, runs on the NAS next to Suwayomi) rebuilds
// every row every few hours with mirrored covers and rendered hero art. One
// LAN request replaces ~20 live scrapes; the live rows above are the fallback.
// Each source passes its own feed port (Panelhouse 4580, Back Room 4581).

export interface FeedRow {
    key: string
    title: string
    style: DiscoverRowStyle
    items: { id: string, title: string, image: string, subtitle?: string }[]
}

export function feedBaseURL(serverURL: string, feedPort: number): string {
    const match = serverURL.match(/^(https?:\/\/[^\/:]+)/)
    return match ? `${match[1]}:${feedPort}/` : ""
}

export interface FeedSource {
    id: string
    name: string
    supportsLatest: boolean
}

export interface Feed {
    rows: FeedRow[]
    // The sources the feed pools (curated first), for live paging past the feed
    sources: FeedSource[]
    // Source pages already in each row; live paging continues after them
    rowPages: number
    // Back Room: Panelhouse's library titles (title keys), hidden from live pages too
    excludeTitles: string[]
}

export async function fetchFeed(requestManager: RequestManager, serverURL: string, feedPort: number): Promise<Feed | undefined> {
    const base = feedBaseURL(serverURL, feedPort)
    if (!base) return undefined
    try {
        const response = await requestManager.schedule(App.createRequest({ url: base + "feed.json", method: "GET" }), 0)
        if (response.status !== 200) return undefined
        const feed = JSON.parse(response.data ?? "")
        const rows: FeedRow[] = feed.rows ?? []
        // An empty feed (e.g. published during an outage) counts as unavailable,
        // so the home page falls back to live rows instead of showing nothing
        if (!rows.some(row => row.items.length > 0)) return undefined
        return {
            // Image paths in the feed are relative to the feed server
            rows: rows.map(row => ({
                ...row,
                items: row.items.map(item => ({ ...item, image: base + item.image }))
            })),
            sources: feed.sources ?? [],
            rowPages: feed.rowPages ?? 2,
            excludeTitles: feed.excludeTitles ?? []
        }
    } catch {
        return undefined
    }
}

export async function fetchFeedRows(requestManager: RequestManager, serverURL: string, feedPort: number): Promise<FeedRow[] | undefined> {
    return (await fetchFeed(requestManager, serverURL, feedPort))?.rows
}

const GQL_LIBRARY_IDS = `
    query LibraryIds {
        mangas(condition: { inLibrary: true }) {
            nodes { id title }
        }
    }
`

export interface LibraryIndex {
    ids: Set<string>
    titles: Set<string>
}

// Same rules as feed/dedupe.py normalize(), so "Spy × Family" from one source
// matches "Spy x Family" from another
export function normalizeTitle(title: string): string {
    return title.replace(/×/g, "x").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "")
}

// feed/dedupe.py title_key(): all-CJK titles normalize to "", so fall back to the raw title
export function titleKey(title: string): string {
    return normalizeTitle(title) || title.trim().toLowerCase()
}

// The feed is library-agnostic; hide library series on the phone instead,
// by id and by title so a copy on another source is hidden too
export async function fetchLibraryIds(stateManager: SourceStateManager, requestManager: RequestManager): Promise<LibraryIndex> {
    try {
        const res = await graphqlRequest(stateManager, requestManager, GQL_LIBRARY_IDS)
        const nodes = res.data.mangas.nodes
        return {
            ids: new Set(nodes.map((node: any) => String(node.id))),
            titles: new Set(nodes.map((node: any) => normalizeTitle(node.title)))
        }
    } catch {
        return { ids: new Set(), titles: new Set() }
    }
}

// Shape feed items like the GraphQL mangas the tile builder already handles
export function feedRowMangas(row: FeedRow, library: LibraryIndex): any[] {
    return row.items
        .filter(item => !library.ids.has(item.id) && !library.titles.has(normalizeTitle(item.title)))
        .map(item => ({ id: item.id, title: item.title, imageUrl: item.image, subtitle: item.subtitle }))
}

// ! Live paging across every source

// "Browse All Series" and the View More of feed rows page through every
// pooled source's own Popular (or Latest) listing, interleaved by rank with
// one copy per title, so the whole server catalog is reachable, not just the
// ~100 series precached per row.

const GQL_SOURCE_LISTING = `
    mutation SourceListing($sourceId: LongString!, $type: FetchSourceMangaType!, $page: Int!) {
        fetchSourceManga(input: { source: $sourceId, type: $type, page: $page }) {
            hasNextPage
            mangas {
                id
                title
                thumbnailUrl
                inLibrary
            }
        }
    }
`

// Each source has its own queue in Suwayomi, so a few sources at once is safe
const MAX_PARALLEL_SOURCES = 5
// Titles remembered between pages (metadata travels with every View More page)
const MAX_SEEN_TITLES = 4000

export interface LivePaging {
    kind: "POPULAR" | "LATEST" | "CURATED"
    // Sources that still have more pages
    sources: string[]
    page: number
    seen: string[]
    // CURATED: the discover row whose filters are applied
    rowKey?: string
}

async function inBatches<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = []
    for (let i = 0; i < items.length; i += size) {
        results.push(...await Promise.allSettled(items.slice(i, i + size).map(task)))
    }
    return results
}

export async function fetchLivePage(
    stateManager: SourceStateManager,
    requestManager: RequestManager,
    paging: LivePaging,
    library: LibraryIndex,
    excludeTitles: Set<string>,
    adultContent: string
): Promise<{ mangas: any[], next: LivePaging | undefined }> {
    const results = await inBatches(paging.sources, MAX_PARALLEL_SOURCES, async (sourceId) => {
        if (paging.kind === "CURATED") {
            const row = getDiscoverRow(paging.rowKey ?? "")
            if (!row) return { sourceId, mangas: [] as any[], hasNextPage: false }
            return { sourceId, ...await fetchDiscoverRow(stateManager, requestManager, sourceId, row, paging.page, adultContent) }
        }
        const res = await graphqlRequest(stateManager, requestManager, GQL_SOURCE_LISTING, {
            sourceId,
            type: paging.kind,
            page: paging.page
        })
        return {
            sourceId,
            mangas: res.data.fetchSourceManga.mangas.filter((manga: any) => !manga.inLibrary) as any[],
            hasNextPage: !!res.data.fetchSourceManga.hasNextPage
        }
    })

    // A source that errors (e.g. a Cloudflare timeout) keeps its place and is retried next page
    const lists: any[][] = []
    const remaining: string[] = []
    results.forEach((result, i) => {
        if (result.status === "fulfilled") {
            lists.push(result.value.mangas)
            if (result.value.hasNextPage) remaining.push(result.value.sourceId)
        } else {
            remaining.push(paging.sources[i] ?? "")
        }
    })
    // Every source failing at once means the server is unreachable; stop rather than loop
    if (lists.length === 0) throw new Error("Every source failed to load")

    const seen = new Set(paging.seen)
    const mangas: any[] = []
    const longest = Math.max(0, ...lists.map(list => list.length))
    for (let rank = 0; rank < longest; rank++) {
        for (const list of lists) {
            const manga = list[rank]
            if (!manga) continue
            const key = titleKey(manga.title)
            if (seen.has(key) || excludeTitles.has(key)) continue
            if (library.ids.has(String(manga.id)) || library.titles.has(normalizeTitle(manga.title))) continue
            seen.add(key)
            mangas.push(manga)
        }
    }

    const sources = remaining.filter(id => id !== "")
    const next = sources.length > 0
        ? { ...paging, sources, page: paging.page + 1, seen: [...seen].slice(-MAX_SEEN_TITLES) }
        : undefined
    return { mangas, next }
}

// Where a feed row's View More continues once its precached items run out
export function feedRowContinuation(rowKey: string, feed: Feed, adultContent: string): LivePaging | undefined {
    const seen = (feed.rows.find(row => row.key === rowKey)?.items ?? []).map(item => titleKey(item.title))
    const all = feed.sources.map(source => source.id)
    const start = feed.rowPages + 1
    if (all.length === 0) return undefined
    switch (rowKey) {
        case "browse":
            // Everything: every source's Popular listing from the top
            return { kind: "POPULAR", sources: all, page: 1, seen }
        case "hero":
        case "popular":
            return { kind: "POPULAR", sources: all, page: start, seen }
        case "new": {
            const latest = feed.sources.filter(source => source.supportsLatest).map(source => source.id)
            return latest.length > 0 ? { kind: "LATEST", sources: latest, page: start, seen } : undefined
        }
        default: {
            // Genre, anime and webtoon rows need the curated source's filters. Back Room's
            // curated rows add explicit-only tags these filters lack, so it stops there.
            const curated = feed.sources[0]
            if (adultContent !== "False" || !curated || !curated.name.startsWith(DISCOVER_SOURCE_NAME) || !getDiscoverRow(rowKey)) return undefined
            return { kind: "CURATED", sources: [curated.id], page: start, seen, rowKey }
        }
    }
}

// ! Recently read

const GQL_RECENTLY_READ = `
    query RecentlyRead($offset: Int, $first: Int) {
        chapters(
            filter: { lastReadAt: { greaterThan: "0" }, inLibrary: { equalTo: true } }
            orderBy: LAST_READ_AT
            orderByType: DESC
            offset: $offset
            first: $first
        ) {
            nodes {
                manga {
                    id
                    title
                    thumbnailUrl
                }
            }
            pageInfo {
                hasNextPage
            }
        }
    }
`

export async function fetchRecentlyRead(
    stateManager: SourceStateManager,
    requestManager: RequestManager,
    offset: number,
    first: number
): Promise<{ mangas: any[], hasNextPage: boolean }> {
    const res = await graphqlRequest(stateManager, requestManager, GQL_RECENTLY_READ, { offset, first })
    return {
        mangas: res.data.chapters.nodes.map((node: any) => node.manga),
        hasNextPage: res.data.chapters.pageInfo.hasNextPage
    }
}

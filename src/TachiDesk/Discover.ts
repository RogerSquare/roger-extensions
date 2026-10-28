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

function buildFilterChanges(filters: SourceFilter[], row: DiscoverRow) {
    return [
        ...selectChange(filters, "Sort", row.sort),
        ...selectChange(filters, "Adult Content", "False"),
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
    page: number
): Promise<{ mangas: any[], hasNextPage: boolean }> {
    const filters = await getSourceFilters(stateManager, requestManager, sourceId)
    const res = await graphqlRequest(stateManager, requestManager, GQL_DISCOVER, {
        sourceId,
        page,
        filters: buildFilterChanges(filters, row)
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
    row: DiscoverRow
): Promise<any[]> {
    const cacheKey = "discover_cache_" + row.key
    const cached = await stateManager.retrieve(cacheKey) as { at: number, mangas: any[] } | undefined
    if (cached && Date.now() - cached.at < ROW_CACHE_TTL_MS) return cached.mangas

    try {
        const mangas = (await limited(() => fetchDiscoverRow(stateManager, requestManager, sourceId, row, 1))).mangas
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
const FEED_PORT = 4580

export interface FeedRow {
    key: string
    title: string
    style: DiscoverRowStyle
    items: { id: string, title: string, image: string, subtitle?: string }[]
}

export function feedBaseURL(serverURL: string): string {
    const match = serverURL.match(/^(https?:\/\/[^\/:]+)/)
    return match ? `${match[1]}:${FEED_PORT}/` : ""
}

export async function fetchFeedRows(requestManager: RequestManager, serverURL: string): Promise<FeedRow[] | undefined> {
    const base = feedBaseURL(serverURL)
    if (!base) return undefined
    try {
        const response = await requestManager.schedule(App.createRequest({ url: base + "feed.json", method: "GET" }), 0)
        if (response.status !== 200) return undefined
        const feed = JSON.parse(response.data ?? "")
        const rows: FeedRow[] = feed.rows ?? []
        // Image paths in the feed are relative to the feed server
        return rows.map(row => ({
            ...row,
            items: row.items.map(item => ({ ...item, image: base + item.image }))
        }))
    } catch {
        return undefined
    }
}

const GQL_LIBRARY_IDS = `
    query LibraryIds {
        mangas(condition: { inLibrary: true }) {
            nodes { id }
        }
    }
`

// The feed is library-agnostic; hide library series on the phone instead
export async function fetchLibraryIds(stateManager: SourceStateManager, requestManager: RequestManager): Promise<Set<string>> {
    try {
        const res = await graphqlRequest(stateManager, requestManager, GQL_LIBRARY_IDS)
        return new Set(res.data.mangas.nodes.map((node: any) => String(node.id)))
    } catch {
        return new Set()
    }
}

// Shape feed items like the GraphQL mangas the tile builder already handles
export function feedRowMangas(row: FeedRow, libraryIds: Set<string>): any[] {
    return row.items
        .filter(item => !libraryIds.has(item.id))
        .map(item => ({ id: item.id, title: item.title, imageUrl: item.image, subtitle: item.subtitle }))
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

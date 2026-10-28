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
}

const GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Mystery", "Romance",
    "Sci-fi", "Slice of Life", "Supernatural", "Horror", "Psychological",
    "Sports", "Historical"
]

export const DISCOVER_ROWS: DiscoverRow[] = [
    { key: "hero", title: "Trending Now", style: "featured", sort: "Popularity", ongoingOnly: true },
    { key: "new", title: "Newly Added", style: "singleRowNormal", sort: "Recently Added" },
    { key: "popular", title: "Most Popular", style: "singleRowLarge", sort: "Popularity" },
    { key: "anime", title: "Now an Anime", style: "singleRowNormal", sort: "Popularity", animeOnly: true },
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
        ...(row.tag ? groupChange(filters, "Tags", row.tag, { triState: "INCLUDE" }) : [])
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

// ! Recently read

const GQL_RECENTLY_READ = `
    query RecentlyRead($offset: Int, $first: Int) {
        chapters(
            filter: { lastReadAt: { greaterThan: "0" } }
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

import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ContentRating,
    DUIForm,
    DUISection,
    HomeSection,
    HomeSectionType,
    MangaProgress,
    MangaProgressProviding,
    PagedResults,
    PaperbackExtensionBase,
    Request,
    Response,
    SearchRequest,
    SourceInfo,
    SourceIntents,
    SourceManga,
    TagSection,
    TrackerActionQueue,
} from "@paperback/types"

import {
    HomepageSettings,
    categoriesSettings,
    languageSettings,
    resetSettingsButton,
    serverAddressSettings,
    sourceSettings,
} from "./Settings";

import {
    DISCOVER_ROWS,
    feedRowMangas,
    fetchDiscoverRow,
    fetchFeedRows,
    fetchLibraryIds,
    fetchRecentlyRead,
    findDiscoverSource,
    getDiscoverRowMangas,
    getDiscoverRow
} from "./Discover";

import {
    DEFAULT_SERVER_URL,
    fetchServerCategories,
    fetchServerSources,
    getAuthState,
    getAuthString,
    getCategoryFromId,
    getCategoryNameFromId,
    getCategoryRowState,
    getCategoryRowStyle,
    getMangaPerRow,
    getSelectedCategories,
    getSelectedSources,
    getServerCategories,
    getServerSources,
    getServerURL,
    getSourceFromId,
    getSourceNameFromId,
    getSourceRowState,
    getSourceRowStyle,
    getUpdatedRowState,
    getUpdatedRowStyle,
    graphqlRequest,
    serverUnavailableMangaTiles,
    setServerCategories,
    setServerSources,
    testGraphQL,
    v1Migration
} from "./Common";

export const TachiDeskInfo: SourceInfo = {
    author: 'ofelizestevez & Alles',
    description: "Panelhouse: Roger's self-hosted manga and webtoon library, served by Suwayomi (GraphQL). Based on the Tachidesk extension.",
    icon: 'icon.png',
    name: 'Panelhouse',
    version: '3.5.1',
    websiteBaseURL: "https://github.com/Suwayomi/Tachidesk-Server",
    contentRating: ContentRating.EVERYONE,
    sourceTags: [
        {
            text: "Self-hosted",
            type: BadgeColor.GREY
        },
        {
            text: "roger-extensions",
            type: BadgeColor.BLUE
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.SETTINGS_UI | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.MANGA_TRACKING
}

// =================================================================
// GraphQL Query / Mutation Definitions
// =================================================================

const GQL_GET_MANGA = `
    query GetManga($id: Int!) {
        manga(id: $id) {
            id
            title
            author
            artist
            description
            genre
            status
            thumbnailUrl
            lastFetchedAt
            chaptersLastFetchedAt
        }
    }
`;

const GQL_GET_MANGA_ONLINE_FETCH = `
    mutation FetchManga($id: Int!) {
        fetchManga(input: { id: $id }) {
            manga {
                id
                title
                lastFetchedAt
            }
        }
    }
`;

const GQL_GET_CHAPTERS = `
    query GetChapters($mangaId: Int!) {
        chapters(condition: { mangaId: $mangaId }, orderBy: SOURCE_ORDER, orderByType: DESC) {
            nodes {
                id
                sourceOrder
                name
                chapterNumber
                uploadDate
                pageCount
                mangaId
            }
        }
    }
`;

const GQL_FETCH_CHAPTERS = `
    mutation FetchChapters($mangaId: Int!) {
        fetchChapters(input: { mangaId: $mangaId }) {
            chapters {
                id
                sourceOrder
            }
        }
    }
`;

const GQL_GET_CHAPTER = `
    query GetChapter($mangaId: Int!, $sourceOrder: Int!) {
        chapters(condition: { mangaId: $mangaId, sourceOrder: $sourceOrder }, first: 1) {
            nodes {
                id
                sourceOrder
                name
                chapterNumber
                pageCount
                mangaId
            }
        }
    }
`;

const GQL_FETCH_CHAPTER_PAGES = `
    mutation FetchChapterPages($chapterId: Int!) {
        fetchChapterPages(input: { chapterId: $chapterId }) {
            pages
        }
    }
`;

const GQL_GET_RECENT_CHAPTERS = `
    query GetRecentChapters($offset: Int, $first: Int) {
        chapters(
            # Library series only, newest release first. Fetch time also covers
            # series merely browsed in Suwayomi, and isDownloaded: false hid
            # everything once chapters were downloaded.
            filter: { inLibrary: { equalTo: true } }
            orderBy: UPLOAD_DATE
            orderByType: DESC
            offset: $offset
            first: $first
        ) {
            nodes {
                id
                name
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
`;

const GQL_GET_CATEGORY_MANGAS = `
    query GetCategoryMangas($categoryId: Int!) {
        category(id: $categoryId) {
            id
            name
            mangas {
                nodes {
                    id
                    title
                    thumbnailUrl
                }
            }
        }
    }
`;

const GQL_GET_SOURCE_MANGAS = `
    mutation GetSourceMangas($sourceId: LongString!, $type: FetchSourceMangaType!, $page: Int!) {
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
`;

const GQL_SEARCH_SOURCE = `
    mutation SearchSource($sourceId: LongString!, $query: String, $page: Int!) {
        fetchSourceManga(input: { source: $sourceId, type: SEARCH, page: $page, query: $query }) {
            hasNextPage
            mangas {
                id
                title
                thumbnailUrl
            }
        }
    }
`;

const GQL_GET_MANGA_FULL = `
    query GetMangaFull($id: Int!) {
        manga(id: $id) {
            id
            title
            lastReadChapter {
                id
                chapterNumber
            }
        }
    }
`;

const GQL_UPDATE_CHAPTER_READ = `
    mutation UpdateChapter($id: Int!) {
        updateChapter(input: { id: $id, patch: { isRead: true } }) {
            chapter {
                id
                isRead
            }
        }
    }
`;

export class TachiDesk implements PaperbackExtensionBase, MangaProgressProviding {
    stateManager = App.createSourceStateManager();
    requestManager = App.createRequestManager({
        requestsPerSecond: 4,
        // Discovery rows wait on Suwayomi's per-source queue, which the downloader also uses
        requestTimeout: 45000,
        interceptor: {
            interceptRequest: async (request: Request) => {
                const authEnabled = await getAuthState(this.stateManager);
                const serverURL = await getServerURL(this.stateManager);

                // Only our own server gets the Suwayomi credentials, never other hosts (e.g. the feed)
                if (authEnabled && request.url.startsWith(serverURL)) {
                    request.headers = {
                        ...request.headers,
                        authorization: await getAuthString(this.stateManager)
                    }
                }

                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    serverAddress = ""

    // Settings
    async getSourceMenu(): Promise<DUISection> {
        return App.createDUISection({
            id: "main",
            header: "Source Settings",
            footer: "IMPORTANT NOTE: settings are more stable if you wait for your homepage section to load.",
            isHidden: false,
            rows: async () => [
                serverAddressSettings(this.stateManager, this.requestManager),
                HomepageSettings(this.stateManager, this.requestManager),
                await categoriesSettings(this.stateManager, this.requestManager),
                await languageSettings(this.stateManager),
                await sourceSettings(this.stateManager, this.requestManager),
                await resetSettingsButton(this.stateManager)
            ]
        })
    }

    // share URL
    getMangaShareUrl(mangaId: string): string {
        if (this.serverAddress != "") {
            return this.serverAddress + "manga/" + mangaId
        }
        return ""
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        let result = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA, {
            id: parseInt(mangaId)
        });

        // Browse/search results are stubs until fetched once (no description,
        // author or status); the feed pre-fetches its series, search hits don't
        if (parseInt(result.data.manga.lastFetchedAt ?? "0") === 0) {
            try {
                await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA_ONLINE_FETCH, {
                    id: parseInt(mangaId)
                });
                result = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA, {
                    id: parseInt(mangaId)
                });
            } catch (e) {
                console.log(`Error during online details fetch: ${e}`);
            }
        }

        const manga = result.data.manga;
        const serverURL = await getServerURL(this.stateManager);

        const tags: [TagSection] = [
            App.createTagSection({
                id: "0",
                label: "genres",
                tags: (manga.genre ?? []).map((tag: string) => App.createTag({
                    id: tag,
                    label: tag
                }))
            })
        ];

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [manga.title],
                image: manga.thumbnailUrl ? serverURL + manga.thumbnailUrl.replace(/^\//, "") : "",
                author: manga.author ?? "",
                artist: manga.artist ?? "",
                desc: manga.description ?? "",
                status: manga.status ?? "",
                tags
            })
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const mangaIdInt = parseInt(mangaId);

        // Get manga to check when details and chapters were last fetched
        const mangaResult = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA, {
            id: mangaIdInt
        });
        const manga = mangaResult.data.manga;

        // Details and chapters age separately: getMangaDetails fetches details
        // alone, so a fresh lastFetchedAt says nothing about the chapter list
        const dayAgo = Math.floor(Date.now() / 1000) - 86400;
        try {
            if (parseInt(manga.lastFetchedAt ?? "0") < dayAgo) {
                await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA_ONLINE_FETCH, {
                    id: mangaIdInt
                });
            }
            if (parseInt(manga.chaptersLastFetchedAt ?? "0") < dayAgo) {
                await graphqlRequest(this.stateManager, this.requestManager, GQL_FETCH_CHAPTERS, {
                    mangaId: mangaIdInt
                });
            }
        } catch (e) {
            console.log(`Error during online fetch: ${e}`);
        }

        const chaptersResult = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_CHAPTERS, {
            mangaId: mangaIdInt
        });

        this.serverAddress = await getServerURL(this.stateManager);

        const chapters: Chapter[] = [];

        for (const chapter of chaptersResult.data.chapters.nodes) {
            chapters.push(
                App.createChapter({
                    id: chapter.sourceOrder.toString(),
                    name: chapter.name,
                    chapNum: chapter.chapterNumber,
                    time: new Date(parseInt(chapter.uploadDate)),
                    sortingIndex: chapter.sourceOrder
                })
            )
        }

        return chapters
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const serverURL = await getServerURL(this.stateManager);

        // chapterId here is the sourceOrder. We need to look up the actual chapter id.
        const chapterResult = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_CHAPTER, {
            mangaId: parseInt(mangaId),
            sourceOrder: parseInt(chapterId)
        });

        const chapterNode = chapterResult.data.chapters.nodes[0];
        if (!chapterNode) {
            throw new Error(`Chapter not found for mangaId=${mangaId}, sourceOrder=${chapterId}`);
        }

        // Trigger page fetch (also gets the page URLs)
        const pagesResult = await graphqlRequest(this.stateManager, this.requestManager, GQL_FETCH_CHAPTER_PAGES, {
            chapterId: chapterNode.id
        });

        let pages: string[] = [];
        const fetchedPages: string[] | undefined = pagesResult.data?.fetchChapterPages?.pages;

        if (fetchedPages && fetchedPages.length > 0) {
            pages = fetchedPages.map((p) => {
                if (p.startsWith("http")) return p;
                return serverURL + p.replace(/^\//, "");
            });
        } else {
            // Fallback: construct page URLs from pageCount
            for (const pageIndex of Array(chapterNode.pageCount).keys()) {
                pages.push(`${serverURL}api/v1/manga/${mangaId}/chapter/${chapterId}/page/${pageIndex}`);
            }
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId,
            pages
        })
    }

    // Homepage sections
    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const promises: Promise<void>[] = [];

        // Check for v1 migration
        if (await this.stateManager.retrieve("server_address")) {
            await v1Migration(this.stateManager)
        }

        // Error checking
        const testResult = await testGraphQL(this.stateManager, this.requestManager);
        if (testResult instanceof Error) {
            const section = App.createHomeSection({
                id: "unset",
                title: "Server Error",
                containsMoreItems: false,
                type: "singleRowNormal",
                items: serverUnavailableMangaTiles()
            });
            sectionCallback(section);
            return;
        }

        const serverURL = await getServerURL(this.stateManager);
        const serverSources = await getServerSources(this.stateManager);
        const serverCategories = await getServerCategories(this.stateManager);

        // Refresh sources/categories on background
        if (serverURL !== DEFAULT_SERVER_URL) {
            promises.push(
                fetchServerSources(this.stateManager, this.requestManager).then((response) => {
                    if (JSON.stringify(response) !== JSON.stringify(serverSources)) {
                        setServerSources(this.stateManager, response)
                    }
                })
            )

            promises.push(
                fetchServerCategories(this.stateManager, this.requestManager).then((response) => {
                    if (JSON.stringify(response) !== JSON.stringify(serverCategories)) {
                        setServerCategories(this.stateManager, response)
                    }
                })
            )
        }

        const mangaPerRow = await getMangaPerRow(this.stateManager);
        const updatedRowState = await getUpdatedRowState(this.stateManager);
        const categoryRowState = await getCategoryRowState(this.stateManager);
        const sourceRowState = await getSourceRowState(this.stateManager);
        const updatedRowStyle = (await getUpdatedRowStyle(this.stateManager))[0];
        const categoryRowStyle = (await getCategoryRowStyle(this.stateManager))[0];
        const sourceRowStyle = (await getSourceRowStyle(this.stateManager))[0];

        type SectionDef = {
            section: HomeSection;
            type: "updated" | "category" | "popular" | "latest" | "discover" | "recentread" | "feed";
            id: string | number;
        };
        const sections: SectionDef[] = [];

        // Crunchyroll-style home page built from one source's filters. The
        // per-source Popular/Latest rows below remain only as a fallback when
        // that source isn't installed.
        const knownSources = Object.keys(serverSources).length > 1
            ? serverSources
            : await fetchServerSources(this.stateManager, this.requestManager)
        const discoverSource = findDiscoverSource(knownSources)

        // The NAS feed has every discovery row precached; live rows are the fallback
        const [feedRows, library] = await Promise.all([
            fetchFeedRows(this.requestManager, serverURL),
            fetchLibraryIds(this.stateManager, this.requestManager)
        ])

        sections.push({
            section: App.createHomeSection({
                id: "recentread",
                title: "Recently Read",
                containsMoreItems: true,
                type: HomeSectionType.singleRowNormal
            }),
            type: "recentread",
            id: 0
        })

        if (feedRows) {
            for (const row of feedRows) {
                sections.push({
                    section: App.createHomeSection({
                        id: "feed-" + row.key,
                        title: row.title,
                        containsMoreItems: true,
                        type: HomeSectionType[row.style]
                    }),
                    type: "feed",
                    id: row.key
                })
            }
        } else if (discoverSource) {
            for (const row of DISCOVER_ROWS) {
                sections.push({
                    section: App.createHomeSection({
                        id: "discover-" + row.key,
                        title: row.title,
                        containsMoreItems: true,
                        type: HomeSectionType[row.style]
                    }),
                    type: "discover",
                    id: row.key
                })
            }
        }

        if (updatedRowState) {
            sections.push({
                section: App.createHomeSection({
                    id: "updated",
                    title: "Recently Updated",
                    containsMoreItems: true,
                    type: HomeSectionType[updatedRowStyle as keyof typeof HomeSectionType]
                }),
                type: "updated",
                id: 0
            })
        }

        if (categoryRowState) {
            const fetchedCategories = await fetchServerCategories(this.stateManager, this.requestManager)
            const selectedCategories: Array<string> = await getSelectedCategories(this.stateManager)

            const orderedSelectedCategories = Object.keys(fetchedCategories)
                .filter((key) => selectedCategories.includes(key))
                .sort((a, b) => {
                    const aOrder = getCategoryFromId(fetchedCategories, a).order
                    const bOrder = getCategoryFromId(fetchedCategories, b).order
                    if (aOrder < bOrder) return -1;
                    if (aOrder > bOrder) return 1;
                    return 0;
                })

            for (const categoryId of orderedSelectedCategories) {
                sections.push({
                    section: App.createHomeSection({
                        id: "category-" + categoryId,
                        title: getCategoryNameFromId(fetchedCategories, categoryId),
                        containsMoreItems: true,
                        type: HomeSectionType[categoryRowStyle as keyof typeof HomeSectionType]
                    }),
                    type: "category",
                    id: categoryId
                })
            }
        }

        if (sourceRowState && !feedRows && !discoverSource) {
            const fetchedSources = await getServerSources(this.stateManager);
            const selectedSources = await getSelectedSources(this.stateManager);

            for (const sourceId of selectedSources) {
                sections.push({
                    section: App.createHomeSection({
                        id: "popular-" + sourceId,
                        title: getSourceNameFromId(fetchedSources, sourceId) + " (Popular)",
                        containsMoreItems: true,
                        type: HomeSectionType[sourceRowStyle as keyof typeof HomeSectionType]
                    }),
                    type: "popular",
                    id: sourceId
                })

                if (getSourceFromId(fetchedSources, sourceId).supportsLatest) {
                    sections.push({
                        section: App.createHomeSection({
                            id: "latest-" + sourceId,
                            title: getSourceNameFromId(fetchedSources, sourceId) + " (Latest)",
                            containsMoreItems: true,
                            type: HomeSectionType[sourceRowStyle as keyof typeof HomeSectionType]
                        }),
                        type: "latest",
                        id: sourceId
                    })
                }
            }
        }

        // Hero banner, then Recently Read, then discovery, then the library rows
        const sectionRank = (def: SectionDef) => {
            if ((def.type === "discover" || def.type === "feed") && def.id === "hero") return 0
            return { recentread: 1, feed: 2, discover: 2, popular: 3, latest: 4, updated: 5, category: 6 }[def.type] ?? 7
        }
        sections.sort((a, b) => sectionRank(a) - sectionRank(b))

        // Execute promises to fill section content
        for (const section of sections) {
            sectionCallback(section.section)

            promises.push((async () => {
                try {
                    const tiles = [];
                    let mangas: any[] = [];

                    if (section.type === "feed") {
                        const row = feedRows?.find(feedRow => feedRow.key === section.id)
                        if (row) mangas = feedRowMangas(row, library);
                    } else if (section.type === "discover") {
                        const row = getDiscoverRow(String(section.id))
                        if (row && discoverSource) {
                            mangas = await getDiscoverRowMangas(this.stateManager, this.requestManager, discoverSource.id, row);
                        }
                    } else if (section.type === "recentread") {
                        // Many chapters per series in a reading session; over-fetch so the row fills after de-dup
                        mangas = (await fetchRecentlyRead(this.stateManager, this.requestManager, 0, mangaPerRow * 20)).mangas;
                    } else if (section.type === "updated") {
                        const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_RECENT_CHAPTERS, {
                            offset: 0,
                            // One series often has many chapters in a row; over-fetch so the row still fills after de-dup
                            first: mangaPerRow * 20
                        });
                        mangas = res.data.chapters.nodes.map((node: any) => node.manga);
                    } else if (section.type === "category") {
                        const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_CATEGORY_MANGAS, {
                            categoryId: parseInt(String(section.id))
                        });
                        mangas = res.data.category.mangas.nodes;
                    } else if (section.type === "popular" || section.type === "latest") {
                        const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_SOURCE_MANGAS, {
                            sourceId: String(section.id),
                            type: section.type.toUpperCase(),
                            page: 1
                        });
                        // Discovery rows only surface series not already in the library
                        mangas = res.data.fetchSourceManga.mangas.filter((manga: any) => !manga.inLibrary);
                    }

                    // De-dup (recent chapters can have duplicates)
                    const seen = new Set<string>();
                    for (const manga of mangas) {
                        if (tiles.length >= mangaPerRow) break;
                        const idStr = manga.id.toString();
                        if (seen.has(idStr)) continue;
                        seen.add(idStr);

                        tiles.push(
                            App.createPartialSourceManga({
                                title: manga.title,
                                mangaId: idStr,
                                // Feed rows carry their own (mirrored) image URLs and optional subtitle
                                image: manga.imageUrl ?? (manga.thumbnailUrl ? serverURL + manga.thumbnailUrl.replace(/^\//, "") : ""),
                                subtitle: manga.subtitle
                            })
                        )
                    }

                    section.section.items = tiles;
                    sectionCallback(section.section);
                } catch (e) {
                    console.log(`Error loading section ${section.section.id}: ${e}`);
                }
            })())
        }

        await Promise.all(promises)
    }

    // View more items
    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const sourceId = homepageSectionId.split('-').pop() ?? ""
        const type = homepageSectionId.split("-")[0]
        const serverURL = await getServerURL(this.stateManager);

        const tiles = [];
        let page = metadata?.page ?? 1;
        let mangas: any[] = [];
        let hasNextPage = false;

        switch (type) {
            case "feed": {
                // The feed already holds a full row (two source pages); no further paging
                const [feedRows, library] = await Promise.all([
                    fetchFeedRows(this.requestManager, serverURL),
                    fetchLibraryIds(this.stateManager, this.requestManager)
                ]);
                const row = feedRows?.find(feedRow => feedRow.key === sourceId);
                if (row) mangas = feedRowMangas(row, library);
                break;
            }
            case "discover": {
                const row = getDiscoverRow(sourceId);
                const discoverSource = findDiscoverSource(await getServerSources(this.stateManager));
                if (row && discoverSource) {
                    ({ mangas, hasNextPage } = await fetchDiscoverRow(this.stateManager, this.requestManager, discoverSource.id, row, page));
                }
                break;
            }
            case "recentread": {
                const pageSize = 50;
                ({ mangas, hasNextPage } = await fetchRecentlyRead(this.stateManager, this.requestManager, (page - 1) * pageSize, pageSize));
                break;
            }
            case "updated": {
                const pageSize = 50;
                const offset = (page - 1) * pageSize;
                const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_RECENT_CHAPTERS, {
                    offset,
                    first: pageSize
                });
                mangas = res.data.chapters.nodes.map((node: any) => node.manga);
                hasNextPage = res.data.chapters.pageInfo.hasNextPage;
                break;
            }
            case "category": {
                const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_CATEGORY_MANGAS, {
                    categoryId: parseInt(sourceId)
                });
                mangas = res.data.category.mangas.nodes;
                hasNextPage = false; // Categories don't have pages
                break;
            }
            case "popular":
            case "latest":
            default: {
                const res = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_SOURCE_MANGAS, {
                    sourceId,
                    type: type.toUpperCase(),
                    page
                });
                mangas = res.data.fetchSourceManga.mangas.filter((manga: any) => !manga.inLibrary);
                hasNextPage = res.data.fetchSourceManga.hasNextPage;
                break;
            }
        }

        const seen = new Set<string>();
        for (const manga of mangas) {
            const idStr = manga.id.toString();
            if (seen.has(idStr)) continue;
            seen.add(idStr);

            tiles.push(
                App.createPartialSourceManga({
                    title: manga.title,
                    mangaId: idStr,
                    // Feed rows carry their own (mirrored) image URLs
                    image: manga.imageUrl ?? (manga.thumbnailUrl ? serverURL + manga.thumbnailUrl.replace(/^\//, "") : ""),
                    subtitle: manga.subtitle
                })
            )
        }

        metadata = hasNextPage ? { page: page + 1 } : undefined
        return App.createPagedResults({
            results: tiles,
            metadata: metadata
        })
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const serverSources = await getServerSources(this.stateManager);
        const selectedSources = await getSelectedSources(this.stateManager);
        const meta_sources: { [key: string]: boolean } = metadata?.sources ?? {};
        const page: number = metadata?.page ?? 1;
        const serverURL = await getServerURL(this.stateManager);

        const searchTerm = (query.title && query.title !== "") ? query.title : null;

        const tiles = []
        for (const source of selectedSources) {
            if (page !== 1) {
                if (!meta_sources[source]) continue
            }

            try {
                const result = await graphqlRequest(this.stateManager, this.requestManager, GQL_SEARCH_SOURCE, {
                    sourceId: source,
                    query: searchTerm,
                    page
                });

                const fetchResult = result.data?.fetchSourceManga;
                if (!fetchResult) {
                    continue;
                }

                for (const manga of fetchResult.mangas) {
                    tiles.push(
                        App.createPartialSourceManga({
                            title: manga.title,
                            mangaId: String(manga.id),
                            image: manga.thumbnailUrl ? serverURL + manga.thumbnailUrl.replace(/^\//, "") : "",
                            subtitle: getSourceNameFromId(serverSources, source)
                        })
                    )
                }
                meta_sources[source] = fetchResult.hasNextPage;
            } catch (e) {
                console.log(`Search error for source ${source}: ${e}`);
                continue;
            }
        }

        metadata = tiles.length !== 0 ? { page: page + 1, sources: meta_sources } : undefined

        return App.createPagedResults({
            results: tiles,
            metadata
        })
    }

    async getMangaProgress(mangaId: string): Promise<MangaProgress | undefined> {
        console.log(`getting manga progress for ${mangaId}`);
        const result = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_MANGA_FULL, {
            id: parseInt(mangaId)
        });
        const manga = result.data.manga;

        if (!manga?.lastReadChapter) {
            return undefined
        }
        return App.createMangaProgress({
            mangaId: mangaId,
            lastReadChapterNumber: manga.lastReadChapter.chapterNumber,
            lastReadVolumeNumber: undefined,
            trackedListName: undefined,
            userRating: undefined,
        })
    }

    async getMangaProgressManagementForm(_mangaId: string): Promise<DUIForm> {
        return App.createDUIForm({
            sections: async () => {
                return []
            },
        })
    }

    async processChapterReadActionQueue(actionQueue: TrackerActionQueue): Promise<void> {
        const chapterReadActions = await actionQueue.queuedChapterReadActions()

        for (const readAction of chapterReadActions) {
            try {
                console.log(`marking mangaId ${readAction.mangaId} with sourceChapterId ${readAction.sourceChapterId} as read`)

                // sourceChapterId is sourceOrder; resolve to actual chapter id
                const chapterResult = await graphqlRequest(this.stateManager, this.requestManager, GQL_GET_CHAPTER, {
                    mangaId: parseInt(readAction.mangaId),
                    sourceOrder: parseInt(readAction.sourceChapterId)
                });

                const chapterNode = chapterResult.data?.chapters?.nodes?.[0];
                if (!chapterNode) {
                    throw new Error(`Chapter not found for manga ${readAction.mangaId} order ${readAction.sourceChapterId}`);
                }

                await graphqlRequest(this.stateManager, this.requestManager, GQL_UPDATE_CHAPTER_READ, {
                    id: chapterNode.id
                });

                await actionQueue.discardChapterReadAction(readAction)
            } catch (error) {
                console.log(`Error in processChapterReadActionQueue: ${error}`)
                await actionQueue.retryChapterReadAction(readAction)
            }
        }
    }
}
import {
    BadgeColor,
    ContentRating,
    SourceInfo
} from "@paperback/types"

import {
    TachiDesk,
    TachiDeskInfo
} from "../TachiDesk/TachiDesk"

// Back Room: Panelhouse's 18+ sibling. Same code against a second, fully
// separate Suwayomi (rootnas :4568, own library and read progress) with its
// own precached feed (:4581) whose curated rows are adult-only.
export const BackRoomInfo: SourceInfo = {
    ...TachiDeskInfo,
    description: "Back Room: Roger's separate 18+ manga and webtoon library, served by its own Suwayomi (GraphQL).",
    name: 'Back Room',
    version: '1.0.1',
    contentRating: ContentRating.ADULT,
    sourceTags: [
        {
            text: "18+",
            type: BadgeColor.RED
        },
        {
            text: "roger-extensions",
            type: BadgeColor.BLUE
        }
    ]
}

export class BackRoom extends TachiDesk {
    override feedPort = 4581
    override adultContent = "True"
}

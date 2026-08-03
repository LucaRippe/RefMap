# Citation Explorer

A free literature discovery tool in the style of Litmaps: searches
[OpenAlex](https://openalex.org) for papers, visualizes the citation network,
and connects to your [Zotero](https://www.zotero.org) library.

## Setup

```bash
git clone <your-repo-url>
cd citation-explorer
npm install
cp .env.example .env
```

Fill in your Zotero API key and user ID in `.env` (see comments in
`.env.example`). Create a key at
[zotero.org/settings/keys](https://www.zotero.org/settings/keys).
Collections are chosen in the app after connecting.

## Start

```bash
npm run dev
```

Opens `http://localhost:5173` in the browser automatically. If `.env` is
filled in, the app connects to Zotero on startup.

## Usage

- **Search**: Enter a title/keyword → Enter or "Search"
- **Click** a node: details in the sidebar
- **Double-click**: expand the network around that node
- **Drag**: freely reposition nodes
- **Monitor**: check again for new citing articles
- **Export/Import**: save/share the map as a JSON file
- **Zotero collection**: after connecting, pick a collection (or main
  library) from the toolbar dropdown — used for DOI sync and new papers
- **Add to Zotero**: creates the paper (title, authors, DOI, abstract)
  as a `journalArticle` in the selected collection

Papers already in the selected collection/library (matched by DOI) are
marked in the graph with a green dashed ring.

## Production build

```bash
npm run build
npm run preview
```

## Notes

- All credentials stay local in `.env` (excluded from git via `.gitignore`)
  or in the browser tab's memory — nothing is sent to third-party servers
  except OpenAlex and Zotero themselves.
- OpenAlex rate limits are generous; for the "polite pool" with higher
  limits you can optionally append `&mailto=you@email.com` to the fetch
  URLs in `src/App.jsx`.
- Zotero sync currently loads the latest 100 entries of the selected
  collection (or main library). For larger libraries, pagination
  (`start=` parameter) would need to be added.

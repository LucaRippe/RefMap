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

Fill in your Zotero API key, user ID, and optionally a collection name in
`.env` (see comments in `.env.example`). Create a key at
[zotero.org/settings/keys](https://www.zotero.org/settings/keys).

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
- **Add to Zotero**: creates the paper (title, authors, DOI, abstract)
  as a `journalArticle` in your library — in the chosen collection if
  configured

Papers already in your library (matched by DOI) are marked in the graph
with a green dashed ring.

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
- Zotero library sync currently loads the latest 100 entries (or of the
  chosen collection). For larger libraries, pagination (`start=` parameter)
  would need to be added.

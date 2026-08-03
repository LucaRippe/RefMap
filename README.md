# Citation Explorer

Ein kostenloses Literatur-Discovery-Tool im Stil von Litmaps: durchsucht
[OpenAlex](https://openalex.org) nach Papers, visualisiert das Zitationsnetzwerk
und verbindet sich mit deiner [Zotero](https://www.zotero.org)-Library.

## Einrichtung

```bash
git clone <dein-repo-url>
cd citation-explorer
npm install
cp .env.example .env
```

Trage in `.env` deinen Zotero-API-Key, deine User-ID und optional den Namen
einer Sammlung ein (siehe Kommentare in `.env.example`). Key erstellen unter
[zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## Starten

```bash
npm run dev
```

Öffnet automatisch `http://localhost:5173` im Browser. Falls die `.env`
ausgefüllt ist, verbindet sich die App beim Start automatisch mit Zotero.

## Bedienung

- **Suchen**: Titel/Stichwort eingeben → Enter oder "Suchen"
- **Klick** auf einen Knoten: Details in der Sidebar
- **Doppelklick**: Netzwerk um diesen Knoten erweitern
- **Ziehen**: Knoten frei positionieren
- **Monitor**: erneut auf neue zitierende Artikel prüfen
- **Export/Import**: Karte als JSON-Datei sichern/teilen
- **Zu Zotero hinzufügen**: legt das Paper (Titel, Autoren, DOI, Abstract)
  als `journalArticle` in deiner Library an — in der gewählten Sammlung,
  falls konfiguriert

Paper, die bereits in deiner Library sind (per DOI-Abgleich erkannt), werden
im Graph mit einem grün gestrichelten Ring markiert.

## Build für Produktion

```bash
npm run build
npm run preview
```

## Hinweise

- Alle Zugangsdaten bleiben lokal in `.env` (per `.gitignore` vom Commit
  ausgeschlossen) bzw. im Speicher des Browser-Tabs — nichts wird an
  Drittserver übertragen außer OpenAlex und Zotero selbst.
- OpenAlex-Rate-Limits sind großzügig; für den "polite pool" mit höheren
  Limits kannst du optional `&mailto=deine@email.de` an die Fetch-URLs in
  `src/App.jsx` anhängen.
- Zotero-Bibliotheksabgleich lädt aktuell die letzten 100 Einträge
  (bzw. der gewählten Sammlung). Für größere Bibliotheken müsste die
  Pagination (`start=`-Parameter) ergänzt werden.

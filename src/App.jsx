import React, { useState, useRef, useEffect } from "react";
import * as d3 from "d3";
import {
  Search,
  Share2,
  RefreshCw,
  X,
  Loader2,
  BookOpen,
  ExternalLink,
  Library,
  Check,
  Plus,
  Download,
  Upload,
} from "lucide-react";

const API = "https://api.openalex.org/works";
const ZOTERO_API = "https://api.zotero.org";

// Values come from .env (see .env.example) — never hard-code your key here.
const ENV_USER_ID = import.meta.env.VITE_ZOTERO_USER_ID || "";
const ENV_API_KEY = import.meta.env.VITE_ZOTERO_API_KEY || "";

function splitName(fullName) {
  const parts = (fullName || "").trim().split(" ");
  if (parts.length === 1) return { creatorType: "author", name: parts[0] || "Unknown" };
  return {
    creatorType: "author",
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function reconstructAbstract(idx) {
  if (!idx) return "";
  const words = [];
  Object.entries(idx).forEach(([word, positions]) => {
    positions.forEach((p) => (words[p] = word));
  });
  return words.join(" ");
}

function shortId(openalexUrl) {
  return openalexUrl.split("/").pop();
}

function nodeRadius(n) {
  const c = n.cited_by_count || 0;
  return Math.max(7, Math.min(26, 7 + Math.sqrt(c) * 1.4));
}

export default function App() {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);
  const [savedMsg, setSavedMsg] = useState("");

  // Zotero state — credentials pre-filled from .env if present
  const [showZoteroPanel, setShowZoteroPanel] = useState(false);
  const [zoteroUserId, setZoteroUserId] = useState(ENV_USER_ID);
  const [zoteroApiKey, setZoteroApiKey] = useState(ENV_API_KEY);
  const [zoteroCollections, setZoteroCollections] = useState([]);
  const [selectedCollectionKey, setSelectedCollectionKey] = useState(""); // "" = main library
  const [zoteroConnected, setZoteroConnected] = useState(false);
  const [zoteroBusy, setZoteroBusy] = useState(false);
  const [zoteroMsg, setZoteroMsg] = useState("");
  const zoteroDoisRef = useRef(new Set());
  const [addingId, setAddingId] = useState(null);

  const svgRef = useRef(null);
  const fileInputRef = useRef(null);
  const dimsRef = useRef({ w: 900, h: 620 });
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const simRef = useRef(null);
  const dragNode = useRef(null);

  useEffect(() => {
    const sim = d3
      .forceSimulation(nodesRef.current)
      .force("link", d3.forceLink(linksRef.current).id((d) => d.id).distance(85).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(dimsRef.current.w / 2, dimsRef.current.h / 2))
      .force("collide", d3.forceCollide((d) => nodeRadius(d) + 10))
      .alphaDecay(0.02)
      .on("tick", () => setTick((t) => t + 1));
    simRef.current = sim;

    // auto-connect to Zotero if credentials came from .env
    if (ENV_USER_ID && ENV_API_KEY) {
      connectZotero(ENV_USER_ID, ENV_API_KEY);
    }
    return () => sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function restart(alpha = 0.9) {
    const sim = simRef.current;
    if (!sim) return;
    sim.nodes(nodesRef.current);
    sim.force("link").links(linksRef.current);
    sim.alpha(alpha).restart();
  }

  async function doSearch(q) {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`${API}?search=${encodeURIComponent(q)}&per_page=8`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (e) {
      setError("Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  function addNode(work, kind) {
    const id = shortId(work.id);
    let n = nodesRef.current.find((x) => x.id === id);
    if (!n) {
      n = {
        id,
        label: work.display_name || "Untitled",
        year: work.publication_year,
        cited_by_count: work.cited_by_count || 0,
        referenced_works: work.referenced_works || [],
        cited_by_api_url: work.cited_by_api_url,
        doi: work.doi ? work.doi.replace("https://doi.org/", "") : null,
        authorships: work.authorships || [],
        primary_location: work.primary_location || null,
        kind,
        x: dimsRef.current.w / 2 + (Math.random() - 0.5) * 40,
        y: dimsRef.current.h / 2 + (Math.random() - 0.5) * 40,
      };
      nodesRef.current.push(n);
    }
    return n;
  }

  function addLink(sourceId, targetId) {
    const exists = linksRef.current.find(
      (l) => (l.source.id || l.source) === sourceId && (l.target.id || l.target) === targetId
    );
    if (!exists) linksRef.current.push({ source: sourceId, target: targetId });
  }

  async function loadSeed(work) {
    setLoadingMsg("Loading citation network…");
    setError(null);
    setSearchResults([]);
    setQuery("");
    try {
      const seedNode = addNode(work, "seed");
      setSelected(seedNode);

      const refIds = (work.referenced_works || []).slice(0, 18).map(shortId);
      if (refIds.length) {
        const r = await fetch(`${API}?filter=openalex_id:${refIds.join("|")}&per_page=50`);
        const rd = await r.json();
        (rd.results || []).forEach((w) => {
          addNode(w, "reference");
          addLink(shortId(w.id), seedNode.id);
        });
      }

      if (work.cited_by_api_url) {
        const c = await fetch(`${work.cited_by_api_url}&per_page=25`);
        const cd = await c.json();
        (cd.results || []).forEach((w) => {
          addNode(w, "citation");
          addLink(seedNode.id, shortId(w.id));
        });
      }
      restart(1);
    } catch (e) {
      setError("Could not load network.");
    } finally {
      setLoadingMsg(null);
    }
  }

  async function expandNode(n) {
    setLoadingMsg(`Expanding "${n.label.slice(0, 40)}…"`);
    try {
      const full = await (await fetch(`${API}/${n.id}`)).json();
      const refIds = (full.referenced_works || []).slice(0, 12).map(shortId);
      if (refIds.length) {
        const r = await fetch(`${API}?filter=openalex_id:${refIds.join("|")}&per_page=40`);
        const rd = await r.json();
        (rd.results || []).forEach((w) => {
          addNode(w, "reference");
          addLink(shortId(w.id), n.id);
        });
      }
      if (full.cited_by_api_url) {
        const c = await fetch(`${full.cited_by_api_url}&per_page=15`);
        const cd = await c.json();
        (cd.results || []).forEach((w) => {
          addNode(w, "citation");
          addLink(n.id, shortId(w.id));
        });
      }
      restart(0.7);
    } catch (e) {
      setError("Expansion failed.");
    } finally {
      setLoadingMsg(null);
    }
  }

  async function checkForUpdates() {
    const seed = nodesRef.current.find((n) => n.kind === "seed");
    if (!seed) return;
    setLoadingMsg("Checking for new citing articles…");
    try {
      const full = await (await fetch(`${API}/${seed.id}`)).json();
      if (full.cited_by_api_url) {
        const c = await fetch(`${full.cited_by_api_url}&per_page=25`);
        const cd = await c.json();
        let added = 0;
        (cd.results || []).forEach((w) => {
          const id = shortId(w.id);
          const existed = nodesRef.current.some((n) => n.id === id);
          addNode(w, "citation");
          addLink(seed.id, id);
          if (!existed) added++;
        });
        restart(0.6);
        setSavedMsg(added > 0 ? `Found ${added} new citing article(s).` : "No new articles since last check.");
      }
    } catch (e) {
      setError("Check failed.");
    } finally {
      setLoadingMsg(null);
      setTimeout(() => setSavedMsg(""), 4000);
    }
  }

  // ---------- Zotero ----------
  async function syncDois(userId, apiKey, collectionKey) {
    const itemsUrl = collectionKey
      ? `${ZOTERO_API}/users/${userId}/collections/${collectionKey}/items?limit=100`
      : `${ZOTERO_API}/users/${userId}/items/top?limit=100&sort=dateAdded&direction=desc`;
    const res = await fetch(itemsUrl, { headers: { "Zotero-API-Key": apiKey } });
    if (!res.ok) throw new Error("Failed to sync items");
    const items = await res.json();
    zoteroDoisRef.current = new Set(
      items.map((it) => it.data && it.data.DOI).filter(Boolean).map((d) => d.toLowerCase())
    );
    setTick((t) => t + 1);
    return items.length;
  }

  async function connectZotero(userIdArg, apiKeyArg) {
    const userId = (userIdArg ?? zoteroUserId).trim();
    const apiKey = (apiKeyArg ?? zoteroApiKey).trim();

    if (!userId || !apiKey) {
      setZoteroMsg("Please enter User ID and API key.");
      return;
    }
    setZoteroBusy(true);
    setZoteroMsg("Connecting to Zotero…");
    try {
      const cr = await fetch(`${ZOTERO_API}/users/${userId}/collections?limit=200`, {
        headers: { "Zotero-API-Key": apiKey },
      });
      if (!cr.ok) throw new Error("Connection failed");
      const collections = await cr.json();
      const list = (collections || [])
        .map((c) => ({ key: c.key, name: c.data.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setZoteroCollections(list);

      const count = await syncDois(userId, apiKey, selectedCollectionKey);
      setZoteroUserId(userId);
      setZoteroApiKey(apiKey);
      setZoteroConnected(true);
      setZoteroMsg(`Connected — ${list.length} collections, synced ${count} entries.`);
    } catch (e) {
      setZoteroMsg("Connection failed. Check User ID and API key.");
      setZoteroConnected(false);
      setZoteroCollections([]);
    } finally {
      setZoteroBusy(false);
      setTimeout(() => setZoteroMsg(""), 6000);
    }
  }

  async function selectCollection(collectionKey) {
    setSelectedCollectionKey(collectionKey);
    if (!zoteroConnected) return;
    setZoteroBusy(true);
    const label =
      collectionKey === ""
        ? "main library"
        : zoteroCollections.find((c) => c.key === collectionKey)?.name || "collection";
    setZoteroMsg(`Syncing ${label}…`);
    try {
      const count = await syncDois(zoteroUserId.trim(), zoteroApiKey.trim(), collectionKey);
      setZoteroMsg(`Using ${label} — synced ${count} entries.`);
    } catch (e) {
      setZoteroMsg("Failed to sync collection.");
    } finally {
      setZoteroBusy(false);
      setTimeout(() => setZoteroMsg(""), 4000);
    }
  }

  async function addToZotero(node) {
    if (!zoteroConnected) {
      setShowZoteroPanel(true);
      setZoteroMsg("Connect to Zotero first, then add.");
      return;
    }
    setAddingId(node.id);
    try {
      let full = node;
      if (!node.authorships || node.authorships.length === 0) {
        const w = await (await fetch(`${API}/${node.id}`)).json();
        full = {
          ...node,
          authorships: w.authorships || [],
          doi: w.doi ? w.doi.replace("https://doi.org/", "") : null,
          primary_location: w.primary_location || null,
          abstract_inverted_index: w.abstract_inverted_index,
        };
      }

      const template = await (await fetch(`${ZOTERO_API}/items/new?itemType=journalArticle`)).json();

      const item = {
        ...template,
        title: full.label,
        creators: (full.authorships || []).map((a) => splitName(a.author && a.author.display_name)),
        date: String(full.year || ""),
        DOI: full.doi || "",
        url: `https://openalex.org/${full.id}`,
        publicationTitle:
          (full.primary_location && full.primary_location.source && full.primary_location.source.display_name) || "",
        abstractNote: reconstructAbstract(full.abstract_inverted_index) || "",
      };
      if (selectedCollectionKey) {
        item.collections = [selectedCollectionKey];
      }

      const res = await fetch(`${ZOTERO_API}/users/${zoteroUserId.trim()}/items`, {
        method: "POST",
        headers: {
          "Zotero-API-Key": zoteroApiKey.trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([item]),
      });
      const result = await res.json();
      if (result.successful && Object.keys(result.successful).length > 0) {
        if (full.doi) zoteroDoisRef.current.add(full.doi.toLowerCase());
        setZoteroMsg(`Added "${full.label.slice(0, 40)}…" to Zotero.`);
        setTick((t) => t + 1);
      } else {
        setZoteroMsg("Zotero rejected the paper (see console).");
        console.warn(result);
      }
    } catch (e) {
      setZoteroMsg("Failed to add.");
    } finally {
      setAddingId(null);
      setTimeout(() => setZoteroMsg(""), 5000);
    }
  }

  // ---------- share via file export/import (no backend needed) ----------
  function exportMap() {
    const payload = {
      nodes: nodesRef.current.map(
        ({ id, label, year, cited_by_count, kind, doi, referenced_works, cited_by_api_url }) => ({
          id,
          label,
          year,
          cited_by_count,
          kind,
          doi,
          referenced_works,
          cited_by_api_url,
        })
      ),
      links: linksRef.current.map((l) => ({
        source: l.source.id || l.source,
        target: l.target.id || l.target,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `litmap-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSavedMsg("Map exported as JSON file.");
    setTimeout(() => setSavedMsg(""), 4000);
  }

  function importMap(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        nodesRef.current = data.nodes.map((n) => ({
          ...n,
          x: dimsRef.current.w / 2 + (Math.random() - 0.5) * 100,
          y: dimsRef.current.h / 2 + (Math.random() - 0.5) * 100,
        }));
        linksRef.current = data.links;
        restart(1);
        setSelected(nodesRef.current.find((n) => n.kind === "seed") || null);
        setSavedMsg("Map imported.");
      } catch (err) {
        setError("Invalid map file.");
      }
      setTimeout(() => setSavedMsg(""), 4000);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ---------- drag ----------
  function onPointerDown(n, e) {
    e.stopPropagation();
    dragNode.current = n;
    simRef.current.alphaTarget(0.3).restart();
  }
  function onPointerMove(e) {
    if (!dragNode.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    dragNode.current.fx = e.clientX - rect.left;
    dragNode.current.fy = e.clientY - rect.top;
  }
  function onPointerUp() {
    if (dragNode.current) {
      dragNode.current.fx = null;
      dragNode.current.fy = null;
      simRef.current.alphaTarget(0);
    }
    dragNode.current = null;
  }

  const colorFor = (kind) =>
    kind === "seed" ? "#C9A227" : kind === "citation" ? "#4FD1C5" : "#E8E6DE";

  return (
    <div
      style={{
        fontFamily: "Georgia, 'Times New Roman', serif",
        background: "#0B1220",
        color: "#E8E6DE",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div style={{ padding: "20px 24px 12px", borderBottom: "1px solid #1E2A42" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 22, letterSpacing: 0.5 }}>Citation Explorer</span>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#7C8AA3" }}>
            OpenAlex + Zotero — local &amp; free
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 280px", minWidth: 220 }}>
            <Search size={15} style={{ position: "absolute", left: 10, top: 10, color: "#7C8AA3" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch(query)}
              placeholder="Search for a seed article (title or keyword)…"
              style={{
                width: "100%",
                background: "#121B2E",
                border: "1px solid #24314C",
                borderRadius: 6,
                padding: "8px 10px 8px 32px",
                color: "#E8E6DE",
                fontFamily: "ui-sans-serif, system-ui",
                fontSize: 13,
                outline: "none",
              }}
            />
          </div>
          <button onClick={() => doSearch(query)} style={btnStyle()}>
            {searching ? <Loader2 size={14} className="spin" /> : "Search"}
          </button>
          <button onClick={checkForUpdates} style={btnStyle()} title="Check for new citing articles">
            <RefreshCw size={14} /> Monitor
          </button>
          <button onClick={exportMap} style={btnStyle()} title="Export map as JSON">
            <Download size={14} /> Export
          </button>
          <button onClick={() => fileInputRef.current.click()} style={btnStyle()} title="Import map from JSON">
            <Upload size={14} /> Import
          </button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={importMap} style={{ display: "none" }} />
          <button
            onClick={() => setShowZoteroPanel((s) => !s)}
            style={{
              ...btnStyle(),
              background: zoteroConnected ? "#1f3a30" : "#1a2740",
              borderColor: zoteroConnected ? "#2f5a45" : "#2c3b5a",
            }}
          >
            <Library size={14} /> {zoteroConnected ? "Zotero connected" : "Zotero"}
          </button>
          {zoteroConnected && (
            <select
              value={selectedCollectionKey}
              onChange={(e) => selectCollection(e.target.value)}
              disabled={zoteroBusy}
              title="Zotero collection for sync and new papers"
              style={{
                ...inputStyle(),
                width: "auto",
                minWidth: 160,
                maxWidth: 240,
                cursor: zoteroBusy ? "wait" : "pointer",
              }}
            >
              <option value="">Main library</option>
              {zoteroCollections.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {showZoteroPanel && (
          <div
            style={{
              marginTop: 10,
              background: "#121B2E",
              border: "1px solid #24314C",
              borderRadius: 8,
              padding: 12,
              fontFamily: "ui-sans-serif, system-ui",
              fontSize: 12,
            }}
          >
            <div style={{ color: "#7C8AA3", marginBottom: 8 }}>
              Credentials come from your <code>.env</code>, but can be overridden here. Create a key at{" "}
              <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noreferrer" style={{ color: "#4FD1C5" }}>
                zotero.org/settings/keys
              </a>
              . Choose a collection in the toolbar after connecting.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={zoteroUserId} onChange={(e) => setZoteroUserId(e.target.value)} placeholder="User ID" style={{ ...inputStyle(), width: 140 }} />
              <input value={zoteroApiKey} onChange={(e) => setZoteroApiKey(e.target.value)} placeholder="API key" type="password" style={{ ...inputStyle(), width: 160 }} />
              <button onClick={() => connectZotero()} style={btnStyle()}>
                {zoteroBusy ? <Loader2 size={14} className="spin" /> : "Connect"}
              </button>
            </div>
          </div>
        )}

        {searchResults.length > 0 && (
          <div style={{ marginTop: 10, background: "#121B2E", border: "1px solid #24314C", borderRadius: 8, overflow: "hidden" }}>
            {searchResults.map((w) => (
              <div
                key={w.id}
                onClick={() => loadSeed(w)}
                style={{ padding: "9px 12px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #1E2A42", fontFamily: "ui-sans-serif, system-ui" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#1a2740")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ color: "#E8E6DE" }}>{w.display_name}</div>
                <div style={{ color: "#7C8AA3", fontSize: 11, marginTop: 2 }}>
                  {w.publication_year} · {w.cited_by_count} citations
                </div>
              </div>
            ))}
          </div>
        )}

        {(loadingMsg || error || savedMsg || zoteroMsg) && (
          <div style={{ marginTop: 8, fontSize: 12, fontFamily: "ui-sans-serif, system-ui" }}>
            {loadingMsg && <span style={{ color: "#7C8AA3" }}>{loadingMsg}</span>}
            {error && <span style={{ color: "#E07856" }}>{error}</span>}
            {savedMsg && <span style={{ color: "#4FD1C5" }}>{savedMsg}</span>}
            {zoteroMsg && <span style={{ color: "#4FD1C5" }}> {zoteroMsg}</span>}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 600 }}>
        <svg ref={svgRef} width="100%" height={dimsRef.current.h} style={{ background: "#0B1220", flex: 1, touchAction: "none" }}>
          {linksRef.current.map((l, i) => {
            const s = typeof l.source === "object" ? l.source : nodesRef.current.find((n) => n.id === l.source);
            const t = typeof l.target === "object" ? l.target : nodesRef.current.find((n) => n.id === l.target);
            if (!s || !t) return null;
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#24314C" strokeWidth={1} />;
          })}
          {nodesRef.current.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              onPointerDown={(e) => onPointerDown(n, e)}
              onClick={() => setSelected(n)}
              onDoubleClick={() => expandNode(n)}
              style={{ cursor: "pointer" }}
            >
              <circle
                r={nodeRadius(n)}
                fill={colorFor(n.kind)}
                stroke={selected && selected.id === n.id ? "#FFFFFF" : "#0B1220"}
                strokeWidth={selected && selected.id === n.id ? 2 : 1}
                opacity={0.92}
              />
              {n.doi && zoteroDoisRef.current.has(n.doi.toLowerCase()) && (
                <circle r={nodeRadius(n) + 4} fill="none" stroke="#5DBE6B" strokeWidth={1.5} strokeDasharray="2,2" />
              )}
            </g>
          ))}
        </svg>

        <div style={{ width: 280, borderLeft: "1px solid #1E2A42", padding: 16, fontFamily: "ui-sans-serif, system-ui", fontSize: 13, overflowY: "auto" }}>
          {!selected && nodesRef.current.length === 0 && (
            <div style={{ color: "#7C8AA3", lineHeight: 1.6 }}>
              <BookOpen size={18} style={{ marginBottom: 8 }} />
              <p>Search above for an article to generate your first citation network.</p>
              <p style={{ marginTop: 10 }}>Click = details · Double-click = expand node · Drag = move</p>
            </div>
          )}
          {selected && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, letterSpacing: 1, color: colorFor(selected.kind), textTransform: "uppercase" }}>
                  {selected.kind === "seed" ? "Seed" : selected.kind === "citation" ? "Cited by" : "Reference"}
                </span>
                <X size={14} style={{ cursor: "pointer", color: "#7C8AA3" }} onClick={() => setSelected(null)} />
              </div>
              <div style={{ marginTop: 6, fontFamily: "Georgia, serif", lineHeight: 1.4 }}>{selected.label}</div>
              <div style={{ marginTop: 8, color: "#7C8AA3", fontSize: 12 }}>
                {selected.year} · {selected.cited_by_count} citations
              </div>
              <button onClick={() => expandNode(selected)} style={{ ...btnStyle(), marginTop: 14, width: "100%", justifyContent: "center" }}>
                Expand network
              </button>

              {selected.doi && zoteroDoisRef.current.has(selected.doi.toLowerCase()) ? (
                <div style={{ ...btnStyle(), marginTop: 8, width: "100%", justifyContent: "center", background: "#1f3a30", borderColor: "#2f5a45", cursor: "default" }}>
                  <Check size={14} /> Already in Zotero
                </div>
              ) : (
                <button onClick={() => addToZotero(selected)} style={{ ...btnStyle(), marginTop: 8, width: "100%", justifyContent: "center" }}>
                  {addingId === selected.id ? <Loader2 size={14} className="spin" /> : (<><Plus size={14} /> Add to Zotero</>)}
                </button>
              )}

              <a
                href={`https://openalex.org/${selected.id}`}
                target="_blank"
                rel="noreferrer"
                style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, color: "#7C8AA3", fontSize: 12, textDecoration: "none" }}
              >
                <ExternalLink size={12} /> View on OpenAlex
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function inputStyle() {
  return {
    background: "#0B1220",
    border: "1px solid #24314C",
    borderRadius: 6,
    padding: "7px 10px",
    color: "#E8E6DE",
    fontSize: 12,
    fontFamily: "ui-sans-serif, system-ui",
  };
}

function btnStyle() {
  return {
    background: "#1a2740",
    border: "1px solid #2c3b5a",
    borderRadius: 6,
    padding: "8px 12px",
    color: "#E8E6DE",
    fontSize: 12,
    fontFamily: "ui-sans-serif, system-ui",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
  };
}

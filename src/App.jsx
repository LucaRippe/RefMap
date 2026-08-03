import React, { useState, useRef, useEffect } from "react";
import * as d3 from "d3";
import {
  Search,
  RefreshCw,
  X,
  Loader2,
  BookOpen,
  ExternalLink,
  Library,
  Check,
  Plus,
  Map as MapIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Eye,
  EyeOff,
  Tag,
} from "lucide-react";

const API = "https://api.openalex.org/works";
const ZOTERO_API = "https://api.zotero.org";

// Values come from .env (see .env.example) — never hard-code your key here.
const ENV_USER_ID = import.meta.env.VITE_ZOTERO_USER_ID || "";
const ENV_API_KEY = import.meta.env.VITE_ZOTERO_API_KEY || "";

const PLOT = { top: 36, right: 28, bottom: 48, left: 56 };
const MAP_HEIGHT_MIN = 280;
const MAP_HEIGHT_MAX = 1600;

function defaultMapHeight() {
  if (typeof window === "undefined") return 620;
  return Math.min(MAP_HEIGHT_MAX, Math.max(MAP_HEIGHT_MIN, window.innerHeight - 220));
}

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

function normalizeDoi(doi) {
  if (!doi) return null;
  return String(doi)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
}

function nodeRadius(n) {
  if (n.kind === "collection" || n.kind === "discovery") {
    const d = n.internalDegree || 0;
    return Math.max(5, Math.min(22, 5 + Math.sqrt(d) * 3.2));
  }
  const c = n.cited_by_count || 0;
  return Math.max(7, Math.min(26, 7 + Math.sqrt(c) * 1.4));
}

function colorFor(kind) {
  if (kind === "collection") return "#E05353";
  if (kind === "discovery") return "#3DCF7A";
  if (kind === "seed") return "#C9A227";
  if (kind === "citation") return "#4FD1C5";
  return "#E8E6DE";
}

const MAX_DISCOVERY_NODES = 120;
const MAX_CITING_PER_PAPER = 12;

async function fetchWorksByOpenAlexIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const works = [];
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const params = new URLSearchParams({
      filter: `openalex_id:${chunk.join("|")}`,
      per_page: String(Math.min(chunk.length, 50)),
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAlex ID lookup failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    works.push(...(data.results || []));
  }
  return works;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function workToNode(w, kind) {
  return {
    id: shortId(w.id),
    label: w.display_name || "Untitled",
    year: w.publication_year,
    cited_by_count: w.cited_by_count || 0,
    referenced_works: w.referenced_works || [],
    cited_by_api_url: w.cited_by_api_url,
    doi: normalizeDoi(w.doi),
    authorships: w.authorships || [],
    primary_location: w.primary_location || null,
    abstract: w.abstract_inverted_index
      ? reconstructAbstract(w.abstract_inverted_index)
      : undefined,
    kind,
    internalDegree: 0,
    x: 0,
    y: 0,
  };
}

/** Shorten a directed edge so arrowheads sit on the circle rim. */
function edgeEndpoints(s, t, curveSign = 0) {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const sr = nodeRadius(s);
  const tr = nodeRadius(t) + 5;
  let x1 = s.x + ux * sr;
  let y1 = s.y + uy * sr;
  let x2 = t.x - ux * tr;
  let y2 = t.y - uy * tr;

  if (curveSign) {
    const offset = Math.min(28, dist * 0.18) * curveSign;
    const mx = (x1 + x2) / 2 - uy * offset;
    const my = (y1 + y2) / 2 + ux * offset;
    return { curved: true, x1, y1, x2, y2, mx, my };
  }
  return { curved: false, x1, y1, x2, y2 };
}

async function fetchAllZoteroItems(userId, apiKey, collectionKey) {
  const headers = { "Zotero-API-Key": apiKey };
  const base = collectionKey
    ? `${ZOTERO_API}/users/${userId}/collections/${collectionKey}/items/top`
    : `${ZOTERO_API}/users/${userId}/items/top`;
  const all = [];
  let start = 0;
  while (true) {
    const res = await fetch(`${base}?limit=100&start=${start}`, { headers });
    if (!res.ok) throw new Error("Failed to fetch Zotero items");
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
    start += 100;
  }
  return all.filter(
    (it) => it.data && !["attachment", "note", "annotation"].includes(it.data.itemType)
  );
}

async function fetchWorksByDois(dois) {
  const unique = [...new Set(dois.filter(Boolean))];
  const works = [];
  // OpenAlex OR syntax: doi:value1|value2|value3  (prefix once; values separated by |)
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const params = new URLSearchParams({
      filter: `doi:${chunk.join("|")}`,
      per_page: String(Math.min(chunk.length, 50)),
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAlex lookup failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    works.push(...(data.results || []));
  }
  return works;
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
  const [mapMode, setMapMode] = useState("explore"); // "explore" | "collection"
  const [showLinks, setShowLinks] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [mapHeight, setMapHeight] = useState(defaultMapHeight);
  const [highlightId, setHighlightId] = useState(null);
  const [viewTransform, setViewTransform] = useState(() => d3.zoomIdentity);
  const [abstractLoading, setAbstractLoading] = useState(false);

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
  const dimsRef = useRef({ w: 900, h: defaultMapHeight() });
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const axisRef = useRef(null);
  const simRef = useRef(null);
  const dragNode = useRef(null);
  const zoomBehaviorRef = useRef(null);
  const transformRef = useRef(d3.zoomIdentity);
  const logScaleRef = useRef(false);
  const resizingRef = useRef(null);

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

    if (ENV_USER_ID && ENV_API_KEY) {
      connectZotero(ENV_USER_ID, ENV_API_KEY);
    }
    return () => sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const zoom = d3
      .zoom()
      .scaleExtent([0.25, 8])
      .filter((event) => {
        // Allow wheel zoom always; pan with left-drag on background (not on nodes)
        if (event.type === "wheel") return true;
        if (event.type === "mousedown" || event.type === "pointerdown") {
          return event.target === svgRef.current || event.target.closest?.(".plot-bg");
        }
        return !event.ctrlKey;
      })
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        setViewTransform(event.transform);
      });
    svg.call(zoom);
    zoomBehaviorRef.current = zoom;
    return () => {
      svg.on(".zoom", null);
    };
  }, []);

  useEffect(() => {
    function measure() {
      if (!svgRef.current) return;
      const w = svgRef.current.clientWidth || 900;
      dimsRef.current.w = w;
      dimsRef.current.h = mapHeight;
      if (mapMode === "collection" && nodesRef.current.length) {
        layoutCollectionMap();
        setTick((t) => t + 1);
      } else if (simRef.current) {
        simRef.current.force("center", d3.forceCenter(w / 2, mapHeight / 2));
        // Nudge explore layout when height changes
        if (nodesRef.current.length) restart(0.4);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode, logScale, mapHeight]);

  function onMapHeightResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { startY: e.clientY, startH: mapHeight };
    const onMove = (ev) => {
      if (!resizingRef.current) return;
      const delta = ev.clientY - resizingRef.current.startY;
      const next = Math.round(
        Math.min(MAP_HEIGHT_MAX, Math.max(MAP_HEIGHT_MIN, resizingRef.current.startH + delta))
      );
      setMapHeight(next);
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function fillViewportHeight() {
    setMapHeight(Math.round(defaultMapHeight()));
  }

  function panToNode(n) {
    if (!n || !svgRef.current || !zoomBehaviorRef.current || n.x == null || n.y == null) return;
    const w = dimsRef.current.w;
    const h = dimsRef.current.h;
    const k = Math.max(transformRef.current.k, 1.25);
    const t = d3.zoomIdentity.translate(w / 2 - n.x * k, h / 2 - n.y * k).scale(k);
    d3.select(svgRef.current).transition().duration(400).call(zoomBehaviorRef.current.transform, t);
  }

  async function focusSearchResult(work) {
    const id = shortId(work.id);
    const doi = normalizeDoi(work.doi);
    setSearchResults([]);
    setQuery("");
    setError(null);

    let node = nodesRef.current.find((n) => n.id === id);
    if (!node && doi) {
      node = nodesRef.current.find((n) => n.doi && n.doi === doi);
    }

    if (!node) {
      setHighlightId(null);
      setSavedMsg("Paper is not on the current map.");
      setTimeout(() => setSavedMsg(""), 4000);
      return;
    }

    setHighlightId(node.id);
    await selectNode(node);
    panToNode(node);
    setSavedMsg("Highlighted on map.");
    setTimeout(() => setSavedMsg(""), 3000);
  }

  function restart(alpha = 0.9) {
    const sim = simRef.current;
    if (!sim) return;
    sim.nodes(nodesRef.current);
    sim.force("link").links(linksRef.current);
    sim.alpha(alpha).restart();
  }

  function layoutCollectionMap() {
    const nodes = nodesRef.current;
    if (!nodes.length) {
      axisRef.current = null;
      return;
    }
    const w = dimsRef.current.w;
    const h = dimsRef.current.h;
    const years = nodes.map((n) => n.year).filter((y) => y != null);
    const cites = nodes.map((n) => n.cited_by_count || 0);
    const minYear = (years.length ? d3.min(years) : 2000) - 1;
    const maxYear = (years.length ? d3.max(years) : new Date().getFullYear()) + 1;
    const maxCite = Math.max(d3.max(cites) || 0, 1);
    const useLog = logScaleRef.current;

    const xScale = d3
      .scaleLinear()
      .domain([minYear, maxYear])
      .range([PLOT.left, w - PLOT.right]);
    const yScale = useLog
      ? d3
          .scaleLog()
          .domain([1, Math.max(maxCite * 1.08, 2)])
          .range([h - PLOT.bottom, PLOT.top])
          .clamp(true)
      : d3
          .scaleLinear()
          .domain([0, maxCite * 1.08])
          .range([h - PLOT.bottom, PLOT.top]);

    // Slight vertical jitter for identical year/cite pairs so nodes don't fully overlap
    const seen = new Map();
    nodes.forEach((n) => {
      const year = n.year ?? minYear;
      const citeVal = useLog ? Math.max(1, n.cited_by_count || 0) : n.cited_by_count || 0;
      const key = `${year}|${n.cited_by_count || 0}`;
      const dup = seen.get(key) || 0;
      seen.set(key, dup + 1);
      n.x = xScale(year) + (dup % 2 === 0 ? -1 : 1) * Math.floor(dup / 2) * 4;
      n.y = yScale(citeVal) - Math.floor(dup / 2) * 3;
      n.fx = n.x;
      n.fy = n.y;
    });

    const yTicks = useLog
      ? yScale.ticks(6).map((v) => ({ value: Math.round(v), y: yScale(v) }))
      : yScale.ticks(6).map((v) => ({ value: Math.round(v), y: yScale(v) }));

    axisRef.current = {
      xTicks: xScale.ticks(8).map((v) => ({ value: v, x: xScale(v) })),
      yTicks,
      xLabel: "Publication year",
      yLabel: useLog ? "Citations (log)" : "Citations",
      w,
      h,
    };
  }

  function resetZoom() {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    d3.select(svgRef.current).transition().duration(250).call(zoomBehaviorRef.current.transform, d3.zoomIdentity);
  }

  function zoomBy(factor) {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    d3.select(svgRef.current).transition().duration(200).call(zoomBehaviorRef.current.scaleBy, factor);
  }

  function fitView() {
    const nodes = nodesRef.current;
    if (!nodes.length || !svgRef.current || !zoomBehaviorRef.current) {
      resetZoom();
      return;
    }
    const w = dimsRef.current.w;
    const h = dimsRef.current.h;
    const pad = 40;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = d3.min(xs) - pad;
    const maxX = d3.max(xs) + pad;
    const minY = d3.min(ys) - pad;
    const maxY = d3.max(ys) + pad;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const scale = Math.min(8, Math.max(0.25, 0.9 * Math.min(w / bw, h / bh)));
    const tx = w / 2 - (scale * (minX + maxX)) / 2;
    const ty = h / 2 - (scale * (minY + maxY)) / 2;
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    d3.select(svgRef.current).transition().duration(300).call(zoomBehaviorRef.current.transform, t);
  }

  function toggleLogScale() {
    const next = !logScaleRef.current;
    logScaleRef.current = next;
    setLogScale(next);
    if (mapMode === "collection") {
      layoutCollectionMap();
      setTick((t) => t + 1);
    }
  }

  async function selectNode(n) {
    setSelected(n);
    if (n.abstract != null && n.abstract !== undefined) return;
    setAbstractLoading(true);
    try {
      const w = await (await fetch(`${API}/${n.id}`)).json();
      const abstract = reconstructAbstract(w.abstract_inverted_index) || "";
      n.abstract = abstract;
      n.abstract_inverted_index = w.abstract_inverted_index;
      if (!n.authorships?.length) n.authorships = w.authorships || [];
      if (!n.doi) n.doi = normalizeDoi(w.doi);
      if (!n.primary_location) n.primary_location = w.primary_location || null;
      setSelected({ ...n });
      setTick((t) => t + 1);
    } catch (e) {
      n.abstract = "";
      setSelected({ ...n });
    } finally {
      setAbstractLoading(false);
    }
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
        doi: normalizeDoi(work.doi),
        authorships: work.authorships || [],
        primary_location: work.primary_location || null,
        abstract: work.abstract_inverted_index
          ? reconstructAbstract(work.abstract_inverted_index)
          : undefined,
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
    setMapMode("explore");
    axisRef.current = null;
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
    if (mapMode === "collection") return;
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

  async function createCollectionMap() {
    if (!zoteroConnected) {
      setShowZoteroPanel(true);
      setZoteroMsg("Connect to Zotero first.");
      return;
    }
    const userId = zoteroUserId.trim();
    const apiKey = zoteroApiKey.trim();
    const label =
      selectedCollectionKey === ""
        ? "main library"
        : zoteroCollections.find((c) => c.key === selectedCollectionKey)?.name || "collection";

    setLoadingMsg(`Building map from ${label}…`);
    setError(null);
    setSelected(null);
    setHighlightId(null);
    try {
      if (simRef.current) simRef.current.stop();

      const items = await fetchAllZoteroItems(userId, apiKey, selectedCollectionKey || null);
      const dois = items.map((it) => normalizeDoi(it.data.DOI)).filter(Boolean);
      if (!dois.length) {
        setError("No papers with DOIs found in this collection.");
        setLoadingMsg(null);
        return;
      }

      setLoadingMsg(`Looking up ${dois.length} papers on OpenAlex…`);
      const works = await fetchWorksByDois(dois);
      if (!works.length) {
        setError("No matching papers found on OpenAlex.");
        setLoadingMsg(null);
        return;
      }

      const collectionNodes = works.map((w) => workToNode(w, "collection"));
      const collectionIds = new Set(collectionNodes.map((n) => n.id));

      // --- Discovery: papers outside the collection that cite or are cited by it ---
      // Score external IDs by how often they appear as references of collection papers
      const refScore = new Map();
      collectionNodes.forEach((n) => {
        (n.referenced_works || []).forEach((refUrl) => {
          const id = shortId(refUrl);
          if (!collectionIds.has(id)) {
            refScore.set(id, (refScore.get(id) || 0) + 1);
          }
        });
      });

      setLoadingMsg("Finding citing papers outside the collection…");
      const citingScore = new Map();
      const citingLinks = []; // { source: citingId, target: collectionId }
      await mapPool(collectionNodes, 5, async (n) => {
        if (!n.cited_by_api_url) return;
        try {
          const res = await fetch(`${n.cited_by_api_url}&per_page=${MAX_CITING_PER_PAPER}`);
          if (!res.ok) return;
          const data = await res.json();
          (data.results || []).forEach((w) => {
            const id = shortId(w.id);
            if (collectionIds.has(id)) return;
            citingScore.set(id, (citingScore.get(id) || 0) + 1);
            citingLinks.push({ source: id, target: n.id });
          });
        } catch {
          /* ignore single-paper citing failures */
        }
      });

      // Prefer papers linked to multiple collection items, then fill up to cap
      const candidateScore = new Map();
      refScore.forEach((s, id) => candidateScore.set(id, (candidateScore.get(id) || 0) + s * 2));
      citingScore.forEach((s, id) => candidateScore.set(id, (candidateScore.get(id) || 0) + s));
      const rankedIds = [...candidateScore.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id)
        .slice(0, MAX_DISCOVERY_NODES);

      let discoveryNodes = [];
      if (rankedIds.length) {
        setLoadingMsg(`Loading ${rankedIds.length} discovery papers…`);
        const discoveryWorks = await fetchWorksByOpenAlexIds(rankedIds);
        discoveryNodes = discoveryWorks.map((w) => workToNode(w, "discovery"));
      }

      const discoveryIds = new Set(discoveryNodes.map((n) => n.id));
      const nodes = [...collectionNodes, ...discoveryNodes];
      const idSet = new Set(nodes.map((n) => n.id));

      const links = [];
      const neighborSets = new Map(nodes.map((n) => [n.id, new Set()]));
      const addEdge = (sourceId, targetId) => {
        if (!idSet.has(sourceId) || !idSet.has(targetId) || sourceId === targetId) return;
        if (links.some((l) => l.source === sourceId && l.target === targetId)) return;
        links.push({ source: sourceId, target: targetId });
        neighborSets.get(sourceId).add(targetId);
        neighborSets.get(targetId).add(sourceId);
      };

      // Collection → referenced work (collection or discovery)
      collectionNodes.forEach((n) => {
        (n.referenced_works || []).forEach((refUrl) => {
          addEdge(n.id, shortId(refUrl));
        });
      });

      // Discovery → collection (from cited_by lookups)
      citingLinks.forEach((l) => {
        if (discoveryIds.has(l.source)) addEdge(l.source, l.target);
      });

      // Discovery → collection via their own reference lists (extra coverage)
      discoveryNodes.forEach((n) => {
        (n.referenced_works || []).forEach((refUrl) => {
          const targetId = shortId(refUrl);
          if (collectionIds.has(targetId)) addEdge(n.id, targetId);
        });
      });

      nodes.forEach((n) => {
        n.internalDegree = neighborSets.get(n.id).size;
      });

      const forward = new Set(links.map((l) => `${l.source}->${l.target}`));
      links.forEach((l) => {
        l.mutual = forward.has(`${l.target}->${l.source}`);
      });

      nodesRef.current = nodes;
      linksRef.current = links;
      zoteroDoisRef.current = new Set(collectionNodes.map((n) => n.doi).filter(Boolean));
      setShowDiscovery(true);
      setMapMode("collection");
      layoutCollectionMap();
      setTick((t) => t + 1);
      requestAnimationFrame(() => resetZoom());

      const skipped = items.length - collectionNodes.length;
      setSavedMsg(
        `Map created: ${collectionNodes.length} in collection (red), ${discoveryNodes.length} discovery (green), ${links.length} links` +
          (skipped > 0 ? ` · ${skipped} collection items skipped.` : ".")
      );
      setTimeout(() => setSavedMsg(""), 7000);
    } catch (e) {
      console.warn(e);
      setError(e?.message ? `Could not create collection map: ${e.message}` : "Could not create collection map.");
    } finally {
      setLoadingMsg(null);
    }
  }

  // ---------- Zotero ----------
  async function syncDois(userId, apiKey, collectionKey) {
    const items = await fetchAllZoteroItems(userId, apiKey, collectionKey || null);
    zoteroDoisRef.current = new Set(
      items.map((it) => normalizeDoi(it.data && it.data.DOI)).filter(Boolean)
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
          doi: normalizeDoi(w.doi),
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

  // ---------- drag (explore mode only) ----------
  function pointerToPlot(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const [x, y] = transformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top]);
    return { x, y };
  }

  function onPointerDown(n, e) {
    if (mapMode === "collection") return;
    e.stopPropagation();
    dragNode.current = n;
    simRef.current.alphaTarget(0.3).restart();
  }
  function onPointerMove(e) {
    if (!dragNode.current || mapMode === "collection") return;
    const p = pointerToPlot(e);
    dragNode.current.fx = p.x;
    dragNode.current.fy = p.y;
  }
  function onPointerUp() {
    if (dragNode.current && mapMode !== "collection") {
      dragNode.current.fx = null;
      dragNode.current.fy = null;
      simRef.current.alphaTarget(0);
    }
    dragNode.current = null;
  }

  const axis = axisRef.current;
  const collectionLabel =
    selectedCollectionKey === ""
      ? "Main library"
      : zoteroCollections.find((c) => c.key === selectedCollectionKey)?.name || "Collection";

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
          <span style={{ fontSize: 22, letterSpacing: 0.5 }}>RefMap - Free Citation Explorer</span>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#7C8AA3" }}>
            Powered by OpenAlex + Zotero
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flex: "1 1 320px",
              minWidth: 240,
              maxWidth: "100%",
              alignItems: "center",
            }}
          >
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#7C8AA3", pointerEvents: "none" }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch(query)}
                placeholder="Search papers (highlight on map)…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
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
            <button onClick={() => doSearch(query)} style={{ ...btnStyle(), flexShrink: 0 }}>
              {searching ? <Loader2 size={14} className="spin" /> : "Search"}
            </button>
          </div>
          <button onClick={checkForUpdates} style={{ ...btnStyle(), flexShrink: 0 }} title="Check for new citing articles">
            <RefreshCw size={14} /> Monitor
          </button>
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
            <>
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
              <button
                onClick={createCollectionMap}
                disabled={!!loadingMsg || zoteroBusy}
                style={btnStyle()}
                title={`Create a citation map from ${collectionLabel}`}
              >
                {loadingMsg ? <Loader2 size={14} className="spin" /> : <MapIcon size={14} />} Create Map
              </button>
            </>
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
                onClick={() => focusSearchResult(w)}
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

      <div style={{ display: "flex", flex: 1, minHeight: mapHeight + 12 }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <svg
            ref={svgRef}
            width="100%"
            height={mapHeight}
            style={{ background: "#0B1220", display: "block", touchAction: "none", cursor: "grab", flex: "0 0 auto" }}
          >
            <defs>
              <marker
                id="arrow-white"
                viewBox="0 0 8 8"
                refX="6"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#FFFFFF" />
              </marker>
            </defs>

            <rect className="plot-bg" width="100%" height="100%" fill="#0B1220" />

            <g transform={`translate(${viewTransform.x},${viewTransform.y}) scale(${viewTransform.k})`}>
              {mapMode === "collection" && axis && (
                <g style={{ fontFamily: "ui-sans-serif, system-ui", fontSize: 11 }}>
                  {axis.xTicks.map((t) => (
                    <g key={`x-${t.value}`}>
                      <line x1={t.x} y1={PLOT.top} x2={t.x} y2={axis.h - PLOT.bottom} stroke="#1E2A42" strokeWidth={1} />
                      <text x={t.x} y={axis.h - PLOT.bottom + 18} fill="#7C8AA3" textAnchor="middle">
                        {t.value}
                      </text>
                    </g>
                  ))}
                  {axis.yTicks.map((t) => (
                    <g key={`y-${t.value}`}>
                      <line x1={PLOT.left} y1={t.y} x2={axis.w - PLOT.right} y2={t.y} stroke="#1E2A42" strokeWidth={1} />
                      <text x={PLOT.left - 8} y={t.y + 3} fill="#7C8AA3" textAnchor="end">
                        {t.value}
                      </text>
                    </g>
                  ))}
                  <text
                    x={(PLOT.left + axis.w - PLOT.right) / 2}
                    y={axis.h - 10}
                    fill="#7C8AA3"
                    textAnchor="middle"
                    fontSize={12}
                  >
                    {axis.xLabel}
                  </text>
                  <text
                    x={16}
                    y={(PLOT.top + axis.h - PLOT.bottom) / 2}
                    fill="#7C8AA3"
                    textAnchor="middle"
                    fontSize={12}
                    transform={`rotate(-90, 16, ${(PLOT.top + axis.h - PLOT.bottom) / 2})`}
                  >
                    {axis.yLabel}
                  </text>
                </g>
              )}

              {showLinks &&
                linksRef.current.map((l, i) => {
                  const s = typeof l.source === "object" ? l.source : nodesRef.current.find((n) => n.id === l.source);
                  const t = typeof l.target === "object" ? l.target : nodesRef.current.find((n) => n.id === l.target);
                  if (!s || !t || s.x == null || t.x == null) return null;
                  if (
                    mapMode === "collection" &&
                    !showDiscovery &&
                    (s.kind === "discovery" || t.kind === "discovery")
                  ) {
                    return null;
                  }
                  const linkDimmed =
                    highlightId && s.id !== highlightId && t.id !== highlightId;

                  if (mapMode === "collection") {
                    const sid = s.id;
                    const tid = t.id;
                    const curveSign = l.mutual ? (sid < tid ? 1 : -1) : 0;
                    const ep = edgeEndpoints(s, t, curveSign);
                    if (ep.curved) {
                      return (
                        <path
                          key={i}
                          d={`M ${ep.x1} ${ep.y1} Q ${ep.mx} ${ep.my} ${ep.x2} ${ep.y2}`}
                          fill="none"
                          stroke="#FFFFFF"
                          strokeWidth={0.9 / viewTransform.k}
                          opacity={linkDimmed ? 0.08 : 0.55}
                          markerEnd="url(#arrow-white)"
                        />
                      );
                    }
                    return (
                      <line
                        key={i}
                        x1={ep.x1}
                        y1={ep.y1}
                        x2={ep.x2}
                        y2={ep.y2}
                        stroke="#FFFFFF"
                        strokeWidth={0.9 / viewTransform.k}
                        opacity={linkDimmed ? 0.08 : 0.55}
                        markerEnd="url(#arrow-white)"
                      />
                    );
                  }

                  return (
                    <line
                      key={i}
                      x1={s.x}
                      y1={s.y}
                      x2={t.x}
                      y2={t.y}
                      stroke="#24314C"
                      strokeWidth={1 / viewTransform.k}
                      opacity={linkDimmed ? 0.15 : 1}
                    />
                  );
                })}

              {nodesRef.current.map((n) => {
                if (mapMode === "collection" && !showDiscovery && n.kind === "discovery") return null;
                const isHighlight = highlightId === n.id;
                const dimmed = highlightId && !isHighlight;
                return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  onPointerDown={(e) => onPointerDown(n, e)}
                  onClick={() => {
                    setHighlightId(null);
                    selectNode(n);
                  }}
                  onDoubleClick={() => expandNode(n)}
                  style={{ cursor: "pointer" }}
                >
                  {isHighlight && (
                    <circle
                      r={nodeRadius(n) + 8}
                      fill="none"
                      stroke="#FFD166"
                      strokeWidth={2.5 / viewTransform.k}
                      opacity={0.95}
                    />
                  )}
                  <circle
                    r={nodeRadius(n)}
                    fill={colorFor(n.kind)}
                    stroke={
                      isHighlight
                        ? "#FFD166"
                        : selected && selected.id === n.id
                          ? "#FFFFFF"
                          : "#0B1220"
                    }
                    strokeWidth={(isHighlight || (selected && selected.id === n.id) ? 2.5 : 1) / viewTransform.k}
                    opacity={dimmed ? 0.18 : 0.92}
                  />
                  {mapMode !== "collection" && n.doi && zoteroDoisRef.current.has(n.doi.toLowerCase()) && (
                    <circle
                      r={nodeRadius(n) + 4}
                      fill="none"
                      stroke="#5DBE6B"
                      strokeWidth={1.5 / viewTransform.k}
                      strokeDasharray={`${2 / viewTransform.k},${2 / viewTransform.k}`}
                      opacity={dimmed ? 0.2 : 1}
                    />
                  )}
                  {showLabels && (
                    <text
                      y={nodeRadius(n) + 12}
                      textAnchor="middle"
                      fill="#E8E6DE"
                      fontSize={10 / viewTransform.k}
                      fontFamily="ui-sans-serif, system-ui"
                      style={{ pointerEvents: "none" }}
                      opacity={dimmed ? 0.2 : 1}
                    >
                      {n.label.length > 36 ? `${n.label.slice(0, 34)}…` : n.label}
                    </text>
                  )}
                </g>
              );
              })}
            </g>
          </svg>

          {/* Height resize handle */}
          <div
            onPointerDown={onMapHeightResizeStart}
            title="Drag to resize map height"
            style={{
              height: 10,
              cursor: "ns-resize",
              background: "#121B2E",
              borderTop: "1px solid #1E2A42",
              borderBottom: "1px solid #1E2A42",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 auto",
              userSelect: "none",
            }}
          >
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#3A4A68" }} />
          </div>

          {/* Zoom & view controls */}
          <div
            style={{
              position: "absolute",
              right: 12,
              bottom: 22,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontFamily: "ui-sans-serif, system-ui",
            }}
          >
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => zoomBy(1.3)} style={iconBtnStyle()} title="Zoom in">
                <ZoomIn size={14} />
              </button>
              <button onClick={() => zoomBy(1 / 1.3)} style={iconBtnStyle()} title="Zoom out">
                <ZoomOut size={14} />
              </button>
              <button onClick={fitView} style={iconBtnStyle()} title="Fit to view">
                <Maximize2 size={14} />
              </button>
              <button onClick={resetZoom} style={{ ...iconBtnStyle(), fontSize: 10, padding: "0 8px" }} title="Reset zoom">
                {Math.round(viewTransform.k * 100)}%
              </button>
              <button
                onClick={fillViewportHeight}
                style={{ ...iconBtnStyle(), fontSize: 10, padding: "0 8px", minWidth: 48 }}
                title="Fit map height to viewport"
              >
                {Math.round(mapHeight)}px
              </button>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => setShowLinks((v) => !v)}
                style={{
                  ...iconBtnStyle(),
                  background: showLinks ? "#1a2740" : "#121820",
                  opacity: showLinks ? 1 : 0.7,
                }}
                title={showLinks ? "Hide links" : "Show links"}
              >
                {showLinks ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                onClick={() => setShowLabels((v) => !v)}
                style={{
                  ...iconBtnStyle(),
                  background: showLabels ? "#24314C" : "#1a2740",
                }}
                title={showLabels ? "Hide labels" : "Show labels"}
              >
                <Tag size={14} />
              </button>
              {mapMode === "collection" && (
                <>
                  <button
                    onClick={() => setShowDiscovery((v) => !v)}
                    style={{
                      ...iconBtnStyle(),
                      fontSize: 10,
                      padding: "0 8px",
                      background: showDiscovery ? "#1f3a30" : "#1a2740",
                      borderColor: showDiscovery ? "#2f5a45" : "#2c3b5a",
                      color: showDiscovery ? "#3DCF7A" : "#E8E6DE",
                      minWidth: 64,
                    }}
                    title={showDiscovery ? "Hide discovery papers" : "Show discovery papers"}
                  >
                    discovery
                  </button>
                  <button
                    onClick={toggleLogScale}
                    style={{
                      ...iconBtnStyle(),
                      fontSize: 10,
                      padding: "0 8px",
                      background: logScale ? "#24314C" : "#1a2740",
                      minWidth: 52,
                    }}
                    title="Toggle log scale for citations"
                  >
                    {logScale ? "log Y" : "lin Y"}
                  </button>
                </>
              )}
            </div>
            <div style={{ fontSize: 10, color: "#7C8AA3", textAlign: "right" }}>
              {mapMode === "collection" ? (
                <>
                  <span style={{ color: "#E05353" }}>●</span> collection{" "}
                  <span style={{ color: "#3DCF7A" }}>●</span> discovery · scroll to zoom
                </>
              ) : (
                <>Scroll to zoom · drag background to pan</>
              )}
            </div>
          </div>
        </div>

        <div style={{ width: 300, borderLeft: "1px solid #1E2A42", padding: 16, fontFamily: "ui-sans-serif, system-ui", fontSize: 13, overflowY: "auto" }}>
          {!selected && nodesRef.current.length === 0 && (
            <div style={{ color: "#7C8AA3", lineHeight: 1.6 }}>
              <BookOpen size={18} style={{ marginBottom: 8 }} />
              <p>Search above for an article, or connect Zotero and click Create Map for a collection overview.</p>
              <p style={{ marginTop: 10 }}>Click = details · Double-click = expand · Scroll = zoom</p>
            </div>
          )}
          {selected && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, letterSpacing: 1, color: colorFor(selected.kind), textTransform: "uppercase" }}>
                  {selected.kind === "seed"
                    ? "Seed"
                    : selected.kind === "citation"
                      ? "Cited by"
                      : selected.kind === "collection"
                        ? "In collection"
                        : selected.kind === "discovery"
                          ? "Discovery"
                          : "Reference"}
                </span>
                <X
                  size={14}
                  style={{ cursor: "pointer", color: "#7C8AA3" }}
                  onClick={() => {
                    setSelected(null);
                    setHighlightId(null);
                  }}
                />
              </div>
              <div style={{ marginTop: 6, fontFamily: "Georgia, serif", lineHeight: 1.4 }}>{selected.label}</div>
              <div style={{ marginTop: 8, color: "#7C8AA3", fontSize: 12 }}>
                {selected.year} · {selected.cited_by_count} citations
                {(selected.kind === "collection" || selected.kind === "discovery") && (
                  <> · {selected.internalDegree || 0} network links</>
                )}
              </div>

              {(selected.authorships || []).length > 0 && (
                <div style={{ marginTop: 8, color: "#9AA8C0", fontSize: 11, lineHeight: 1.4 }}>
                  {(selected.authorships || [])
                    .slice(0, 8)
                    .map((a) => a.author?.display_name)
                    .filter(Boolean)
                    .join(", ")}
                  {(selected.authorships || []).length > 8 ? "…" : ""}
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10, letterSpacing: 1, color: "#7C8AA3", textTransform: "uppercase", marginBottom: 6 }}>
                  Abstract
                </div>
                {abstractLoading && selected.abstract == null ? (
                  <div style={{ color: "#7C8AA3", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    <Loader2 size={12} className="spin" /> Loading…
                  </div>
                ) : selected.abstract ? (
                  <p style={{ color: "#C8CDE0", fontSize: 12, lineHeight: 1.55, margin: 0 }}>{selected.abstract}</p>
                ) : (
                  <p style={{ color: "#7C8AA3", fontSize: 12, margin: 0 }}>No abstract available.</p>
                )}
              </div>

              {mapMode !== "collection" && (
                <button onClick={() => expandNode(selected)} style={{ ...btnStyle(), marginTop: 14, width: "100%", justifyContent: "center" }}>
                  Expand network
                </button>
              )}

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

function iconBtnStyle() {
  return {
    background: "#1a2740",
    border: "1px solid #2c3b5a",
    borderRadius: 6,
    width: 32,
    height: 32,
    color: "#E8E6DE",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  };
}

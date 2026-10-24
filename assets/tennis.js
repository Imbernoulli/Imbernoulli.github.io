(() => {
  "use strict";
  const TIMEZONE = "America/Los_Angeles";
  const CACHE_KEY = "berkeley-tennis-v1";

  function pacificClock(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map(part => [part.type, part.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minute: Number(parts.hour) * 60 + Number(parts.minute) + (Number(parts.second) > 0 ? 1 : 0),
      hour: Number(parts.hour),
    };
  }

  function nextDates(today) {
    return [0, 1, 2].map(offset => {
      const day = new Date(`${today}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + offset);
      return day.toISOString().slice(0, 10);
    });
  }

  function minutes(time) {
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  }

  function visibleSlots(slots, date, clock) {
    if (date < clock.date) return [];
    const current = date === clock.date ? clock.minute : 0;
    const gridStart = Math.floor(current / 30) * 30;
    return slots.flatMap(([start, end]) => {
      if (minutes(end) <= current) return [];
      const a = Math.max(minutes(start), gridStart);
      const from = `${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
      return [[from, end]];
    });
  }

  function validateSnapshot(data) {
    const object = value => value && typeof value === "object" && !Array.isArray(value);
    const validTime = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!object(data) || data.schema_version !== 1 || data.timezone !== TIMEZONE ||
        !Number.isFinite(Date.parse(data.generated_at)) || !object(data.dates) ||
        Object.keys(data.dates).length === 0) throw new Error("Invalid availability snapshot");
    for (const [date, parks] of Object.entries(data.dates)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !object(parks) || Object.keys(parks).length === 0) {
        throw new Error("Invalid availability date");
      }
      for (const courts of Object.values(parks)) {
        if (!Array.isArray(courts) || courts.length === 0) throw new Error("Invalid court list");
        for (const court of courts) {
          if (!object(court) || typeof court.court !== "string" || !Array.isArray(court.slots) ||
              court.slots.some(slot => !Array.isArray(slot) || slot.length !== 2 ||
                !slot.every(validTime) || minutes(slot[0]) >= minutes(slot[1]))) {
            throw new Error("Invalid court availability");
          }
        }
      }
    }
    return data;
  }

  function formatTime(minute) {
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }

  function buildTimeline(parks, date, clock) {
    const firstMinute = date === clock.date
      ? Math.min(22 * 60, Math.max(7 * 60, Math.floor(clock.minute / 30) * 30)) : 7 * 60;
    const boundaries = new Set(Array.from({ length: (22 * 60 - firstMinute) / 30 + 1 }, (_, i) => firstMinute + i * 30));
    const columns = Object.entries(parks).map(([park, courts]) => {
      const windows = courts.flatMap(court => visibleSlots(court.slots, date, clock).map(([start, end]) => {
        const a = minutes(start), b = minutes(end);
        boundaries.add(a); boundaries.add(b);
        return { start: a, end: b, court: court.court };
      }));
      return { park, windows };
    });
    const times = [...boundaries].sort((a, b) => a - b);
    for (const column of columns) {
      const active = times.slice(0, -1).map((start, row) => column.windows
        .filter(window => window.start <= start && window.end >= times[row + 1])
        .map(window => window.court).sort());
      column.runs = new Map();
      for (let row = 0; row < active.length;) {
        let end = row + 1;
        if (active[row].length) {
          while (end < active.length && JSON.stringify(active[end]) === JSON.stringify(active[row])) end++;
        }
        column.runs.set(row, { rowSpan: end - row, start: times[row], end: times[end], courts: active[row] });
        row = end;
      }
    }
    const rows = [];
    const emptyAt = row => columns.every(column => column.runs.get(row)?.courts.length === 0);
    for (let row = 0; row < times.length - 1;) {
      const empty = emptyAt(row);
      let end = row + 1;
      if (empty) while (end < times.length - 1 && emptyAt(end)) end++;
      rows.push({ start: row, end, empty });
      row = end;
    }
    return { times, columns, rows };
  }

  // Also load these pure date/filter functions in Node's built-in test runner.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { pacificClock, nextDates, visibleSlots, validateSnapshot, buildTimeline };
    return;
  }

  const app = document.getElementById("tennis-app");
  if (!app) return;
  const byId = id => document.getElementById(id);
  const bookingUrl = byId("booking-link").href;
  let snapshot = null;
  let loading = false;
  let lastAttempt = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(text, url) {
    const node = element("a", "", text);
    node.href = url;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function offer(data) {
    validateSnapshot(data);
    if (snapshot && Date.parse(snapshot.generated_at) >= Date.parse(data.generated_at)) return;
    snapshot = data;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) { /* Cache is optional. */ }
    render();
  }

  function timetable(parks, date, clock) {
    const { times, columns, rows } = buildTimeline(parks, date, clock);
    const scroll = element("div", "table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", `${date} availability; scroll horizontally on small screens`);
    const table = element("table", "schedule");
    table.append(element("caption", "", "Available courts · numbers identify individual courts"));
    const colgroup = element("colgroup");
    for (let i = 0; i <= columns.length; i++) colgroup.append(element("col"));
    const thead = element("thead");
    const header = element("tr");
    for (const name of ["Time", ...columns.map(column => column.park.replace(/^Berkeley /, "").replace(/ Park$/, ""))]) {
      const th = element("th", "", name);
      th.scope = "col";
      header.append(th);
    }
    thead.append(header);
    const tbody = element("tbody");
    for (const interval of rows) {
      const row = interval.start;
      const timeRange = `${formatTime(times[row])}–${formatTime(times[interval.end])}`;
      if (interval.empty) {
        const gap = element("tr", "time-gap");
        const label = element("th", "", `${timeRange} · No availability`);
        label.colSpan = columns.length + 1;
        gap.append(label);
        tbody.append(gap);
        continue;
      }
      const tr = element("tr", times[row] % 60 === 0 ? "hour" : "");
      const time = element("th", "", timeRange);
      time.scope = "row";
      tr.append(time);
      for (const column of columns) {
        const run = column.runs.get(row);
        if (!run) continue; // Covered by an earlier rowspan.
        const cell = element("td", run.courts.length ? "available" : "");
        cell.rowSpan = run.rowSpan;
        if (run.courts.length) {
          const window = `${formatTime(run.start)}–${formatTime(run.end)}`;
          const numbers = run.courts.map(court => court.match(/#(\d+)/)?.[1] || "Court").join(",");
          const booking = link("", bookingUrl);
          booking.setAttribute("aria-label", `${date}, ${column.park}, ${window}, ${run.courts.join(", ")}. Open CivicRec to book.`);
          booking.title = `${date} · ${column.park} · ${window} · ${run.courts.join(", ")}`;
          booking.append(element("span", "court-numbers", numbers === "Court" ? "Court" : `#${numbers}`));
          cell.append(booking);
        }
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(colgroup, thead, tbody);
    scroll.append(table);
    return scroll;
  }

  function render() {
    const clock = pacificClock();
    const dates = nextDates(clock.date);
    const results = byId("results");
    // Keep scroll positions when an open page updates.
    const positions = [...results.querySelectorAll(".table-scroll")].map(node => node.scrollLeft);
    results.replaceChildren();
    results.setAttribute("aria-busy", String(loading && !snapshot));
    const notices = [];
    if (!snapshot) {
      byId("updated").textContent = loading ? "Loading availability…" : "Availability could not be loaded. Please check CivicRec.";
    } else {
      const updated = new Date(snapshot.generated_at);
      const age = Math.max(0, Math.floor((Date.now() - updated.getTime()) / 60000));
      byId("updated").textContent = `Last checked ${new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(updated)}.`;
      if (age > 240) notices.push("This snapshot is over 4 hours old. Check CivicRec for current availability.");
    }
    for (const [index, date] of dates.entries()) {
      const section = element("section", "day-section");
      const formatted = new Intl.DateTimeFormat("en-US", {
        weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
      }).format(new Date(`${date}T12:00:00Z`));
      section.append(element("h2", "", `${["Today", "Tomorrow", "Day after tomorrow"][index]} · ${formatted}`));
      const parks = snapshot?.dates[date];
      if (parks) {
        section.append(timetable(parks, date, clock));
      } else {
        section.append(element("p", "muted", loading && !snapshot ? "Loading…" : "Awaiting the next successful update. Check CivicRec for this date."));
      }
      results.append(section);
      const scroll = section.querySelector(".table-scroll");
      if (scroll) scroll.scrollLeft = positions[index] || 0;
    }
    byId("notice").hidden = !notices.length;
    byId("notice").textContent = notices.join(" ");
  }

  async function getJSON(url, fresh = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { cache: fresh ? "no-store" : "default", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function reload(initial = false) {
    if (loading) return;
    loading = true;
    lastAttempt = Date.now();
    render();
    const seed = initial ? getJSON(app.dataset.initialUrl).then(offer).catch(() => {}) : Promise.resolve();
    try {
      const data = validateSnapshot(await getJSON(app.dataset.snapshotUrl, true));
      offer(data);
    } catch (_) { /* Keep showing the last successful snapshot and its check time. */ }
    await seed;
    loading = false;
    render();
  }

  async function setupMap() {
    try {
      const locations = await getJSON(app.dataset.locationsUrl);
      const mapKey = byId("map-key");
      for (const [index, place] of locations.entries()) {
        const url = `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}`;
        mapKey.append(link(`${place.campus ? "Cal" : index + 1}. ${place.name}`, url));
      }
      const draw = async () => {
        try {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
            script.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
            script.crossOrigin = "anonymous";
            script.onload = resolve;
            script.onerror = reject;
            document.head.append(script);
          });
          const L = window.L;
          byId("map").replaceChildren();
          const map = L.map("map", { scrollWheelZoom: false });
          L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          }).on("tileerror", () => { byId("map-notice").hidden = false; }).addTo(map);
          for (const [index, place] of locations.entries()) {
            const popup = element("div");
            popup.append(element("strong", "", place.name), element("br"), link("View location ↗", `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}`));
            L.marker([place.lat, place.lon], {
              title: place.name,
              icon: L.divIcon({ className: `map-marker${place.campus ? " campus" : ""}`, html: place.campus ? "Cal" : String(index + 1), iconSize: [28, 28], iconAnchor: [14, 14] }),
            }).addTo(map).bindTooltip(place.name, { permanent: true, direction: "top", offset: [0, -12], className: "map-label" }).bindPopup(popup);
          }
          map.fitBounds(locations.map(place => [place.lat, place.lon]), { padding: [35, 40] });
        } catch (_) {
          byId("map").replaceChildren(element("p", "muted", "Use the location links below to view the parks and campus."));
          byId("map-notice").hidden = false;
        }
      };
      // Load map tiles only when the map approaches the viewport.
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); draw(); }
        }, { rootMargin: "200px" });
        observer.observe(byId("map"));
      } else { draw(); }
    } catch (_) {
      byId("map").replaceChildren(element("p", "muted", "Locations could not be loaded."));
      byId("map-notice").hidden = false;
    }
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) offer(JSON.parse(cached));
  } catch (_) { /* A corrupt cache must not prevent a fresh request. */ }
  reload(true);
  setupMap();
  setInterval(() => {
    if (Date.now() - lastAttempt >= 15 * 60000) reload();
    else render();
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (Date.now() - lastAttempt > 5 * 60000) reload();
      else render();
    }
  });
})();

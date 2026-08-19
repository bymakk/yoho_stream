/**
 * Site content-script - runs on yoho.pw / reyoho.ru
 * Detects the current film, fetches content warnings, and
 * sends them to the background service worker.
 */

(function () {
  "use strict";

  const YOHO_ORIGINS = ["https://yoho.pw", "https://reyoho.ru", "https://reyoho.com"];
  const API_BASE = window.location.origin; // same-origin fetch
  const REFRESH_MIN_INTERVAL_MS = 30_000;
  const BEACON_DEBOUNCE_MS = 120; // coalesce beacon mutations before re-parsing
  const REFRESH_DEBOUNCE_MS = 150; // coalesce focus/visibility refresh triggers
  const NAV_SETTLE_MS = 300; // wait for SPA route content to render after nav

  let currentFilmKey = null;
  let currentMetaSig = null;
  let fetchAbortController = null;
  let filmFetchSeq = 0;
  let lastFilmPathId = null;
  let lastRefreshAt = 0;
  let beaconDebounceTimer = null;
  let refreshDebounceTimer = null;
  let beaconObserver = null;
  let siteActive = false;

  // ── Safe message send ────────────────────────────────────────────────────────
  function safeMessage(msg) {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage(msg);
    } catch {
      // "Extension context invalidated" - extension was reloaded, ignore.
    }
  }

  // ── Film detection ──────────────────────────────────────────────────────────
  function getFilmBeacon() {
    return document.querySelector("[data-yoho-film]");
  }

  function parseFilmFromBeacon() {
    const beacon = getFilmBeacon();
    if (!beacon) return null;
    const kp = beacon.dataset.kp?.trim() || null;
    const tmdb = beacon.dataset.tmdb?.trim() || null;
    const mediaType = beacon.dataset.mediaType?.trim() || "movie";
    const title = beacon.dataset.title?.trim() || null;
    const year = beacon.dataset.year?.trim() || null;
    if (!kp && !tmdb) return null;
    return { kp, tmdb: tmdb ? Number(tmdb) : null, mediaType, title, year };
  }

  function filmKey(meta) {
    if (!meta) return null;
    return meta.kp ? `kp:${meta.kp}` : `tmdb:${meta.tmdb}:${meta.mediaType}`;
  }

  /** Stable id of the current film PAGE from the URL, ignoring season/episode
   *  sub-paths (e.g. "series/749374"). Used to detect a TITLE change on SPA nav
   *  before the beacon/player updates, so the overlay can clear immediately. */
  function filmPathId() {
    const m = location.pathname.match(
      /^\/(film|series|movie|tv|anime|cartoon|show)\/([^/?#]+)/i,
    );
    return m ? `${m[1].toLowerCase()}/${m[2]}` : null;
  }

  /** Identity of the API-relevant metadata - changes here must trigger a refetch
   *  even when filmKey is unchanged (title/year/mediaType feed the query). */
  function metaSignature(meta) {
    if (!meta) return null;
    return `${meta.title ?? ""}|${meta.year ?? ""}|${meta.mediaType ?? ""}`;
  }

  // ── Fetch warnings ──────────────────────────────────────────────────────────
  /** @returns {Promise<{ok: boolean, warnings: any[]}>} ok=false on network/HTTP
   *  failure so callers don't confuse a failed request with "no warnings". */
  async function fetchWarnings(meta, signal) {
    const q = new URLSearchParams();
    if (meta.kp && /^\d+$/.test(meta.kp)) {
      q.set("kinopoiskId", meta.kp);
    } else if (meta.tmdb) {
      q.set("tmdbId", String(meta.tmdb));
    } else {
      return { ok: true, warnings: [] };
    }
    q.set("mediaType", meta.mediaType);
    if (meta.title) q.set("title", meta.title);
    if (meta.year) q.set("year", meta.year);

    try {
      const res = await fetch(`${API_BASE}/api/content-warnings?${q}`, {
        signal,
        credentials: "same-origin",
      });
      // 404 = film genuinely not in the warnings DB: a definitive "no warnings",
      // not a transient failure. Treat as an empty success so the throttle clock
      // advances (otherwise every OBS↔browser focus re-fetches a fresh 404). A 5xx
      // or network error stays ok:false and remains immediately retryable.
      if (res.status === 404) return { ok: true, warnings: [] };
      if (!res.ok) return { ok: false, warnings: [] };
      const doc = await res.json();
      return { ok: true, warnings: Array.isArray(doc.warnings) ? doc.warnings : [] };
    } catch {
      // Network error or aborted request - not the same as "no warnings".
      return { ok: false, warnings: [] };
    }
  }

  // ── Film changed ────────────────────────────────────────────────────────────
  async function onFilmChanged() {
    const meta = parseFilmFromBeacon();
    const key = filmKey(meta);
    const sig = metaSignature(meta);

    if (key === currentFilmKey && sig === currentMetaSig) return;

    if (fetchAbortController) fetchAbortController.abort();

    if (!meta) {
      currentFilmKey = null;
      currentMetaSig = null;
      stopRuntimeReporting();
      safeMessage({ type: "film-clear" });
      return;
    }

    startRuntimeReporting();
    fetchAbortController = new AbortController();
    const seq = ++filmFetchSeq;
    const keyChanged = key !== currentFilmKey;
    const result = await fetchWarnings(meta, fetchAbortController.signal);
    if (seq !== filmFetchSeq) return; // superseded by a newer request
    // On failure, leave currentFilmKey unchanged so a later nav/focus/observer
    // trigger retries instead of caching a wrong "no warnings" state.
    // Exception: when the film page changed, do not keep the previous film's warnings.
    if (!result.ok) {
      if (keyChanged) {
        currentFilmKey = key;
        currentMetaSig = sig;
        safeMessage({
          type: "film-update",
          filmKey: key,
          filmMeta: meta,
          warnings: [],
          seq,
        });
      }
      return;
    }

    currentFilmKey = key;
    currentMetaSig = sig;
    safeMessage({
      type: "film-update",
      filmKey: key,
      filmMeta: meta,
      warnings: result.warnings,
      seq,
    });
  }

  async function refreshCurrentFilmWarnings(force = false) {
    const now = Date.now();
    if (!force && now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;

    const meta = parseFilmFromBeacon();
    const key = filmKey(meta);
    if (!meta || !key || key !== currentFilmKey) return;

    if (fetchAbortController) fetchAbortController.abort();
    fetchAbortController = new AbortController();
    const seq = ++filmFetchSeq;
    const result = await fetchWarnings(meta, fetchAbortController.signal);
    if (seq !== filmFetchSeq) return;
    // Advance the throttle clock only on success - a failed refresh should be
    // retryable immediately rather than blocked for the full interval.
    if (!result.ok) return;
    lastRefreshAt = now;

    safeMessage({
      type: "film-update",
      filmKey: key,
      filmMeta: meta,
      warnings: result.warnings,
      seq,
    });
  }

  async function getAuthSession() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/get-session`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { loggedIn: false };
      const data = await res.json();
      return { loggedIn: !!data?.user?.id };
    } catch {
      return { loggedIn: false };
    }
  }

  async function voteTimingFromExtension(payload) {
    const communityId =
      typeof payload.communityId === "string" ? payload.communityId.trim() : "";
    const value = payload.value;
    if (!communityId || (value !== -1 && value !== 0 && value !== 1)) {
      return { ok: false, error: "invalid_request" };
    }
    const currentTimeSec =
      typeof payload.currentTimeSec === "number" && Number.isFinite(payload.currentTimeSec)
        ? payload.currentTimeSec
        : null;
    if (currentTimeSec == null) {
      return { ok: false, error: "no_playback_position" };
    }

    const bodyBase = {
      communityId,
      currentTimeSec,
      season: Number.isInteger(payload.season) ? payload.season : null,
      episode: Number.isInteger(payload.episode) ? payload.episode : null,
      blurStartOffset:
        typeof payload.blurStartOffset === "number" ? payload.blurStartOffset : 0,
      blurEndOffset:
        typeof payload.blurEndOffset === "number" ? payload.blurEndOffset : 0,
      leadSec: typeof payload.leadSec === "number" ? payload.leadSec : 20,
    };

    try {
      const challengeRes = await fetch(`${API_BASE}/api/content-warnings/vote-challenge`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyBase),
      });
      const challengeBody = await challengeRes.json().catch(() => null);
      if (!challengeRes.ok) {
        return {
          ok: false,
          error:
            (challengeBody && challengeBody.error) ||
            `challenge_failed_${challengeRes.status}`,
        };
      }

      const voteRes = await fetch(
        `${API_BASE}/api/content-warnings/community/${encodeURIComponent(communityId)}/vote-player`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Yoho-Timestamp": String(challengeBody.timestamp),
            "X-Yoho-Signature": String(challengeBody.signature),
          },
          body: JSON.stringify({
            value,
            challengeId: challengeBody.challengeId,
            currentTimeSec,
            blurStartOffset: bodyBase.blurStartOffset,
            blurEndOffset: bodyBase.blurEndOffset,
            leadSec: bodyBase.leadSec,
          }),
        },
      );
      const voteBody = await voteRes.json().catch(() => null);
      if (!voteRes.ok) {
        return {
          ok: false,
          error: (voteBody && voteBody.error) || `vote_failed_${voteRes.status}`,
        };
      }

      await refreshCurrentFilmWarnings(true);

      return {
        ok: true,
        communityId,
        score: voteBody.score,
        votedByMe: voteBody.votedByMe,
      };
    } catch {
      return { ok: false, error: "network_error" };
    }
  }

  // ── Отчёт о длительности склейки (карта склеек) ──────────────────────────────
  // Пассивно сообщаем, какая длительность у этого тайтла на выбранном плеере и
  // озвучке. По этой карте на сервере добиваются тайминги без плеера. Дедуп по
  // (фильм, S/E, плеер, озвучка) в пределах сессии: смена озвучки/серии — новый
  // кортеж и новый отчёт, повтор того же — молчим. installId — идентификатор
  // УСТАНОВКИ (не человека): аноним даёт им только «такая склейка существует»,
  // голос в однозначности сервер считает по залогиненной сессии, не по нему.
  let runtimeInstallId = null;
  const runtimeReported = new Set();
  let runtimeTimer = null;

  function ensureRuntimeInstallId(cb) {
    if (runtimeInstallId) {
      cb(runtimeInstallId);
      return;
    }
    try {
      chrome.storage.local.get("runtimeInstallId", (res) => {
        void chrome.runtime.lastError;
        let id = res?.runtimeInstallId;
        if (!id) {
          id =
            crypto?.randomUUID?.() ||
            `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          try {
            chrome.storage.local.set({ runtimeInstallId: id });
          } catch {
            /* storage недоступен — отчёт просто не уйдёт */
          }
        }
        runtimeInstallId = id;
        cb(id);
      });
    } catch {
      cb(null);
    }
  }

  function getPlaybackStateForReport() {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage({ type: "get-state" }, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp?.state ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function reportRuntimeOnce() {
    if (document.hidden) return;
    const meta = parseFilmFromBeacon();
    const kp = meta?.kp && /^\d+$/.test(meta.kp) ? Number(meta.kp) : null;
    if (kp == null) return; // карта по kinopoiskId; без него отчитываться нечем
    const state = await getPlaybackStateForReport();
    const pb = state?.playback ?? null;
    const player = state?.playerName ?? null;
    const durationSec = pb?.durationSec ?? null;
    // Плеер ещё не готов: длительность приходит через секунды после загрузки.
    if (!player || typeof durationSec !== "number" || durationSec <= 0) return;
    // Фильм не имеет сезона/серии — плеер иногда показывает мусорный «сезон»
    // (Alloha на фильме отдавал season=2). Отправляем S/E только для сериалов.
    const isSeries = meta.mediaType === "tv";
    const season = isSeries && Number.isInteger(pb?.season) ? pb.season : null;
    const episode = isSeries && Number.isInteger(pb?.episode) ? pb.episode : null;
    const dubName = typeof pb?.translation === "string" ? pb.translation : "";
    const dedupKey = `${kp}|${meta.mediaType}|${season}|${episode}|${player}|${dubName}`;
    if (runtimeReported.has(dedupKey)) return; // этот кортеж уже отчитан в сессии
    runtimeReported.add(dedupKey);
    ensureRuntimeInstallId((installId) => {
      if (!installId) {
        runtimeReported.delete(dedupKey); // не смогли — дадим повтору шанс
        return;
      }
      try {
        // Плеер шлёт СЫРОЕ имя (playerName): нормализацию к источнику и проверку
        // по белому списку делает сервер (sourceFromExtensionPlayer). Длительность
        // тоже сырая — сведение склеек по допуску на сервере, не здесь.
        fetch(`${API_BASE}/api/title-runtime`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kinopoiskId: kp,
            mediaType: meta.mediaType,
            season,
            episode,
            player,
            dubName,
            durationSec: Math.round(durationSec),
            installId,
          }),
          keepalive: true,
        }).catch(() => {
          /* 503 без соли / сеть моргнула — молчим, повтор на след. смене кортежа */
        });
      } catch {
        /* noop */
      }
    });
  }

  function startRuntimeReporting() {
    if (runtimeTimer) return;
    void reportRuntimeOnce();
    // Каждые 6с: ловит и оседание длительности после загрузки, и смену
    // озвучки/серии. reportRuntimeOnce идемпотентна по кортежу — POST уходит
    // только на новый (плеер, озвучка), не каждый тик.
    runtimeTimer = setInterval(() => {
      void reportRuntimeOnce();
    }, 6000);
  }

  function stopRuntimeReporting() {
    if (runtimeTimer) clearInterval(runtimeTimer);
    runtimeTimer = null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "site-get-auth-session") {
      void getAuthSession().then((r) => sendResponse(r));
      return true;
    }
    if (message.type === "site-vote-timing") {
      void voteTimingFromExtension(message).then((r) => sendResponse(r));
      return true;
    }
    if (message.type === "site-refresh-warnings") {
      void refreshCurrentFilmWarnings(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  function scheduleRefreshCurrentFilmWarnings() {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      void refreshCurrentFilmWarnings();
    }, REFRESH_DEBOUNCE_MS);
  }

  // ── SPA navigation detection ─────────────────────────────────────────────────
  function patchHistory() {
    if (window.__yohoHistoryPatched) return;
    window.__yohoHistoryPatched = true;
    const wrap = (original) =>
      function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("yoho-nav"));
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("yoho-nav"))
    );
  }

  // ── MutationObserver for beacon ──────────────────────────────────────────────
  function watchBeacon() {
    if (beaconObserver) return;
    beaconObserver = new MutationObserver((records) => {
      // Skip text-only / no-op mutations from the busy SPA: only element
      // insertions/removals or the watched beacon attributes can change identity.
      let relevant = false;
      for (const r of records) {
        if (r.type === "attributes") { relevant = true; break; }
        if (r.type === "childList" && (r.addedNodes.length || r.removedNodes.length)) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
      clearTimeout(beaconDebounceTimer);
      beaconDebounceTimer = setTimeout(onFilmChanged, BEACON_DEBOUNCE_MS);
    });
    beaconObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-yoho-film",
        "data-kp",
        "data-tmdb",
        "data-media-type",
        "data-title",
        "data-year",
      ],
    });
  }

  function teardownSite(event) {
    if (event?.persisted) {
      clearTimeout(beaconDebounceTimer);
      clearTimeout(refreshDebounceTimer);
      beaconDebounceTimer = null;
      refreshDebounceTimer = null;
      return;
    }
    siteActive = false;
    stopRuntimeReporting();
    if (fetchAbortController) fetchAbortController.abort();
    clearTimeout(beaconDebounceTimer);
    clearTimeout(refreshDebounceTimer);
    beaconDebounceTimer = null;
    refreshDebounceTimer = null;
    beaconObserver?.disconnect();
    beaconObserver = null;
  }

  function restoreSiteAfterBfcache() {
    if (!siteActive) return;
    watchBeacon();
    void onFilmChanged();
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    if (window.__yohoSiteInit) return;
    if (!YOHO_ORIGINS.includes(window.location.origin)) return;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    window.__yohoSiteInit = true;
    siteActive = true;
    // New page session: SW filmUpdateSeqByTab must reset too (see tabs.onUpdated +
    // site-session-reset) or F5 rejects seq=1 and timings never reach the player.
    safeMessage({ type: "site-session-reset" });

    window.addEventListener("yoho-warning-vote", () => {
      void refreshCurrentFilmWarnings(true).then(() => {
        safeMessage({ type: "warning-vote-sync-from-site" });
      });
    });

    // Timing added/edited/deleted on the site → re-pull immediately so the
    // player markers/blur reflect the change in real time (the site dispatches
    // this event after a successful create/edit/delete).
    window.addEventListener("yoho-warnings-changed", () => {
      void refreshCurrentFilmWarnings(true);
    });

    patchHistory();
    watchBeacon();

    lastFilmPathId = filmPathId();
    window.addEventListener("yoho-nav", () => {
      const newPath = filmPathId();
      if (newPath !== lastFilmPathId) {
        lastFilmPathId = newPath;
        // Navigated to a DIFFERENT title (or off the film page entirely). Clear the
        // overlay NOW so it never keeps showing the previous film's name while the
        // new player loads. Same-film episode/season sub-navigation keeps the same
        // path id, so it does NOT clear (no flash on episode switch).
        if (currentFilmKey !== null) {
          currentFilmKey = null;
          currentMetaSig = null;
          if (fetchAbortController) fetchAbortController.abort();
          safeMessage({ type: "film-clear" });
        }
      }
      setTimeout(onFilmChanged, NAV_SETTLE_MS);
    });

    window.addEventListener("focus", scheduleRefreshCurrentFilmWarnings);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleRefreshCurrentFilmWarnings();
    });

    window.addEventListener("pagehide", teardownSite);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) restoreSiteAfterBfcache();
    });

    onFilmChanged();
  }

  init();
})();

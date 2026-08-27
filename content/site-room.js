/**
 * Совместный просмотр: ввод-вывод на странице сайта.
 *
 * Живёт в верхнем фрейме yoho.pw, потому что только отсюда запросы к
 * `/api/watch-room` идут same-origin с куками сессии. Плеер сидит в чужом
 * iframe, поэтому позиция приходит окольным путём: плеер → фон (`get-state`) →
 * сюда, а команды идут обратно тем же маршрутом (`room-seek`/`room-set-paused`).
 *
 * Решения не принимаем — за это отвечает чистый `content/room-sync.js`. Здесь
 * только: прочитать маячок, спросить позицию, отправить сердцебиение, применить
 * ответ.
 *
 * Задержка. Состояние комнаты приходит ПОТОКОМ (SSE): перемотка лидера долетает
 * до гостя за десятки миллисекунд, а не за такт опроса. Сердцебиение осталось,
 * но только чтобы публиковать СВОЮ позицию и держать себя «в сети», поэтому оно
 * редкое. Плюс фон будит нас сразу, как только плеер перемотали или поставили
 * на паузу (`room-playback-changed`) — тогда своя позиция уходит в комнату
 * немедленно, без ожидания такта.
 */
(function () {
  "use strict";

  const YOHO_ORIGINS = ["https://yoho.pw", "https://reyoho.ru", "https://reyoho.com"];
  if (!YOHO_ORIGINS.includes(window.location.origin)) return;
  if (window.__yohoSiteRoomInit) return;
  window.__yohoSiteRoomInit = true;

  const RS = globalThis.YohoRoomSync;

  /*
   * Объявляемся НЕМЕДЛЕННО, ещё до всяких запросов к фону.
   *
   * Признаков два, и их нельзя путать:
   *   data-yoho-ext      — расширение установлено и работает на этой странице;
   *   data-yoho-room-ext — оно ГОТОВО вести плеер (режим включён в настройках).
   *
   * Раньше был только второй, и он ставился после ответа фона. Пока ответ шёл,
   * сайт считал, что расширения нет вовсе, и успевал принять решение исходя из
   * этого — отсюда и метания плеера. Факт «расширение здесь» известен ровно в
   * момент внедрения скрипта, ждать его неоткуда и незачем.
   */
  try {
    document.documentElement.dataset.yohoExt = "1";
    document.documentElement.dataset.yohoExtVersion =
      chrome.runtime?.getManifest?.()?.version ?? "";
  } catch {
    /* документ ещё не готов — тогда ниже, в init */
  }

  /**
   * Рассказываем странице, что делаем.
   *
   * Эти строки попадают в историю действий и уезжают вместе с багрепортом.
   * Без них жалоба «плохо синхронизируется» приходит без единого следа: что
   * расширение перематывало, ставило ли паузу, отцеплялось ли от комнаты и
   * смогло ли вообще запустить плеер — приходилось гадать.
   */
  function tell(msg) {
    try {
      document.dispatchEvent(new CustomEvent("yoho:log", { detail: { msg } }));
    } catch {
      /* страница уходит — тогда и рассказывать некому */
    }
  }
  const API_BASE = window.location.origin;
  /** Маячок появляется не сразу (комнату создают кликом) — досматриваем DOM. */
  const BEACON_DEBOUNCE_MS = 150;
  /** Сигнал о рассинхроне не чаще этого — иначе он звучал бы каждый такт. */
  const DESYNC_NOTIFY_COOLDOWN_MS = 30_000;

  let room = null; // { id, role, itemId, me } из маячка
  let beatTimer = null;
  let stream = null;
  /** Последнее состояние комнаты (из потока или из ответа на сердцебиение). */
  let lastView = null;
  let nudgeTimer = null;
  /** Кеш настроек и позиции: срочный путь не должен ждать round-trip к фону. */
  let cachedSettings = null;
  let cachedPos = RS.ownState(null, false, null);
  /** Когда в последний раз просили плеер сменить озвучку — не чаще раза в 10с. */
  let lastTranslationAt = 0;
  const TRANSLATION_COOLDOWN_MS = 10_000;
  /**
   * Восстановление после перезагрузки.
   *
   * Свежая страница поднимает плеер на нуле. Если этот ноль опубликовать, у
   * ведущего он станет истиной и утянет всю комнату на начало фильма, а гостя
   * самого выбросит в начало. Поэтому: пока не восстановились, СВОЮ позицию не
   * публикуем, а сначала возвращаемся туда, где комната нас помнит.
   */
  /** Человек управляет плеером сам — комната молчит, пока не попросят. */
  let detached = false;
  let restored = false;
  let restoreDeadline = 0;
  const RESTORE_WINDOW_MS = 8_000;
  /** Последний отданный плееру темп — чтобы не слать одно и то же. */
  let lastRate = 1;
  /** Срочный такт, пришедший во время уже летящего запроса, — не теряем. */
  let beatAgain = false;
  let observer = null;
  let lastSeekAt = 0;
  let lastDesyncAt = 0;
  let inFlight = false;

  function safeMessage(msg, cb) {
    try {
      if (!chrome.runtime?.id) return;
      if (cb) chrome.runtime.sendMessage(msg, cb);
      else chrome.runtime.sendMessage(msg);
    } catch {
      /* контекст расширения перезагрузили */
    }
  }

  // ── Маячок ──────────────────────────────────────────────────────────────────
  function readBeacon() {
    const el = document.querySelector("[data-yoho-room]");
    if (!el) return null;
    const id = el.getAttribute("data-yoho-room")?.trim();
    const role = el.getAttribute("data-yoho-room-role")?.trim();
    const itemId = el.getAttribute("data-yoho-room-item")?.trim() || null;
    const me = el.getAttribute("data-yoho-room-me")?.trim() || null;
    if (!id || (role !== "host" && role !== "guest") || !me) return null;
    return { id, role, itemId, me };
  }

  function sameRoom(a, b) {
    return a?.id === b?.id && a?.role === b?.role && a?.me === b?.me;
  }

  function onBeaconChanged() {
    const next = readBeacon();
    if (sameRoom(next, room)) return;
    room = next;
    lastSeekAt = 0;
    restored = false;
    restoreDeadline = Date.now() + RESTORE_WINDOW_MS;
    if (!room) {
      stopBeat();
      safeMessage({ type: "room-clear" });
      return;
    }
    // Роль отдаёт сервер — расширение её не додумывает.
    safeMessage({ type: "room-update", room: { id: room.id, role: room.role } });
    startBeat();
  }

  // ── «Запрет-патруль»: поток состояния на страницу ───────────────────────────
  // Фон уже собирает и плеер, и озвучку, и серию, и длительность — не хватало
  // только вывода наружу. Отдельного тика в кадре плеера не заводим: состояние
  // и так доезжает до фона раз в секунду, здесь его достаточно забирать.
  let patrolTimer = null;

  function patrolPolling(on) {
    if (!on) {
      if (patrolTimer != null) clearInterval(patrolTimer);
      patrolTimer = null;
      return;
    }
    if (patrolTimer != null) return;
    const push = async () => {
      if (document.visibilityState !== "visible") return;
      const state = await getTabState();
      const pb = state?.playback ?? null;
      // Пустой опрос молчит. На странице патруля состояние вкладки наполняется
      // не сразу, а этот тик идёт раз в секунду — и затирал бы нулями то, что
      // плеер прислал вместе с ответом на команду.
      if (!pb && !state?.playerName) return;
      try {
        document.dispatchEvent(
          new CustomEvent("yoho:patrol-state", {
            detail: {
              state: {
                playerName: state?.playerName ?? null,
                translation: pb?.translation ?? null,
                season: pb?.season ?? null,
                episode: pb?.episode ?? null,
                currentTimeSec: pb?.currentTimeSec ?? null,
                durationSec: pb?.durationSec ?? null,
                paused: pb?.paused !== false,
              },
            },
          }),
        );
      } catch { /* страница уходит */ }
    };
    void push();
    patrolTimer = setInterval(push, 1000);
  }

  // ── Состояние из фона ───────────────────────────────────────────────────────
  function getTabState() {
    return new Promise((resolve) => {
      safeMessage({ type: "get-state" }, (resp) => {
        // lastError читаем, иначе Chrome ругается в консоль.
        void chrome.runtime.lastError;
        resolve(resp?.state ?? null);
      });
    });
  }

  // ── Обмен с комнатой ────────────────────────────────────────────────────────
  async function post(body) {
    const res = await fetch(`${API_BASE}/api/watch-room`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, view: res.ok ? await res.json() : null };
  }

  /** Правила комнаты держит лидер: расходятся с его настройками — досылаем. */
  function policyDiff(view, settings) {
    const want = {
      lockAhead: !!settings.lockAhead,
      waitForSlowest: !!settings.waitForSlowest,
      requireReady: !!settings.requireReady,
    };
    const have = view.policy ?? {};
    const diff = {};
    for (const k of Object.keys(want)) {
      if (have[k] !== want[k]) diff[k] = want[k];
    }
    return Object.keys(diff).length ? diff : null;
  }

  function notifyDesync(nowMs) {
    if (nowMs - lastDesyncAt < DESYNC_NOTIFY_COOLDOWN_MS) return;
    lastDesyncAt = nowMs;
    try {
      // Короткий тихий сигнал: отдельный звуковой файл ради одного «дзынь»
      // в пакет тащить незачем.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      setTimeout(() => void ctx.close().catch(() => {}), 400);
    } catch {
      /* автовоспроизведение может быть запрещено — не беда */
    }
  }

  async function beat(urgent = false) {
    if (!room) return;
    if (inFlight) {
      // Раньше срочный такт здесь молча терялся, и пауза ведущего ждала
      // СЛЕДУЮЩЕГО планового — те самые ~3 секунды. Теперь запоминаем и
      // повторяем сразу после текущего запроса.
      if (urgent) beatAgain = true;
      return;
    }
    inFlight = true;
    try {
      // Срочный путь берёт позицию из события фона и настройки из кеша —
      // лишний round-trip к service worker стоит десятков миллисекунд там,
      // где они и складываются в заметную задержку.
      const state = urgent && cachedSettings ? null : await getTabState();
      if (state) {
        cachedSettings = state?.settings?.together ?? null;
        cachedPos = RS.ownState(
          state?.playback?.currentTimeSec ?? null,
          state?.playback?.paused,
          state?.playback?.translation ?? null,
        );
      }
      const settings = cachedSettings;
      if (!settings?.enabled) return; // фича выключена — комнату не трогаем

      const positionSec = cachedPos.positionSec;
      const paused = cachedPos.paused;

      // Пока не восстановились — шлём null вместо позиции: пусть комната
      // помнит нашу прежнюю секунду, а не ноль свежезагруженного плеера.
      const publishPos = restored ? positionSec : null;
      // Запустил воспроизведение — значит готов смотреть. Отдельной кнопки для
      // этого не нужно: человек и так делает ровно то действие, которое эту
      // готовность подтверждает. Обратно в «не готов» не сваливаем — пауза
      // посреди фильма не отменяет согласия смотреть.
      const beatRes = await post(
        RS.heartbeatBody(room.id, publishPos, paused, paused ? undefined : true, detached),
      );
      if (!beatRes.view) {
        // 404 = комнаты больше нет; на 429/5xx просто пропускаем такт.
        if (beatRes.status === 404) {
          room = null;
          stopBeat();
          safeMessage({ type: "room-clear" });
        }
        return;
      }
      lastView = beatRes.view;
      applyRoomState(lastView, settings, positionSec, paused, 0);
    } catch {
      /* сеть моргнула — следующий такт повторит */
    } finally {
      inFlight = false;
      if (beatAgain) {
        beatAgain = false;
        void beat(true);
      }
    }
  }

  /** Свежее состояние комнаты → решение → команды плееру. */
  function applyRoomState(view, settings, positionSec, paused, frameAgeMs) {
    const decision = RS.decideRoomAction({
      room: view,
      myUserId: room?.me,
      settings,
      positionSec,
      paused,
      nowMs: Date.now(),
      lastSeekAt,
      frameAgeMs: frameAgeMs ?? 0,
    });
    applyDecision(decision, view, settings);
  }

  /**
   * Поток изменений комнаты. Именно он убирает задержку: сервер шлёт состояние
   * в момент события, а не по нашему запросу.
   */
  function openStream() {
    closeStream();
    if (!room) return;
    try {
      stream = new EventSource(
        `${API_BASE}/api/watch-room/stream?id=${encodeURIComponent(room.id)}`,
      );
    } catch {
      return; // без потока останется редкое сердцебиение — хуже, но работает
    }
    stream.onmessage = (e) => {
      let view;
      try {
        view = JSON.parse(e.data);
      } catch {
        return;
      }
      lastView = view;
      // Ни одного лишнего ожидания: настройки и позиция уже в кеше, а команда
      // плееру должна уйти в тот же момент, когда пришёл кадр потока.
      if (!cachedSettings?.enabled) return;
      const arrivedAt = Date.now();
      applyRoomState(
        view,
        cachedSettings,
        cachedPos.positionSec,
        cachedPos.paused,
        Date.now() - arrivedAt,
      );
    };
  }

  function closeStream() {
    try {
      stream?.close();
    } catch {
      /* уже закрыт */
    }
    stream = null;
  }

  function applyDecision(decision, view, settings) {
    // В ручном режиме не трогаем плеер вовсе: показываем состояние и ждём,
    // пока человек сам нажмёт «Синхронизировать».
    if (detached) {
      safeMessage({
        type: "room-laggards",
        laggards: settings.overlayEnabled ? decision.laggards : [],
      });
      return;
    }
    if (decision.seekToSec != null) {
      lastSeekAt = Date.now();
      tell(`перемотка на ${Math.round(decision.seekToSec)}с (${decision.reason})`);
      safeMessage({ type: "room-seek", timeSec: decision.seekToSec });
    }
    if (decision.setPaused != null) {
      tell(decision.setPaused ? `пауза (${decision.reason})` : `запуск (${decision.reason})`);
      safeMessage({ type: "room-set-paused", paused: decision.setPaused });
    }
    // Темп шлём только на изменение: команда каждый кадр потока дёргала бы
    // плеер и мешала ему держать буфер.
    if (decision.setRate != null && decision.setRate !== lastRate) {
      lastRate = decision.setRate;
      safeMessage({ type: "room-rate", rate: decision.setRate });
    }
    if (decision.desync) notifyDesync(Date.now());

    // Оверлей отставших рисует плеер — ему нужен только список.
    safeMessage({
      type: "room-laggards",
      laggards: settings.overlayEnabled ? decision.laggards : [],
    });

    restoreFromRoom(view);
    syncTranslation(view, settings);

    if (room?.role !== "host") return;

    const patch = {};
    if (decision.hold != null) patch.hold = decision.hold;
    if (decision.started != null) patch.started = decision.started;
    const policy = policyDiff(view, settings);
    if (policy) patch.policy = policy;
    if (Object.keys(patch).length) {
      void post({ action: "playback", id: room.id, ...patch }).catch(() => {});
    }
  }

  /**
   * Озвучка комнаты.
   *
   * Ведущий публикует НАЗВАНИЕ своей озвучки (глобальных id нет ни у Turbo, ни
   * у Collaps — общее только название в меню), гость просит плеер её выбрать.
   * Смена озвучки перезагружает поток, поэтому просим редко и только при
   * реальном расхождении: лишний клик тут стоит буферизации у человека.
   */
  function syncTranslation(view, settings) {
    const mine = cachedPos.translation;
    if (room?.role === "host") {
      if (mine && view.translationName !== mine) {
        void post({ action: "playback", id: room.id, translationName: mine }).catch(() => {});
      }
      return;
    }
    const t = Date.now();
    const ok = RS.shouldSwitchTranslation({
      role: room?.role,
      followPlayerChoice: settings.followPlayerChoice,
      want: view.translationName,
      mine,
      nowMs: t,
      lastAt: lastTranslationAt,
      cooldownMs: TRANSLATION_COOLDOWN_MS,
    });
    if (!ok) return;
    lastTranslationAt = t;
    tell(`просим озвучку «${view.translationName}»`);
    safeMessage({ type: "room-translation", name: view.translationName });
  }

  /**
   * Вернуть себя туда, где комната помнит нас до перезагрузки.
   *
   * Комната переживает F5 (членство сохраняется), а вместе с ним — последняя
   * известная позиция участника. Возвращаемся на неё один раз, после чего
   * начинаем публиковать свою позицию как обычно.
   */
  function restoreFromRoom(view) {
    if (restored || !room) return;
    const nowMs = Date.now();
    // Не нашли, куда возвращаться, — не держим публикацию вечно.
    if (nowMs > restoreDeadline) {
      restored = true;
      return;
    }
    const me = view.participants?.find((p) => p.userId === room.me);
    const target = me?.positionSec;
    const mine = cachedPos.positionSec;
    if (typeof target !== "number" || target <= 0) {
      // Комната нас не помнит — возвращаться некуда, и ЖДАТЬ НЕЧЕГО. Раньше мы
      // всё равно молчали до истечения окна, а значит первые двадцать секунд
      // ведущий не публиковал свою секунду вовсе. Гость в это время не получал
      // ни одной команды и просто стоял — ровно та задержка запуска, которую
      // было видно глазами.
      restored = true;
      return;
    }
    if (typeof mine !== "number") return; // плеер ещё не отчитался — подождём

    // Уже примерно там (обычная перезагрузка успела восстановить время) —
    // просто снимаем блокировку публикации.
    if (Math.abs(mine - target) <= 3) {
      restored = true;
      return;
    }
    restored = true;
    lastSeekAt = nowMs;
    safeMessage({ type: "room-seek", timeSec: target });
  }

  /**
   * Пометка «плеер веду я».
   *
   * Сайт умеет синхронизировать Turbo сам, без расширения. Чтобы двое не тянули
   * один плеер в разные стороны, расширение объявляет себя прямо в DOM: оно
   * знает про плеер изнутри и потому главнее. Признак по отчётам в комнате для
   * этого не годится — он мигал бы, пока обе стороны шлют свои такты.
   */
  /**
   * Объявляемся сразу, а не с появлением комнаты.
   *
   * Раньше метка ставилась только когда комната уже есть, — и до первого
   * приглашения сайт считал, что расширения нет вовсе: помечал как пригодный
   * для совместного просмотра один Turbo, хотя с расширением работают все
   * плееры. Признак должен отвечать на вопрос «расширение здесь и готово вести
   * плеер», а он не зависит от того, позвал ли уже кто-то кого-то.
   */
  async function refreshExtensionMark() {
    try {
      const state = await getTabState();
      markExtensionDrives(!!state?.settings?.together?.enabled);
    } catch {
      /* фон не ответил — оставляем как было */
    }
  }

  function markExtensionDrives(on) {
    try {
      if (on) document.documentElement.dataset.yohoRoomExt = "1";
      else delete document.documentElement.dataset.yohoRoomExt;
    } catch { /* документ уже уехал */ }
  }

  function startBeat() {
    stopBeat();
    openStream();
    void beat();
    void getTabState().then((state) => {
      const ms = RS.reportIntervalMs(state?.settings?.together);
      beatTimer = setInterval(beat, ms);
    });
  }

  function stopBeat() {
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = null;
    closeStream();
    safeMessage({ type: "room-laggards", laggards: [] });
  }

  // ── Жизненный цикл ──────────────────────────────────────────────────────────
  let debounce = null;
  function watchBeacon() {
    if (observer) return;
    observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(onBeaconChanged, BEACON_DEBOUNCE_MS);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-yoho-room", "data-yoho-room-role", "data-yoho-room-item"],
    });
  }

  function teardown(event) {
    if (event?.persisted) return;
    stopBeat();
    patrolPolling(false);
    lastView = null;
    observer?.disconnect();
    observer = null;
    if (room) {
      room = null;
      safeMessage({ type: "room-clear" });
    }
  }

  /**
   * Плеер дёрнули (перемотка/пауза) — не ждём такта. Небольшая склейка: seek
   * часто приходит парой событий, а два запроса подряд комнате ни к чему.
   */
  function nudge() {
    if (!room || nudgeTimer) return;
    // 40мс вместо 120: склеить парные события seek достаточно, а каждая лишняя
    // сотня миллисекунд здесь — это отставание, которое видно глазами.
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void beat(true);
    }, 40);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "room-detached") {
      tell("человек взял управление — синхронизация отпущена");
      // Человек взял управление — перестаём его поправлять до явного запроса.
      detached = true;
      return false;
    }
    if (message?.type === "room-resync") {
      tell("возврат к синхронизации по кнопке");
      detached = false;
      lastSeekAt = 0;
      restored = true; // возвращаться к прежней позиции уже не надо
      void beat(true);
      return false;
    }
    if (message?.type === "patrol-reply") {
      try {
        document.dispatchEvent(
          new CustomEvent("yoho:patrol-reply", {
            detail: {
              requestId: message.requestId,
              ok: !!message.ok,
              reason: message.reason,
              state: message.state ?? null,
            },
          }),
        );
      } catch { /* страница уходит */ }
      return false;
    }
    if (message?.type === "room-seek-result" && message.ok === false) {
      // Перемотка не состоялась (турбо любит уйти в чёрный экран) — пишем в
      // консоль страницы: по этому следу и разбираем такие жалобы.
      try {
        // debug, а не warn: перемотка «не доехала» — обычный симптом капризного
        // плеера (Turbo/PJS роняет seek на буферизации), не критично. По ней
        // разбираем жалобы через verbose-консоль, но в обычную не сыплем.
        console.debug("[yoho] перемотка не удалась", message.target, "→", message.actual);
      } catch { /* noop */ }
      return false;
    }
    if (message?.type === "room-translation-result") {
      if (!message.ok) {
        try {
          console.warn(
            "[yoho] озвучка не переключилась:",
            message.reason,
            "хотели:",
            message.name,
            "плеер:",
            message.player,
            "варианты:",
            message.options,
          );
        } catch { /* noop */ }
      }
      // Плеер перестраивает поток — позиция сейчас уедет. Даём ему прийти в
      // себя, иначе регулятор увидит «отставание на минуты» и начнёт дёргать.
      lastSeekAt = Date.now() + 4000;
      if (!message.ok) lastTranslationAt = Date.now();
      return false;
    }
    // Настройки могут измениться на лету (человек включил режим в попапе), а
    // сайту важно знать об этом до того, как кого-то позвали. Раньше это был
    // слепой опрос раз в 10с — фон будили сообщением на КАЖДОЙ вкладке сайта
    // для КАЖДОГО посетителя всё время, пока вкладка открыта, хотя together
    // меняется только по одному действию: сохранение в попапе. Фон уже
    // рассылает `settings-update` во все кадры вкладки на каждое такое
    // сохранение (background.entry.js, settings-changed) — реагируем на него,
    // а не опрашиваем впустую.
    if (message?.type === "settings-update") {
      void refreshExtensionMark();
      return false;
    }
    if (message?.type === "room-playback-changed") {
      if (typeof message.currentTimeSec === "number") {
        // Озвучку переносим из прежнего кеша: раньше объект пересобирался без
        // неё, поле становилось undefined — и syncTranslation навсегда выходил
        // по «нечего сравнивать». Отсюда и «озвучки не переключаются».
        cachedPos = RS.ownState(message.currentTimeSec, message.paused, cachedPos.translation);
      }
      nudge();
    }
    return false;
  });

  function init() {
    if (!RS) return; // room-sync.js не загрузился — тихо ничего не делаем
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    try {
      document.documentElement.dataset.yohoExt = "1";
    } catch { /* документа нет — страница уже уходит */ }
    watchBeacon();
    onBeaconChanged();
    void refreshExtensionMark();

    // Переход по таймингу из комментария. Событие бросает сама страница —
    // канал наружу тут не нужен, сообщение не покидает вкладку. Комната для
    // этого не требуется: перематываем плеер напрямую.
    document.addEventListener("yoho:seek-to", (e) => {
      const sec = Number(e?.detail?.seconds);
      if (!Number.isFinite(sec) || sec < 0) return;
      safeMessage({ type: "seek-to", timeSec: sec });
    });

    // Отзеркаливание картинки плеера по кнопке на странице. Кадр плеера
    // кросс-доменный, поэтому команда идёт через фон, как seek-to.
    document.addEventListener("yoho:mirror", (e) => {
      safeMessage({ type: "mirror", on: !!e?.detail?.on });
    });

    // ── «Запрет-патруль» ────────────────────────────────────────────────────
    // Страница командует плеером и получает ОТВЕТ. Ответ здесь принципиален:
    // без него сайт не отличит «плеер не доехал» от «расширение отвалилось» и
    // запишет в базу мусор, ради вычистки которого патруль и заведён.
    document.addEventListener("yoho:patrol-cmd", (e) => {
      const d = e?.detail;
      if (!d || typeof d.requestId !== "string" || typeof d.cmd !== "string") return;
      if (d.cmd === "patrol-mode") patrolPolling(!!d.on);
      safeMessage({
        type: "patrol-cmd",
        requestId: d.requestId,
        cmd: d.cmd,
        on: d.on,
        seconds: d.seconds,
        fromSec: d.fromSec,
        durationSec: d.durationSec,
        loop: d.loop,
        restart: d.restart,
        season: d.season,
        episode: d.episode,
        name: d.name,
      });
    });
    window.addEventListener("pagehide", teardown);
  }

  init();
})();

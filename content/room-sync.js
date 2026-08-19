/**
 * Совместный просмотр: решение «что сделать с плеером».
 *
 * Модуль ЧИСТЫЙ и ничего не знает ни про DOM, ни про сеть: на вход — состояние
 * комнаты с сервера, свои настройки и своя позиция, на выход — что применить.
 * Так всё поведение (подмотка, пауза, «ждём отставших», готовность) проверяется
 * тестами без плеера и без комнаты, а site.js остаётся тонким слоем ввода-вывода.
 *
 * Роль ЗАДАЁТ СЕРВЕР: он один знает, кто создал комнату. Расширение роль не
 * угадывает и не хранит — иначе после переподключения она разъехалась бы с
 * реальностью.
 */
(function () {
  "use strict";

  /**
   * Пауза между подмотками. Без неё выходит петля: подмотали → отчитались новой
   * позицией → лидер за это время уехал дальше → снова подмотали. Три секунды
   * дают плееру дозагрузиться и отдать честную позицию.
   */
  const SEEK_COOLDOWN_MS = 3000;

  /**
   * До какого расхождения выбираемся СКОРОСТЬЮ, а не перемоткой.
   *
   * Перемотка — заметный рывок с подзагрузкой буфера, и на секунде-двух она
   * лечит хуже, чем болезнь. Небольшой перекос набегает сам собой (разный
   * буфер, разные плееры), и его честнее вытянуть незаметным изменением темпа:
   * ±5% на слух не ловится, а секунда разницы выбирается за двадцать секунд.
   */
  /**
   * Пороги подстройки. Числа не выдуманы — взяты из зрелых реализаций:
   *
   *   Syncplay (constants.py): SLOWDOWN_RATE 0.95, вход 1.5с, выход 0.1с
   *     (гистерезис 15:1), перемотка с упреждением FASTFORWARD_EXTRA_TIME 0.25с.
   *   Jellyfin SyncPlay (PlaybackCore.js): манёвр темпом ИМПУЛЬСНЫЙ — включили
   *     на фиксированное время, вернули 1.0, и на это время обратную связь
   *     ОТКЛЮЧИЛИ; решения не чаще раза в 1500мс.
   *
   * Главный вывод оттуда: непрерывный догоняющий регулятор качается. Нужен
   * импульс конечной длительности, мёртвая зона, гистерезис и лимит частоты.
   */
  /** Меньше этого не реагируем вовсе: это шум измерения, а не расхождение. */
  const DEADBAND_SEC = 0.15;
  /** С этого начинаем манёвр темпом. */
  const RATE_KICKIN_SEC = 0.4;
  /** Больше этого темпом не вытянуть — только перемотка. */
  const SEEK_SEC = 4;
  /** Считаем, что попали, и возвращаем обычный темп (гистерезис к KICKIN). */
  const RATE_RESET_SEC = 0.1;
  const RATE_STEP = 0.05;
  /** Границы длительности импульса. */
  const MANOEUVRE_MIN_MS = 1000;
  const MANOEUVRE_MAX_MS = 12_000;
  /** Не чаще одного решения — как в Jellyfin. */
  const DECISION_MIN_MS = 1500;
  /** Упреждение при перемотке: пока команда дойдёт, ведущий уедет. */
  const SEEK_LEAD_SEC = 0.25;

  /**
   * Насколько сильным должно быть расхождение, чтобы считать его аварией и
   * сообщить человеку (звук/подсветка), а не просто молча подмотать.
   */
  const DESYNC_FACTOR = 3;
  const DESYNC_MIN_SEC = 10;

  /** Пустое решение: ничего не делаем. */
  function idle(reason) {
    return {
      seekToSec: null,
      setRate: null,
      manoeuvreMs: null,
      driftSec: null,
      setPaused: null,
      hold: null,
      started: null,
      desync: false,
      laggards: [],
      reason,
    };
  }

  function onlineOthers(room, myUserId) {
    return room.participants.filter((p) => p.userId !== myUserId && p.online);
  }

  /** Участники, чьё расхождение с лидером больше допуска (для оверлея). */
  function laggardsOf(room, myUserId, toleranceSec) {
    return onlineOthers(room, myUserId)
      .filter((p) => p.driftSec != null && Math.abs(p.driftSec) > toleranceSec)
      .map((p) => ({
        userId: p.userId,
        name: p.name,
        driftSec: p.driftSec,
      }));
  }

  function hostOf(room) {
    return room.participants.find((p) => p.userId === room.hostId) ?? null;
  }

  /**
   * Где ведущий НАХОДИТСЯ СЕЙЧАС, а не где он был, когда отчитался.
   *
   * Между его отчётом и применением у гостя проходит дорога «плеер → фон →
   * страница → сервер → поток → плеер». Целиться в старую цифру — значит
   * гарантированно отставать на всю эту дорогу. Возраст снимка знает сам
   * сервер (`serverNow` − `positionAt`), а сколько кадр пролежал у нас,
   * докидывает вызывающий (`frameAgeMs`).
   */
  function hostPositionNow(room, host, frameAgeMs) {
    if (!host || host.positionSec == null) return null;
    if (host.paused) return host.positionSec;
    const serverAge = Math.max(0, (room.serverNow ?? host.positionAt) - host.positionAt);
    const localAge = Math.max(0, Number(frameAgeMs) || 0);
    return host.positionSec + (serverAge + localAge) / 1000;
  }

  /**
   * Своя позиция СЕЙЧАС. Замер приходит редко (плеер отчитывается не чаще раза
   * в секунду), поэтому между замерами доводим её сами — иначе решение
   * принимается по позиции возрастом до секунды и промахивается ровно на неё.
   */
  function ownPositionNow(args) {
    const { positionSec, positionAtMs, nowMs, paused, rate } = args;
    if (typeof positionSec !== "number") return null;
    if (paused || !positionAtMs) return positionSec;
    const ageMs = Math.max(0, nowMs - positionAtMs);
    // Слишком старый замер — не додумываем, лучше пропустить решение.
    if (ageMs > 1500) return null;
    return positionSec + (ageMs / 1000) * (typeof rate === "number" ? rate : 1);
  }

  /**
   * @param {object} input
   * @param {object|null} input.room       состояние комнаты (ответ сервера)
   * @param {string} input.myUserId
   * @param {object} input.settings        блок `together` из настроек
   * @param {number|null} input.positionSec своя позиция
   * @param {boolean} input.paused         своя пауза
   * @param {number} input.nowMs
   * @param {number} input.lastSeekAt      когда подматывали в прошлый раз
   * @param {number} [input.frameAgeMs]    сколько этот снимок пролежал у нас
   */
  function decideRoomAction(input) {
    const { room, myUserId, settings, positionSec, paused, nowMs, lastSeekAt } = input;

    if (!room || !settings || !settings.enabled) return idle("off");

    const me = room.participants.find((p) => p.userId === myUserId) ?? null;
    if (!me) return idle("not-in-room");

    const tolerance = Math.max(1, Number(settings.driftToleranceSec) || 3);
    const isHost = room.hostId === myUserId;
    const laggards = laggardsOf(room, myUserId, tolerance);

    // Расхождение считаем аварией не по любому «уехал на секунду», а по
    // заметному: иначе сигнал звучал бы весь фильм.
    const desyncSec = Math.max(tolerance * DESYNC_FACTOR, DESYNC_MIN_SEC);
    const desync =
      !!settings.notifyOnDesync &&
      laggards.some((l) => Math.abs(l.driftSec) >= desyncSec);

    if (isHost) return hostDecision({ room, settings, tolerance, laggards, desync, myUserId });

    return guestDecision({
      room,
      me,
      settings,
      tolerance,
      laggards,
      desync,
      positionSec,
      paused,
      nowMs,
      lastSeekAt,
      frameAgeMs: input.frameAgeMs,
      positionAtMs: input.positionAtMs,
      rate: input.rate,
      manoeuvreUntil: input.manoeuvreUntil,
      lastDecisionAt: input.lastDecisionAt,
      correcting: input.correcting,
    });
  }

  /**
   * Лидер собой не управляет — он источник истины. Его решения касаются комнаты:
   * поставить общую паузу «ждём отставшего» и отметить старт просмотра.
   */
  function hostDecision({ room, settings, tolerance, laggards, desync, myUserId }) {
    const out = idle("host");
    out.laggards = laggards;
    out.desync = desync;

    // Готовность: пока не все подтвердили, лидер стоит и держит комнату.
    if (settings.requireReady && !room.started) {
      const others = onlineOthers(room, myUserId);
      const allReady = others.length > 0 && others.every((p) => p.ready);
      if (!allReady) {
        out.setPaused = true;
        out.reason = "host-wait-ready";
        return out;
      }
      out.started = true;
      out.reason = "host-start";
      return out;
    }

    // Выключили «ждать отставших», а пауза висит — снимаем. Иначе настройку
    // выключили, а комната продолжает стоять, и отпустить её нечем.
    if (!settings.waitForSlowest && room.hold) {
      out.hold = false;
      out.reason = "host-hold-off";
      return out;
    }

    if (settings.waitForSlowest) {
      const someoneBehind = laggards.some((l) => l.driftSec > tolerance);
      if (someoneBehind && !room.hold) {
        out.hold = true;
        out.setPaused = true;
        out.reason = "host-hold-on";
        return out;
      }
      if (!someoneBehind && room.hold) {
        out.hold = false;
        out.reason = "host-hold-off";
        return out;
      }
    }

    // Общая пауза уже висит — лидер тоже стоит, пока сам её не снимет.
    if (room.hold) {
      out.setPaused = true;
      out.reason = "host-holding";
    }
    return out;
  }

  function guestDecision(args) {
    const { room, me, settings, tolerance, laggards, desync, paused, nowMs, lastSeekAt, frameAgeMs } =
      args;
    const out = idle("guest");
    out.laggards = laggards;
    out.desync = desync;

    const host = hostOf(room);

    // Ждём готовности всех — стоим независимо от личных настроек: это правило
    // комнаты, а не предпочтение гостя.
    if (room.policy?.requireReady && !room.started) {
      out.setPaused = true;
      out.reason = "wait-ready";
      return out;
    }

    // Общая пауза «ждём отставшего» — правило комнаты. Но стоять смирно нельзя:
    // раньше отставший тоже просто вставал, его отставание переставало
    // сокращаться, и ведущий никогда не снимал паузу — комната замерзала
    // насмерть. Поэтому под общей паузой мы ВСТАЁМ И ПОДТЯГИВАЕМСЯ к ведущему.
    if (room.hold) {
      out.setPaused = true;
      out.reason = "hold";
      const h = hostOf(room);
      const behind = h?.positionSec != null && me.driftSec != null ? me.driftSec : null;
      if (
        behind != null &&
        Math.abs(behind) > tolerance &&
        nowMs - lastSeekAt >= SEEK_COOLDOWN_MS
      ) {
        out.seekToSec = h.positionSec;
        out.reason = "hold-catchup";
      }
      return out;
    }

    if (!host || !host.online) {
      out.reason = "no-host";
      return out;
    }

    // Повторяем паузу лидера: если он остановился, гость не должен уезжать.
    // Делается ДО проверки позиции нарочно: запустить или встать можно, не зная
    // ни одной секунды. Пока это стояло ниже, гость с неизвестной позицией
    // ведущего не получал вообще ничего — и просто ждал, глядя в стоп-кадр.
    if (settings.followPause && host.paused !== paused) {
      out.setPaused = host.paused;
      out.reason = host.paused ? "follow-pause" : "follow-resume";
    }

    // Дальше идёт выравнивание по времени — вот для него секунда обязательна.
    if (host.positionSec == null) {
      if (out.setPaused == null) out.reason = "no-host-position";
      return out;
    }

    // Ведущий на паузе, а мы ещё играем — СНАЧАЛА встать, и ничего больше.
    // Иначе получалась петля: подмотали назад к застывшей позиции ведущего,
    // видео поехало дальше, снова подмотали — «включено и откидывает назад»
    // вместо простой паузы.
    if (host.paused && !paused) return out;

    // Цель — где ведущий СЕЙЧАС. Своя позиция берётся живой и доводится на
    // время, прошедшее с замера: сравнивать свежее с несвежим — и есть та
    // ошибка, из-за которой регулятор гонялся за несуществующим отставанием.
    const target = hostPositionNow(room, host, frameAgeMs);
    const mine = ownPositionNow(args);
    if (target == null || mine == null) {
      out.reason = out.reason === "guest" ? "no-drift" : out.reason;
      return out;
    }

    const drift = target - mine; // >0 — я отстаю
    out.driftSec = drift;

    const wantFollow = !!settings.autoFollow;
    const lockedAhead = !!room.policy?.lockAhead && drift < 0;
    if (!wantFollow && !lockedAhead) {
      out.reason = "drift-ignored";
      return out;
    }

    // Манёвр в ходу — обратную связь НЕ слушаем: именно попытка «уточнить»
    // решение прямо во время коррекции и раскачивает плеер.
    if (nowMs < (args.manoeuvreUntil ?? 0)) {
      out.reason = "manoeuvre";
      return out;
    }

    // Лимит частоты решений: без него в комнате на пятерых каждый чужой такт
    // порождал новое решение по тем же данным.
    if (nowMs - (args.lastDecisionAt ?? 0) < DECISION_MIN_MS) {
      out.reason = "too-soon";
      return out;
    }

    const a = Math.abs(drift);

    // Мёртвая зона + гистерезис: выходим из режима коррекции раньше, чем
    // входим, поэтому у границы нет дребезга.
    if (a < DEADBAND_SEC || (args.correcting && a < RATE_KICKIN_SEC && a > RATE_RESET_SEC)) {
      // Допуск в миллисекунду: 600.1 − 600 в двоичной арифметике даёт чуть
      // больше 0.1, и без него граница сброса не срабатывала бы ровно на ней.
      if (a <= RATE_RESET_SEC + 0.001) {
        out.setRate = 1;
        out.reason = "in-sync";
      } else {
        out.reason = "deadband";
      }
      return out;
    }

    if (a >= SEEK_SEC) {
      if (nowMs - lastSeekAt < SEEK_COOLDOWN_MS) {
        out.reason = "seek-cooldown";
        return out;
      }
      // С упреждением: пока команда дойдёт до плеера, ведущий уедет дальше.
      out.seekToSec = target + (host.paused ? 0 : SEEK_LEAD_SEC);
      out.setRate = 1;
      out.reason = lockedAhead && !wantFollow ? "lock-ahead" : "follow-drift";
      return out;
    }

    if (paused || host.paused) {
      // Стоим — темпом догонять нечего, а перемотка на паузе не слышна.
      if (nowMs - lastSeekAt >= SEEK_COOLDOWN_MS) {
        out.seekToSec = target;
        out.setRate = 1;
        out.reason = "align-paused";
      } else {
        out.reason = "seek-cooldown";
      }
      return out;
    }

    // Импульс темпом фиксированной длительности: за это время выбирается ровно
    // накопленное расхождение, после чего темп возвращается в 1.
    out.setRate = drift > 0 ? 1 + RATE_STEP : 1 - RATE_STEP;
    out.manoeuvreMs = Math.min(
      MANOEUVRE_MAX_MS,
      Math.max(MANOEUVRE_MIN_MS, Math.round((a / RATE_STEP) * 1000)),
    );
    out.reason = drift > 0 ? "rate-catchup" : "rate-slowdown";
    return out;
  }

  /** Тело сердцебиения: что расширение сообщает комнате о себе. */
  function heartbeatBody(roomId, positionSec, paused, ready, manual) {
    return {
      action: "heartbeat",
      id: roomId,
      ...(typeof manual === "boolean" ? { manual } : {}),
      positionSec:
        typeof positionSec === "number" && Number.isFinite(positionSec) && positionSec >= 0
          ? positionSec
          : null,
      positionSource: "extension",
      paused: !!paused,
      ...(typeof ready === "boolean" ? { ready } : {}),
    };
  }

  /** Как часто слать сердцебиение: настройка, зажатая в разумные границы. */
  function reportIntervalMs(settings) {
    const sec = Number(settings?.reportIntervalSec);
    if (!Number.isFinite(sec)) return 3000;
    return Math.min(15, Math.max(1, Math.round(sec))) * 1000;
  }

  /**
   * Своё состояние для решения — с одним правилом на все входы.
   *
   * Плеера может не быть вовсе: Collaps собирает <video> только после первого
   * запуска, и до этого позиции нет. Такое состояние — «стою», а НЕ «играю».
   * Пока правило жило только в одном из трёх мест, где обновляется кеш,
   * выходило «ведущий играет, и я играю»: расхождения нет, команда запуска не
   * формируется, и у гостя не происходило ровно ничего.
   */
  function ownState(positionSec, paused, translation) {
    const pos =
      typeof positionSec === "number" && Number.isFinite(positionSec) ? positionSec : null;
    return {
      positionSec: pos,
      paused: pos == null ? true : !!paused,
      translation: translation ?? null,
    };
  }

  const TRANSLATION_COOLDOWN_MS = 10_000;

  /**
   * Просить ли плеер сменить озвучку вслед за ведущим.
   *
   * Глобальных id у озвучек нет ни у Turbo, ни у Collaps — общее только
   * название в меню, поэтому сравниваем имена без регистра и пробелов. Смена
   * озвучки перезагружает поток, так что просим редко: лишний клик стоит
   * человеку буферизации.
   */
  function shouldSwitchTranslation(args) {
    const { role, followPlayerChoice, want, mine, nowMs, lastAt } = args ?? {};
    if (role === "host") return false;
    if (!followPlayerChoice) return false;
    if (!want || !mine) return false;
    const norm = (x) => String(x).trim().toLowerCase();
    if (norm(want) === norm(mine)) return false;
    const cooldown = args.cooldownMs ?? TRANSLATION_COOLDOWN_MS;
    if (nowMs - (lastAt ?? 0) < cooldown) return false;
    return true;
  }

  /**
   * За каким плеером идти гостю. Незнакомый источник игнорируем: чужая строка
   * не должна уводить страницу в несуществующий режим.
   */
  function shouldFollowSource(args) {
    const { role, roomSource, mySource, known } = args ?? {};
    if (role === "host") return null;
    if (!roomSource || roomSource === mySource) return null;
    if (Array.isArray(known) && !known.includes(roomSource)) return null;
    return roomSource;
  }

  /**
   * Человек взял управление на себя?
   *
   * Отцепляемся ТОЛЬКО когда он сделал обратное тому, чего хочет комната.
   * Совпал с ней — это не перехват: самый частый случай ровно такой, гость сам
   * нажимает play, потому что автозапуск не сработал, и разрывать из-за этого
   * синхронизацию нельзя.
   */
  function isManualOverride(args) {
    const { type, wantedSeekSec, currentTime, seekSlackSec = 5 } = args ?? {};
    // Только своя перемотка. Пауза и запуск отцеплять не должны: человек жмёт
    // их постоянно и обычно как раз чтобы присоединиться к комнате — гость,
    // нажавший play, подтверждает готовность, а не уходит в свободное плавание.
    // Комната сама вернёт его к состоянию ведущего. А вот перемотка создаёт
    // расхождение, которого комната не просила, — вот её и считаем перехватом.
    if (type !== "seeked") return false;
    if (wantedSeekSec == null) return false;
    if (typeof currentTime !== "number") return false;
    return Math.abs(currentTime - wantedSeekSec) > seekSlackSec;
  }

  const api = {
    decideRoomAction,
    ownState,
    shouldSwitchTranslation,
    shouldFollowSource,
    isManualOverride,
    TRANSLATION_COOLDOWN_MS,
    hostPositionNow,
    heartbeatBody,
    reportIntervalMs,
    laggardsOf,
    SEEK_COOLDOWN_MS,
    DEADBAND_SEC,
    RATE_KICKIN_SEC,
    RATE_RESET_SEC,
    SEEK_SEC,
    RATE_STEP,
    DECISION_MIN_MS,
    SEEK_LEAD_SEC,
    DESYNC_FACTOR,
    DESYNC_MIN_SEC,
  };

  globalThis.YohoRoomSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

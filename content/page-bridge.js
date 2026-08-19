/**
 * Мост в мир страницы плеера.
 *
 * Зачем отдельный файл и отдельный мир. Контент-скрипты расширения живут в
 * ИЗОЛИРОВАННОМ мире: глобалы страницы им не видны. У Alloha в кадре лежит
 * `window.player` (форк Plyr) со всем управлением, а у Turbo — `window.app`, но
 * из изолированного мира это undefined. Поэтому единственный доступный способ
 * нажать «play» был синтетический клик по кнопке — а её у Alloha (разметка
 * allplay__*) мы ещё и не находили. Итог: плеер молча стоял, а его лог
 * обрывался на «test ready».
 *
 * Здесь скрипт работает в мире страницы и умеет ровно три вещи: запустить,
 * остановить и перемотать через РОДНОЕ API плеера. Общение — CustomEvent на
 * document: это единственный канал, который пересекает границу миров.
 */
(() => {
  const REQ = "yoho:page-cmd";
  const RES = "yoho:page-reply";

  /**
   * Родное API плеера, если оно вообще есть на этой странице.
   *
   * Определяем по УМЕНИЯМ, а не по имени переменной. Playerjs (Turbo) кладёт
   * экземпляр и в `window.app`, и в `window.player`, но управляется он методом
   * `api("play")` — обычного `play()` у него нет вовсе. Прежняя проверка «есть
   * window.player → значит Plyr» уводила Turbo в ветку Alloha, где вызывался
   * несуществующий метод: мост отвечал «сделано», не сделав ничего, плеер
   * оставался стоять, а дальше по цепочке всплывала комнатная плашка
   * «Ведущий запустил» — на странице, где никакого ведущего нет.
   */
  function playerApi() {
    const w = window;
    for (const obj of [w.player, w.app]) {
      if (!obj || typeof obj !== "object") continue;
      if (typeof obj.api === "function") return { api: obj, kind: "playerjs" };
      if (typeof obj.play === "function") return { api: obj, kind: "plyr" };
    }
    return null;
  }

  /** Turbo (PJS/obrut) не кладёт инстанс в window, но с `?api=1` (его добавляет
   *  сайт) слушает postMessage `{api:...}` на СВОЁМ окне и рисует `<pjsdiv>`.
   *  Мы в этом же окне (MAIN-мир кадра), поэтому само-post доходит — проверено
   *  вживую: play/pause/seek выполняются, seek — через `set`, а не `seek`. */
  function isPjs() {
    return !!document.querySelector("pjsdiv");
  }
  function pjsPost(msg) {
    try { window.postMessage(msg, "*"); return true; } catch { return false; }
  }
  /** Сам <video> — общий и надёжный запасной путь (Collaps/Venom API не отдаёт).
   *  Берём играющий, иначе с данными, иначе первый. */
  function pickVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    return (
      vids.find((v) => !v.paused && !v.ended) ||
      vids.find((v) => v.readyState >= 2) ||
      vids[0] ||
      null
    );
  }

  function reply(id, ok, extra) {
    try {
      document.dispatchEvent(
        new CustomEvent(RES, { detail: { id, ok, ...(extra ?? {}) } }),
      );
    } catch {
      /* страница уходит */
    }
  }

  document.addEventListener(REQ, (event) => {
    const d = event?.detail;
    if (!d || typeof d.id !== "string") return;
    const found = playerApi();
    // PJS определяем только когда своего инстанса нет: у него window.player —
    // пустой объект, зато есть <pjsdiv> и postMessage-канал (api=1).
    const pjs = !found && isPjs();
    const video = pickVideo();

    if (d.cmd === "probe") {
      reply(d.id, !!(found || pjs || video), {
        kind: found?.kind ?? (pjs ? "pjs" : video ? "video" : null),
      });
      return;
    }

    try {
      if (d.cmd === "play") {
        if (found) {
          // Беззвучный запуск: политика автозапуска разрешает play() без жеста
          // ТОЛЬКО без звука. У Alloha (Plyr-форк) обычный play() без жеста
          // отклоняется, и её рекламный SDK обрывается на «test ready». Глушим и
          // сам <video> (надёжнее для политики), и плеер, ПЕРЕД play(). Звук
          // пользователь включит сам — для проверки таймингов он не нужен.
          if (d.muted) {
            try { if (video) video.muted = true; } catch { /* перехвачено */ }
            try { found.api.muted = true; } catch { /* у форка может не быть сеттера */ }
          }
          const r = found.kind === "playerjs" ? found.api.api("play") : found.api.play();
          // Автозапуск может отклонить промис — это не наша ошибка.
          if (r && typeof r.catch === "function") r.catch(() => {});
          reply(d.id, true, d.muted ? { muted: true } : undefined);
          return;
        }
        if (pjs) { pjsPost({ api: "play" }); reply(d.id, true); return; }
        if (video) {
          // Беззвучный play политикой автозапуска разрешён всегда.
          if (d.muted) video.muted = true;
          const r = video.play();
          if (r && typeof r.catch === "function") r.catch(() => {});
          reply(d.id, true, d.muted ? { muted: true } : undefined);
          return;
        }
        reply(d.id, false, { reason: "no_target" });
        return;
      }
      if (d.cmd === "pause") {
        if (found) { found.kind === "playerjs" ? found.api.api("pause") : found.api.pause?.(); reply(d.id, true); return; }
        if (pjs) { pjsPost({ api: "pause" }); reply(d.id, true); return; }
        if (video) { video.pause(); reply(d.id, true); return; }
        reply(d.id, false, { reason: "no_target" });
        return;
      }
      if (d.cmd === "seek") {
        const sec = Number(d.seconds);
        if (!Number.isFinite(sec) || sec < 0) {
          reply(d.id, false, { reason: "bad_seconds" });
          return;
        }
        // PJS: сырая запись video.currentTime морозит поток — только api-канал
        // (перемотка у Playerjs это `set`, а не `seek`).
        if (pjs) { pjsPost({ api: "seek", set: sec }); reply(d.id, true); return; }
        if (found?.kind === "playerjs") { found.api.api("seek", sec); reply(d.id, true); return; }
        if (video) { video.currentTime = sec; reply(d.id, true); return; }
        if (found?.kind === "plyr") { found.api.currentTime = sec; reply(d.id, true); return; }
        reply(d.id, false, { reason: "no_seek" });
        return;
      }
      reply(d.id, false, { reason: "unknown_cmd" });
    } catch (err) {
      reply(d.id, false, { reason: String(err?.message ?? err) });
    }
  });
})();

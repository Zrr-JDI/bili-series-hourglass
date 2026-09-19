/* B站合集时长进度 - content script
 * 在 B 站合集（多分P）播放页显示"合集总时长进度条"。
 * 数据源：window.__INITIAL_STATE__.videoData.pages[] 与 <video> 元素。
 * 支持用户通过 popup 自定义显示位置（合集列表头部/底部、播放器下方、顶部浮动、右下角浮动）。
 */
(function () {
  "use strict";

  var TAG = "[B站合集进度]";
  var ROOT_ID = "bili-cp-root";
  var RENDER_THROTTLE_MS = 500;

  var DEFAULT_CONFIG = {
    fixedPosition: false,     // true = 位置固定不可拖动；false = 可拖动
    orientation: "landscape", // landscape（横向）| portrait（竖向）
    showPercent: true,
    showTime: true,
    floatPos: null            // { left, top } 用户拖动后的位置；null = 默认右下角
  };

  // 全局状态
  var state = {
    config: null,             // 从 storage 加载的配置
    pages: [],                // [{cid, duration, part}]
    totalDuration: 0,         // 秒
    currentIndex: 0,          // 当前播放分P索引
    videoEl: null,
    podEl: null,              // 合集列表容器（用于识别当前 P，不作为注入宿主）
    rootEl: null,             // 注入的根节点
    currentPosition: null,    // 当前实际注入的位置标识（float_landscape / float_portrait）
    lastRenderTs: 0,
    renderQueued: false,
    videoObserver: null,
    podObserver: null,
    urlP: null,
    started: false,
    pagesLoaded: false,       // 是否成功加载 pages 数据
    heartbeatTimer: null,     // 1s 兜底定时器，确保 timeupdate 失效时进度条仍能更新
    dragDisable: null,        // enableDrag 返回的清理函数，切换布局时调用
    _lastDiagRatio: -1        // 上次诊断输出的 ratio，避免日志刷屏
  };

  // ---------- 工具函数 ----------

  function log() {
    var args = [TAG].concat([].slice.call(arguments));
    try { console.warn.apply(console, args); } catch (e) {}
  }

  function getInitialState() {
    try { return window.__INITIAL_STATE__ || null; } catch (e) { return null; }
  }

  function getVideoData() {
    var s = getInitialState();
    return s && s.videoData ? s.videoData : null;
  }

  function waitFor(condFn, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = null;
      function check() {
        try {
          if (condFn()) { cleanup(); resolve(true); return; }
        } catch (e) {}
        if (Date.now() - start >= timeoutMs) { cleanup(); resolve(false); return; }
        timer = setTimeout(check, 300);
      }
      function cleanup() { if (timer) { clearTimeout(timer); timer = null; } }
      check();
    });
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    if (h > 0) return pad(h) + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(DEFAULT_CONFIG, function (items) {
          var cfg = {};
          Object.keys(DEFAULT_CONFIG).forEach(function (k) {
            cfg[k] = (items[k] === undefined) ? DEFAULT_CONFIG[k] : items[k];
          });
          resolve(cfg);
        });
      } catch (e) {
        log("loadConfig 失败，使用默认配置", e);
        resolve(Object.assign({}, DEFAULT_CONFIG));
      }
    });
  }

  // ---------- 数据提取 ----------

  function loadPagesFromState() {
    var vd = getVideoData();
    if (!vd || !vd.pages || vd.pages.length === 0) return false;
    state.pages = vd.pages.map(function (p) {
      return { cid: p.cid, duration: p.duration || 0, part: p.part || "" };
    });
    state.totalDuration = vd.duration || state.pages.reduce(function (sum, p) {
      return sum + (p.duration || 0);
    }, 0);
    state.pagesLoaded = true;
    return true;
  }

  // 从 URL 提取 bvid：BV1xxxxxx（取 path 第一段）
  function getBvidFromUrl() {
    try {
      var m = location.pathname.match(/\/(BV[0-9A-Za-z]{10})/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  // 从 B 站 API 获取分P信息：https://api.bilibili.com/x/web-interface/view?bvid=xxx
  // 返回 Promise<boolean>，true 表示加载成功
  function loadPagesFromApi(bvid) {
    if (!bvid) return Promise.resolve(false);
    var url = "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid);
    log("尝试从 API 加载分P:", url);
    return fetch(url, { credentials: "include" })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json || json.code !== 0 || !json.data) {
          log("API 返回异常:", json && json.code, json && json.message);
          return false;
        }
        var data = json.data;
        if (!data.pages || data.pages.length === 0) {
          log("API 返回 pages 为空");
          return false;
        }
        state.pages = data.pages.map(function (p) {
          return {
            cid: p.cid,
            duration: p.duration || 0,
            part: p.part || ("P" + p.page)
          };
        });
        state.totalDuration = state.pages.reduce(function (sum, p) {
          return sum + (p.duration || 0);
        }, 0);
        state.pagesLoaded = true;
        log("API 加载成功，共", state.pages.length, "P，总时长", formatDuration(state.totalDuration));
        return true;
      })
      .catch(function (e) {
        log("API 请求失败:", e);
        return false;
      });
  }

  // 从 DOM 兜底读取分P cid 列表（无时长信息，但可用于识别当前 P）
  // 用于 __INITIAL_STATE__ 与 API 都失败时的最末兜底
  function loadPagesFromDom() {
    var pod = state.podEl || findPodContainer();
    if (!pod) return false;
    try {
      var items = pod.querySelectorAll(".video-pod__item, [data-key]");
      if (!items || items.length === 0) return false;
      var seen = {};
      var pages = [];
      for (var i = 0; i < items.length; i++) {
        var cid = items[i].getAttribute("data-key") || items[i].getAttribute("data-cid");
        if (!cid || seen[cid]) continue;
        seen[cid] = 1;
        pages.push({ cid: String(cid), duration: 0, part: "" });
      }
      if (pages.length === 0) return false;
      state.pages = pages;
      state.totalDuration = 0; // 未知
      state.pagesLoaded = true;
      log("DOM 兜底读取到", pages.length, "P（无时长信息，进度条将退化为集数进度）");
      return true;
    } catch (e) {
      log("loadPagesFromDom 失败:", e);
      return false;
    }
  }

  // 综合加载分P数据：state → API → DOM
  // 返回 Promise<boolean>
  function loadPagesAny() {
    // 1. 先试 __INITIAL_STATE__
    if (loadPagesFromState()) {
      log("从 __INITIAL_STATE__ 加载成功");
      return Promise.resolve(true);
    }
    log("__INITIAL_STATE__.videoData 不可用");
    // 2. 试 API
    var bvid = getBvidFromUrl();
    return loadPagesFromApi(bvid).then(function (ok) {
      if (ok) return true;
      // 3. 试 DOM 兜底
      if (loadPagesFromDom()) return true;
      log("所有数据源都失败");
      return false;
    });
  }

  // ---------- 当前分P 识别（多源） ----------

  function currentIndexFromDom() {
    if (!state.podEl) return -1;
    try {
      // 优先用 .video-pod__item.active
      var active = state.podEl.querySelector(".video-pod__item.active");
      if (!active) {
        // 备选：列表项中带选中态的其他选择器
        active = state.podEl.querySelector("[data-key].active, .list-item.active, .cur-list-item");
      }
      if (!active) return -1;
      var cid = active.getAttribute("data-key") || active.getAttribute("data-cid") || active.getAttribute("data-p");
      if (!cid) return -1;
      cid = String(cid);
      for (var i = 0; i < state.pages.length; i++) {
        if (String(state.pages[i].cid) === cid) return i;
      }
    } catch (e) {}
    return -1;
  }

  function currentIndexFromState() {
    var vd = getVideoData();
    if (!vd || !vd.cid) return -1;
    var cid = String(vd.cid);
    for (var i = 0; i < state.pages.length; i++) {
      if (String(state.pages[i].cid) === cid) return i;
    }
    return -1;
  }

  function refreshCurrentIndex() {
    var idx = currentIndexFromDom();
    if (idx < 0) idx = currentIndexFromState();
    if (idx < 0) {
      var p = getCurrentUrlP();
      if (p && p >= 1 && p <= state.pages.length) idx = p - 1;
    }
    if (idx >= 0 && idx < state.pages.length) {
      state.currentIndex = idx;
      return true;
    }
    return false;
  }

  function getCurrentUrlP() {
    try {
      var v = new URLSearchParams(location.search).get("p");
      v = parseInt(v, 10);
      return isNaN(v) ? null : v;
    } catch (e) { return null; }
  }

  // ---------- 容器查找（多策略） ----------

  // 查找合集列表容器，按多个候选选择器尝试
  function findPodContainer() {
    var selectors = [
      ".video-pod",
      ".video-pod__list",
      "[class*='video-pod']",
      ".multi-page",
      ".multipage",
      "#multi_page",
      "[class*='multi-page']",
      "[class*='selection']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) {
          log("findPodContainer 命中选择器:", selectors[i]);
          return el;
        }
      } catch (e) {}
    }
    return null;
  }

  // 查找播放器容器（仅用于诊断信息展示）
  function findPlayerContainer() {
    var selectors = [
      ".bpx-player-container",
      ".bpx-player-video-wrap",
      ".player-box",
      "#player_box",
      ".bilibili-player",
      "#bilibili-player",
      "[class*='bpx-player']",
      "[class*='player-wrap']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) {
          log("findPlayerContainer 命中选择器:", selectors[i]);
          return el;
        }
      } catch (e) {}
    }
    return null;
  }

  // ---------- UI 构建 ----------

  function buildRoot(orientation) {
    var root = document.createElement("div");
    root.className = "bili-cp bili-cp--float bili-cp--" + orientation;
    root.id = ROOT_ID;

    if (orientation === "portrait") {
      // 竖向布局：标题 / 百分比 / 时间（分子=当前时间，分母=总时长，横线分隔）
      root.innerHTML =
        '<div class="bili-cp__title">合集时长进度</div>' +
        '<div class="bili-cp__percent">0.0%</div>' +
        '<div class="bili-cp__time">' +
          '<div class="bili-cp__cur">00:00</div>' +
          '<div class="bili-cp__frac-line"></div>' +
          '<div class="bili-cp__total">00:00</div>' +
        '</div>';
    } else {
      // 横向布局（默认）：标题+百分比同行，时间一行
      var head = '<div class="bili-cp__head">' +
        '<span class="bili-cp__label">合集时长进度</span>' +
        '<span class="bili-cp__percent">0.0%</span>' +
      '</div>';
      var time = '<div class="bili-cp__time">' +
        '<span class="bili-cp__cur">00:00</span>' +
        '<span class="bili-cp__sep">/</span>' +
        '<span class="bili-cp__total">00:00</span>' +
      '</div>';
      root.innerHTML = head + time;
    }
    return root;
  }

  function applyDisplayOptions(root) {
    if (!root || !state.config) return;
    root.classList.toggle("bili-cp--no-percent", !state.config.showPercent);
    root.classList.toggle("bili-cp--no-time", !state.config.showTime);
  }

  // 应用浮动位置：优先用用户拖动后保存的 floatPos，否则用默认右下角
  function applyFloatPos(root) {
    if (!root) return;
    var fp = state.config && state.config.floatPos;
    if (fp && typeof fp.left === "number" && typeof fp.top === "number" &&
        !isNaN(fp.left) && !isNaN(fp.top)) {
      root.style.left = fp.left + "px";
      root.style.top = fp.top + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
    } else {
      // 默认右下角 16/16
      root.style.left = "auto";
      root.style.top = "auto";
      root.style.right = "16px";
      root.style.bottom = "16px";
    }
  }

  // 启用拖动：mousedown 开始记录，mousemove 移动，mouseup 保存位置
  function enableDrag(root) {
    if (!root) return;
    var dragging = false;
    var startMouseX = 0, startMouseY = 0;
    var startLeft = 0, startTop = 0;

    function onDown(e) {
      if (e.button !== 0) return; // 仅左键
      // 转为 left/top 定位（覆盖默认的 bottom/right）
      var rect = root.getBoundingClientRect();
      root.style.left = rect.left + "px";
      root.style.top = rect.top + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.classList.add("bili-cp--dragging");

      dragging = true;
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    function onMove(e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startMouseX);
      var newTop = startTop + (e.clientY - startMouseY);
      // 边界约束：保持在视口内
      var maxLeft = window.innerWidth - root.offsetWidth;
      var maxTop = window.innerHeight - root.offsetHeight;
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));
      root.style.left = newLeft + "px";
      root.style.top = newTop + "px";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("bili-cp--dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // 保存位置到 storage
      var left = parseInt(root.style.left, 10);
      var top = parseInt(root.style.top, 10);
      if (!isNaN(left) && !isNaN(top)) {
        var pos = { left: left, top: top };
        state.config.floatPos = pos;
        try {
          chrome.storage.local.set({ floatPos: pos }, function () {
            log("拖动位置已保存:", JSON.stringify(pos));
          });
        } catch (e) {
          log("保存拖动位置失败:", e);
        }
      }
    }

    // 窗口 resize 时重新约束位置（防止拖到屏幕外）
    function onResize() {
      if (dragging) return;
      var left = parseInt(root.style.left, 10);
      var top = parseInt(root.style.top, 10);
      if (isNaN(left) || isNaN(top)) return; // 还是默认右下角，不用约束
      var maxLeft = window.innerWidth - root.offsetWidth;
      var maxTop = window.innerHeight - root.offsetHeight;
      var newLeft = Math.max(0, Math.min(left, maxLeft));
      var newTop = Math.max(0, Math.min(top, maxTop));
      if (newLeft !== left || newTop !== top) {
        root.style.left = newLeft + "px";
        root.style.top = newTop + "px";
        state.config.floatPos = { left: newLeft, top: newTop };
        try {
          chrome.storage.local.set({ floatPos: state.config.floatPos });
        } catch (e) {}
      }
    }

    root.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);

    // 返回清理函数（切换布局时移除监听）
    return function disable() {
      root.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }

  // 按位置注入 root；返回是否成功
  // 注入策略：统一浮动定位 append 到 body，根据 orientation 构建横向/竖向布局。
  // 位置由 floatPos 决定（用户拖动后保存），默认右下角 16/16。
  function ensureRootInjected() {
    if (state.rootEl && document.contains(state.rootEl)) return true;
    if (!state.config) return false;

    // 移除旧节点 + 清理旧拖动监听
    var old = document.getElementById(ROOT_ID);
    if (old) old.remove();
    if (state.dragDisable) { try { state.dragDisable(); } catch (e) {} state.dragDisable = null; }
    if (state.rootEl) state.rootEl.remove();

    var ori = state.config.orientation || "landscape";
    if (ori !== "landscape" && ori !== "portrait") {
      log("未知 orientation " + ori + "，使用 landscape");
      ori = "landscape";
      state.config.orientation = "landscape";
    }

    var root = buildRoot(ori);
    applyDisplayOptions(root);
    applyFloatPos(root);
    state.currentPosition = "float_" + ori;

    try {
      document.body.appendChild(root);
    } catch (e) {
      log("appendChild 失败:", e);
      state.rootEl = null;
      return false;
    }

    state.rootEl = root;
    // 启用拖动（仅当未开启"固定位置"开关时）
    if (state.config.fixedPosition) {
      root.classList.add("bili-cp--fixed");
      log("UI 已注入: orientation=" + ori, "floatPos=", JSON.stringify(state.config.floatPos), "（固定位置，不可拖动）");
    } else {
      state.dragDisable = enableDrag(root);
      log("UI 已注入: orientation=" + ori, "floatPos=", JSON.stringify(state.config.floatPos), "（可拖动）");
    }
    return true;
  }

  function removeRoot() {
    if (state.dragDisable) { try { state.dragDisable(); } catch (e) {} state.dragDisable = null; }
    if (state.rootEl) {
      try { state.rootEl.remove(); } catch (e) {}
      state.rootEl = null;
    } else {
      var old = document.getElementById(ROOT_ID);
      if (old) old.remove();
    }
    state.currentPosition = null;
  }

  function computeProgress() {
    var idx = state.currentIndex;
    if (idx < 0 || idx >= state.pages.length) {
      return { ratio: 0, played: 0, total: state.totalDuration, mode: "duration" };
    }

    // 模式 A：有时长数据，按合集总时长计算
    if (state.totalDuration > 0) {
      var playedBefore = 0;
      for (var i = 0; i < idx; i++) {
        playedBefore += (state.pages[i].duration || 0);
      }
      var cur = 0;
      if (state.videoEl && !isNaN(state.videoEl.currentTime)) {
        cur = state.videoEl.currentTime;
      }
      var played = playedBefore + cur;
      var total = state.totalDuration;
      var ratio = total > 0 ? Math.min(1, played / total) : 0;
      return { ratio: ratio, played: played, total: total, mode: "duration" };
    }

    // 模式 B：无时长数据（DOM 兜底），按集数 + 当前 P 内进度计算
    var curInP = 0;
    var durCur = 0;
    if (state.videoEl && !isNaN(state.videoEl.currentTime)) {
      curInP = state.videoEl.currentTime;
      if (!isNaN(state.videoEl.duration) && state.videoEl.duration > 0) {
        durCur = state.videoEl.duration;
      }
    }
    var playedFrac = idx + (durCur > 0 ? curInP / durCur : 0);
    var totalP = state.pages.length || 1;
    var ratioP = Math.min(1, playedFrac / totalP);
    return {
      ratio: ratioP,
      played: playedFrac,    // 浮点集数，如 13.4
      total: totalP,         // 整数集数
      mode: "episode",
      idx: idx,
      curInP: curInP,
      durCur: durCur
    };
  }

  function renderNow() {
    if (!state.rootEl || !document.contains(state.rootEl)) {
      if (!ensureRootInjected()) return;
    }
    var p = computeProgress();
    var pct = state.rootEl.querySelector(".bili-cp__percent");
    var cur = state.rootEl.querySelector(".bili-cp__cur");
    var tot = state.rootEl.querySelector(".bili-cp__total");
    if (pct) pct.textContent = (p.ratio * 100).toFixed(1) + "%";

    if (p.mode === "episode") {
      var curP = (p.idx !== undefined ? p.idx : 0) + 1;
      if (cur) cur.textContent = "P" + curP;
      if (tot) tot.textContent = "P" + p.total;
    } else {
      if (cur) cur.textContent = formatDuration(p.played);
      if (tot) tot.textContent = formatDuration(p.total);
    }

    // 诊断日志（仅当 ratio 变化时输出，避免刷屏）
    if (state._lastDiagRatio !== p.ratio) {
      state._lastDiagRatio = p.ratio;
      log("render mode=", p.mode, "ratio=", p.ratio.toFixed(3),
        "played=", (p.mode === "episode" ? p.played.toFixed(2) + "P" : formatDuration(p.played)),
        "total=", (p.mode === "episode" ? p.total + "P" : formatDuration(p.total)),
        "idx=", state.currentIndex,
        "videoTime=", (state.videoEl && !isNaN(state.videoEl.currentTime)) ? state.videoEl.currentTime.toFixed(1) : "null");
    }
  }

  function requestRender(immediate) {
    if (immediate) {
      state.lastRenderTs = Date.now();
      state.renderQueued = false;
      try { renderNow(); } catch (e) { log("render error", e); }
      return;
    }
    var now = Date.now();
    if (now - state.lastRenderTs >= RENDER_THROTTLE_MS) {
      state.lastRenderTs = now;
      state.renderQueued = false;
      try { renderNow(); } catch (e) { log("render error", e); }
      return;
    }
    if (state.renderQueued) return;
    state.renderQueued = true;
    var wait = RENDER_THROTTLE_MS - (now - state.lastRenderTs);
    setTimeout(function () {
      state.renderQueued = false;
      state.lastRenderTs = Date.now();
      try { renderNow(); } catch (e) { log("render error", e); }
    }, Math.max(50, wait));
  }

  // ---------- 事件绑定 ----------

  function bindVideoEvents(video) {
    if (!video) return;
    if (state.videoEl === video) return;
    if (state.videoEl && state.videoEl !== video) {
      try { unbindVideoEvents(state.videoEl); } catch (e) {}
    }
    state.videoEl = video;
    video.addEventListener("timeupdate", onVideoTimeUpdate);
    video.addEventListener("loadedmetadata", onVideoLoadedMetadata);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("durationchange", onVideoDurationChange);
  }

  function unbindVideoEvents(video) {
    if (!video) return;
    video.removeEventListener("timeupdate", onVideoTimeUpdate);
    video.removeEventListener("loadedmetadata", onVideoLoadedMetadata);
    video.removeEventListener("seeked", onVideoSeeked);
    video.removeEventListener("play", onVideoPlay);
    video.removeEventListener("pause", onVideoPause);
    video.removeEventListener("durationchange", onVideoDurationChange);
  }

  function onVideoTimeUpdate() { requestRender(false); }
  function onVideoSeeked() { requestRender(true); }
  function onVideoPlay() { requestRender(true); }
  function onVideoPause() { requestRender(true); }
  function onVideoDurationChange() { requestRender(true); }
  function onVideoLoadedMetadata() {
    if (refreshCurrentIndex()) {
      requestRender(true);
    } else {
      requestRender(true);
    }
  }

  function observePod() {
    if (!state.podEl) return;
    if (state.podObserver) { try { state.podObserver.disconnect(); } catch (e) {} }
    state.podObserver = new MutationObserver(function (mutations) {
      var needRefresh = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "attributes" && m.attributeName === "class") {
          needRefresh = true; break;
        }
        if (m.type === "childList") {
          needRefresh = true; break;
        }
      }
      if (!needRefresh) return;
      if (state._podDebounce) { clearTimeout(state._podDebounce); }
      state._podDebounce = setTimeout(function () {
        if (refreshCurrentIndex()) {
          requestRender(true);
        }
        ensureRootInjected();
      }, 100);
    });
    state.podObserver.observe(state.podEl, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-key"],
      childList: true
    });
  }

  function observeBodyForVideo() {
    if (state.videoObserver) { try { state.videoObserver.disconnect(); } catch (e) {} }
    state.videoObserver = new MutationObserver(function () {
      var v = document.querySelector("video");
      if (v && v !== state.videoEl) {
        bindVideoEvents(v);
        requestRender(true);
      } else if (!v && state.videoEl) {
        state.videoEl = null;
      }
    });
    state.videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function hookHistory() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      var ret = origPush.apply(this, arguments);
      onUrlChange();
      return ret;
    };
    history.replaceState = function () {
      var ret = origReplace.apply(this, arguments);
      onUrlChange();
      return ret;
    };
    window.addEventListener("popstate", onUrlChange);
  }

  function onUrlChange() {
    var p = getCurrentUrlP();
    if (p === state.urlP) return;
    state.urlP = p;
    setTimeout(function () {
      refreshCurrentIndex();
      requestRender(true);
    }, 200);
    setTimeout(function () {
      refreshCurrentIndex();
      requestRender(true);
    }, 800);
  }

  // ---------- 诊断 ----------

  function diagnose() {
    log("======== 诊断开始 ========");
    log("当前配置:", JSON.stringify(state.config));
    log("state.started:", state.started, "pagesLoaded:", state.pagesLoaded);
    log("URL:", location.href, "?p=", getCurrentUrlP(), "bvid:", getBvidFromUrl());

    var vd = getVideoData();
    log("__INITIAL_STATE__.videoData 存在:", !!vd);
    if (vd) {
      log("  videoData.pages.length:", (vd.pages && vd.pages.length) || 0);
      log("  videoData.duration:", vd.duration);
      log("  videoData.cid:", vd.cid);
      if (vd.pages && vd.pages.length) {
        log("  pages[0]:", JSON.stringify({ cid: vd.pages[0].cid, duration: vd.pages[0].duration, part: vd.pages[0].part }));
      }
    } else {
      log("⚠️ __INITIAL_STATE__.videoData 不存在 —— 新版 B 站页面已不在此处提供数据");
      log("   插件将自动通过 API（api.bilibili.com/x/web-interface/view）获取分P信息");
    }

    log("state.pages.length:", state.pages.length, "totalDuration:", state.totalDuration);
    log("state.currentIndex:", state.currentIndex);

    var pod = findPodContainer();
    log("合集列表容器:", pod ? (pod.tagName + " ." + pod.className) : "未找到");
    var player = findPlayerContainer();
    log("播放器容器:", player ? (player.tagName + " ." + player.className) : "未找到");

    var video = document.querySelector("video");
    log("<video> 元素:", video ? "存在 (currentTime=" + (video.currentTime || 0).toFixed(1) + ", duration=" + (video.duration || 0).toFixed(1) + ")" : "未找到");

    log("当前注入位置:", state.currentPosition);
    log("state.rootEl 在 DOM 中:", !!(state.rootEl && document.contains(state.rootEl)));

    if (!state.pagesLoaded) {
      log("⚠️ 分P 数据未加载！可手动测试 API：在控制台执行");
      log("   fetch('https://api.bilibili.com/x/web-interface/view?bvid=" + (getBvidFromUrl() || "BV1xxxxxx") + "').then(r=>r.json()).then(j=>console.log(j.data&&j.data.pages&&j.data.pages.length))");
    }

    if (!pod) {
      log("⚠️ 未找到合集列表容器（.video-pod）！识别当前 P 将依赖 URL ?p= 或 __INITIAL_STATE__");
      log("  页面可能：1. 不是合集  2. B站 DOM 变更");
      var all = document.querySelectorAll("[class*='pod'], [class*='list'], [class*='multi'], [class*='page'], [class*='season'], [class*='selection']");
      var seen = {};
      var count = 0;
      for (var i = 0; i < all.length && count < 10; i++) {
        var cls = all[i].className;
        if (typeof cls !== "string") continue;
        if (seen[cls]) continue;
        seen[cls] = 1;
        log("   -", all[i].tagName, "." + cls);
        count++;
      }
    }

    log("======== 诊断结束 ========");
    return {
      config: state.config,
      started: state.started,
      pagesLoaded: state.pagesLoaded,
      pagesCount: state.pages.length,
      currentIndex: state.currentIndex,
      hasPod: !!pod,
      hasPlayer: !!player,
      hasVideo: !!video,
      currentPosition: state.currentPosition,
      rootInDom: !!(state.rootEl && document.contains(state.rootEl))
    };
  }

  // ---------- 消息处理 ----------

  function setupMessageListener() {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || !msg.type) return;
        if (msg.type === "BILI_CP_CONFIG_UPDATE") {
          log("收到配置更新:", JSON.stringify(msg.config));
          state.config = Object.assign({}, DEFAULT_CONFIG, msg.config || {});
          // 立即应用
          applyConfigChange();
          sendResponse && sendResponse({ ok: true });
        } else if (msg.type === "BILI_CP_DIAGNOSE") {
          var r = diagnose();
          sendResponse && sendResponse(r);
        }
        return true;
      });
    } catch (e) {
      log("注册消息监听失败", e);
    }
  }

  function applyConfigChange() {
    if (!state.config) return;
    if (!state.pagesLoaded) {
      log("配置变化但 pages 未加载，尝试启动");
      start();
      return;
    }
    if (state.pages.length <= 1) {
      log("单 P 视频，不显示");
      removeRoot();
      return;
    }
    // 配置变化：移除旧 root 并按新配置注入（固定/可拖动、横/竖向、位置等）
    removeRoot();
    if (ensureRootInjected()) {
      applyDisplayOptions(state.rootEl);
      requestRender(true);
    }
  }

  // ---------- 启动 ----------

  function start() {
    if (state.started) return;
    state.started = true;

    if (!state.config) {
      // 兜底：未读到配置时用默认
      state.config = Object.assign({}, DEFAULT_CONFIG);
    }

    log("启动中... 配置:", JSON.stringify(state.config));

    // 等待数据与基本 DOM 就绪
    // 策略：先等 __INITIAL_STATE__.videoData.pages 出现（短时间），不行就直接走 API fallback
    waitFor(function () {
      // 任一就绪即可：__INITIAL_STATE__.videoData.pages 或 .video-pod 容器
      var vd = getVideoData();
      if (vd && vd.pages && vd.pages.length > 0) return true;
      // DOM 容器出现也认为可以尝试（用于 API fallback）
      return !!findPodContainer();
    }, 15000).then(function (ok) {
      if (!ok) {
        log("等待 15s 未获取到 videoData.pages 且未找到合集列表容器，可能是非视频页");
        return;
      }

      // 浮动位置不需要合集列表容器作为宿主，但仍尝试获取用于识别当前 P
      state.podEl = findPodContainer();

      // 综合加载分P数据：state → API → DOM
      return loadPagesAny();
    }).then(function (loaded) {
      if (!loaded) {
        log("分P 数据加载失败，无法显示进度条");
        return;
      }
      if (state.pages.length <= 1) {
        log("单 P 视频，不显示进度条");
        return;
      }

      state.urlP = getCurrentUrlP();
      if (!refreshCurrentIndex()) {
        state.currentIndex = 0;
      }

      if (!ensureRootInjected()) {
        log("首次注入失败");
        return;
      }

      var v = document.querySelector("video");
      if (v) bindVideoEvents(v);

      observePod();
      observeBodyForVideo();
      hookHistory();

      // 启动 1s 兜底心跳：timeupdate 事件可能在某些情况下（video 元素被替换、
      // B 站拦截事件、SPA 切换分P）失效，心跳定时器确保进度条持续刷新
      startHeartbeat();

      requestRender(true);

      log("已启动，共 " + state.pages.length + " P，总时长 " + formatDuration(state.totalDuration) + "，位置:", state.currentPosition);
    });
  }

  // 1 秒兜底心跳：周期性 force render，不依赖 timeupdate 事件
  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = setInterval(function () {
      if (!state.started || !state.rootEl) return;
      // 重新绑定 video（万一被 B 站替换了）
      var v = document.querySelector("video");
      if (v && state.videoEl !== v) {
        log("心跳检测到 video 元素变化，重新绑定");
        bindVideoEvents(v);
      }
      // 重新识别当前 P（B 站 SPA 切换 ?p= 后 active 项会变）
      var oldIdx = state.currentIndex;
      refreshCurrentIndex();
      if (oldIdx !== state.currentIndex) {
        log("心跳检测到 currentIndex 变化:", oldIdx, "->", state.currentIndex);
      }
      requestRender(true);
    }, 1000);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function boot() {
    setupMessageListener();
    loadConfig().then(function (cfg) {
      state.config = cfg;
      log("配置加载完成:", JSON.stringify(cfg));
      if (document.readyState === "complete" || document.readyState === "interactive") {
        setTimeout(start, 0);
      } else {
        document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 0); });
      }
      // 兜底重试
      setTimeout(function () { if (!state.started) start(); }, 3000);
      setTimeout(function () { if (!state.started) start(); }, 8000);
    });
  }

  // ---------- 入口 ----------
  boot();
})();

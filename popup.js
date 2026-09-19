/* B站合集时长进度 - popup 脚本
 * 将配置保存到 chrome.storage.local，并通知当前 tab 的 content script 重新应用。
 */

var DEFAULT_CONFIG = {
  fixedPosition: false,     // true = 位置固定不可拖动；false = 可拖动
  orientation: "landscape", // landscape（横向）| portrait（竖向）
  showPercent: true,
  showTime: true,
  floatPos: null            // { left, top } 用户拖动后保存的位置；null 时用默认右下角
};

var ORIENTATION_DESC = {
  landscape: "横向布局：标题与百分比同行，时间在下方一行（默认右下角）",
  portrait: "竖向布局：从上到下依次为 标题 / 百分比 / 当前时间 / / / 总时长"
};

function $(id) { return document.getElementById(id); }

function showStatus(msg, type) {
  var el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (type ? " " + type : "");
  if (msg) {
    setTimeout(function () {
      el.textContent = "";
      el.className = "status";
    }, 3000);
  }
}

function updateOriDesc() {
  var v = $("orientation").value;
  $("oriDesc").textContent = ORIENTATION_DESC[v] || "";
}

function loadConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(DEFAULT_CONFIG, function (items) {
      // 合并默认值，防止旧版本数据缺字段
      var cfg = {};
      Object.keys(DEFAULT_CONFIG).forEach(function (k) {
        cfg[k] = (items[k] === undefined) ? DEFAULT_CONFIG[k] : items[k];
      });
      // 旧版本迁移：把旧的 position 字段直接丢弃
      delete cfg.position;
      resolve(cfg);
    });
  });
}

function saveConfig(cfg) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(cfg, function () {
      resolve(chrome.runtime.lastError ? false : true);
    });
  });
}

function getCurrentTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function isBilibiliVideoTab(tab) {
  if (!tab || !tab.url) return false;
  return /^https:\/\/www\.bilibili\.com\/video\//.test(tab.url);
}

function notifyContentScript(cfg) {
  return getCurrentTab().then(function (tab) {
    if (!isBilibiliVideoTab(tab)) {
      return { skip: true };
    }
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tab.id, { type: "BILI_CP_CONFIG_UPDATE", config: cfg }, function () {
        var err = chrome.runtime.lastError;
        resolve({ skip: false, err: err });
      });
    });
  });
}

function fillForm(cfg) {
  $("fixedPosition").checked = !!cfg.fixedPosition;
  $("orientation").value = cfg.orientation || "landscape";
  $("showPercent").checked = !!cfg.showPercent;
  $("showTime").checked = !!cfg.showTime;
  updateOriDesc();
}

function collectForm() {
  return {
    fixedPosition: $("fixedPosition").checked,
    orientation: $("orientation").value,
    showPercent: $("showPercent").checked,
    showTime: $("showTime").checked
  };
}

document.addEventListener("DOMContentLoaded", function () {
  loadConfig().then(fillForm);

  $("orientation").addEventListener("change", updateOriDesc);

  $("save").addEventListener("click", function () {
    var cfg = collectForm();
    saveConfig(cfg).then(function (ok) {
      if (!ok) {
        showStatus("保存失败：storage 不可用", "error");
        return;
      }
      notifyContentScript(cfg).then(function (r) {
        if (r.skip) {
          showStatus("已保存（当前不是 B站视频页，下次进入生效）", "success");
        } else if (r.err) {
          showStatus("已保存，刷新页面生效", "success");
        } else {
          showStatus("已保存并应用", "success");
        }
      });
    });
  });

  $("diagnose").addEventListener("click", function () {
    getCurrentTab().then(function (tab) {
      if (!isBilibiliVideoTab(tab)) {
        showStatus("当前不是 B站视频页", "error");
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "BILI_CP_DIAGNOSE" }, function () {
        if (chrome.runtime.lastError) {
          showStatus("content script 未响应，请刷新页面后重试", "error");
        } else {
          showStatus("诊断信息已输出到 DevTools Console，请按 F12 查看", "success");
        }
      });
    });
  });
});

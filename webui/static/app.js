(() => {
  const defaults = window.CYANRIP_DEFAULTS || {};
  const outputs = window.CYANRIP_OUTPUTS || [];
  const sanitationModes = window.CYANRIP_SANITATION || [];
  const coverSizes = window.CYANRIP_COVERART_SIZES || [];

  const AVAILABLE_LOCALES = ["en", "de"];
  const THEME_ORDER = ["auto", "dark", "light"];

  const COOKIE_THEME = "cyanrip_theme_mode";
  const COOKIE_LANG = "cyanrip_language";
  const COOKIE_ANIM = "cyanrip_animations";
  const COOKIE_OFFSET = "cyanrip_offset";

  const state = {
    previewTimer: null,
    currentJobId: null,
    nextLogIndex: null,
    activeTrackNo: null,
    trackRows: new Map(),

    locale: "en",
    dictionary: {},
    fallbackDictionary: {},

    themeMode: "auto",
    animationsEnabled: true,

    scanInProgress: false,
    lastScanSuccess: false,
    runnerStatus: null,

    discInfo: null,
    discTracks: [],

    ripMeta: {
      discTracks: null,
      plannedTrackNumbers: null,
      totalTracks: 0,
      currentTrackNo: null,
      currentTrackProgress: 0,
      eta: null,
    },
  };

  const el = (id) => document.getElementById(id);

  async function initialize() {
    renderOutputCheckboxes();
    renderSelectOptions("sanitation", sanitationModes);
    renderSelectOptions("coverart-lookup-size", coverSizes.map(String));
    applyDefaults();

    loadPreferenceCookies();
    await initI18n();

    applyThemeMode();
    applyAnimationMode();
    updateToolbarButtonLabels();
    updateStatusPanel();

    wireEvents();
    setupBeforeUnloadGuard();

    refreshPreview();
    refreshStatusAndLogs();
    setInterval(refreshStatusAndLogs, 1500);
  }

  function wireEvents() {
    el("probe-binary").addEventListener("click", probeBinary);
    el("refresh-preview").addEventListener("click", refreshPreview);
    el("scan-disc").addEventListener("click", scanDisc);
    el("open-drive").addEventListener("click", openDrive);
    el("start-job").addEventListener("click", startJob);
    el("stop-job").addEventListener("click", stopJob);

    el("theme-toggle").addEventListener("click", cycleThemeMode);
    el("animation-toggle").addEventListener("click", toggleAnimations);
    el("language-select").addEventListener("change", onLanguageChanged);
    el("offset").addEventListener("input", persistOffsetPreference);
    el("offset").addEventListener("change", persistOffsetPreference);
    el("offset").addEventListener("blur", persistOffsetPreference);

    document.querySelectorAll("input,select,textarea").forEach((node) => {
      node.addEventListener("input", debouncePreview);
      node.addEventListener("change", debouncePreview);
    });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (state.themeMode === "auto") {
        updateToolbarButtonLabels();
      }
    });
  }

  function setupBeforeUnloadGuard() {
    window.addEventListener("beforeunload", (event) => {
      const isRunning = !!(state.runnerStatus && state.runnerStatus.is_running);
      if (!state.scanInProgress && !isRunning) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function initI18n() {
    state.fallbackDictionary = await loadLocaleDictionary("en");

    const initialLocale = resolveInitialLocale();
    await setLocale(initialLocale, false);

    renderLanguageSelect();
    applyTranslations();
  }

  function resolveInitialLocale() {
    const cookieLocale = normalizeLocale(getCookie(COOKIE_LANG));
    if (cookieLocale) {
      return cookieLocale;
    }

    const browserLocales = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    for (const locale of browserLocales) {
      const normalized = normalizeLocale(locale);
      if (normalized) {
        return normalized;
      }
    }

    return "en";
  }

  function normalizeLocale(value) {
    if (!value) {
      return null;
    }

    const lower = String(value).trim().toLowerCase();
    if (!lower) {
      return null;
    }

    if (AVAILABLE_LOCALES.includes(lower)) {
      return lower;
    }

    const prefix = lower.split("-")[0];
    if (AVAILABLE_LOCALES.includes(prefix)) {
      return prefix;
    }

    return null;
  }

  async function loadLocaleDictionary(locale) {
    try {
      const response = await fetch(`/static/i18n/${encodeURIComponent(locale)}.json`, { cache: "no-cache" });
      if (!response.ok) {
        return {};
      }
      const data = await response.json();
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      return {};
    }
  }

  async function setLocale(locale, persist = true) {
    const normalized = normalizeLocale(locale) || "en";
    const dictionary = normalized === "en" ? state.fallbackDictionary : await loadLocaleDictionary(normalized);

    state.locale = normalized;
    state.dictionary = dictionary;

    if (persist) {
      setCookie(COOKIE_LANG, normalized);
    }
  }

  async function onLanguageChanged(event) {
    const requested = normalizeLocale(event.target.value) || "en";
    await setLocale(requested, true);

    renderLanguageSelect();
    applyTranslations();
    refreshAllTrackLabels();
    renderDiscSummary();
    updateToolbarButtonLabels();
    updateStatusPanel();
  }

  function renderLanguageSelect() {
    const select = el("language-select");
    select.innerHTML = "";

    AVAILABLE_LOCALES.forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = t(`language.name.${code}`) || code;
      select.appendChild(option);
    });

    select.value = state.locale;
  }

  function applyTranslations() {
    document.documentElement.lang = state.locale;

    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.getAttribute("data-i18n");
      node.textContent = t(key);
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      const key = node.getAttribute("data-i18n-placeholder");
      node.placeholder = t(key);
    });

    document.querySelectorAll("[data-tip-key]").forEach((node) => {
      const key = node.getAttribute("data-tip-key");
      node.dataset.tip = t(key);
    });
  }

  function t(key, vars = null) {
    const fallback = lookupKey(state.fallbackDictionary, key);
    const current = lookupKey(state.dictionary, key);
    const base = current !== undefined ? current : fallback;
    const text = base === undefined ? key : String(base);

    if (!vars) {
      return text;
    }

    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, group) => {
      if (!(group in vars)) {
        return `{${group}}`;
      }
      return String(vars[group]);
    });
  }

  function lookupKey(dict, dottedKey) {
    if (!dict || typeof dict !== "object") {
      return undefined;
    }

    let current = dict;
    const parts = String(dottedKey).split(".");
    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  function loadPreferenceCookies() {
    const cookieTheme = String(getCookie(COOKIE_THEME) || "").trim().toLowerCase();
    state.themeMode = THEME_ORDER.includes(cookieTheme) ? cookieTheme : "auto";

    const cookieAnim = String(getCookie(COOKIE_ANIM) || "").trim().toLowerCase();
    state.animationsEnabled = cookieAnim !== "off";

    const cookieOffset = String(getCookie(COOKIE_OFFSET) || "").trim();
    if (/^-?\d+$/.test(cookieOffset)) {
      el("offset").value = String(Number.parseInt(cookieOffset, 10));
    }
  }

  function persistOffsetPreference() {
    const raw = String(el("offset").value || "").trim();
    if (!raw) {
      setCookie(COOKIE_OFFSET, "", 0);
      return;
    }

    if (!/^-?\d+$/.test(raw)) {
      return;
    }

    setCookie(COOKIE_OFFSET, String(Number.parseInt(raw, 10)));
  }

  function cycleThemeMode() {
    const idx = THEME_ORDER.indexOf(state.themeMode);
    state.themeMode = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    setCookie(COOKIE_THEME, state.themeMode);
    applyThemeMode();
    updateToolbarButtonLabels();
  }

  function applyThemeMode() {
    const root = document.documentElement;
    if (state.themeMode === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", state.themeMode);
    }
  }

  function toggleAnimations() {
    state.animationsEnabled = !state.animationsEnabled;
    setCookie(COOKIE_ANIM, state.animationsEnabled ? "on" : "off");
    applyAnimationMode();
    updateToolbarButtonLabels();
  }

  function applyAnimationMode() {
    const root = document.documentElement;
    root.setAttribute("data-animations", state.animationsEnabled ? "on" : "off");
  }

  function updateToolbarButtonLabels() {
    const darkPreferred = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolvedTheme = state.themeMode === "auto" ? (darkPreferred ? "dark" : "light") : state.themeMode;

    if (state.themeMode === "auto") {
      el("theme-toggle").textContent = t("toolbar.theme.auto", { resolved: t(`toolbar.theme.mode.${resolvedTheme}`) });
    } else {
      el("theme-toggle").textContent = t("toolbar.theme.fixed", { mode: t(`toolbar.theme.mode.${state.themeMode}`) });
    }

    el("animation-toggle").textContent = state.animationsEnabled
      ? t("toolbar.animations.on")
      : t("toolbar.animations.off");
  }

  function debouncePreview() {
    if (state.previewTimer !== null) {
      window.clearTimeout(state.previewTimer);
    }
    state.previewTimer = window.setTimeout(refreshPreview, 260);
  }

  function renderOutputCheckboxes() {
    const container = el("outputs-container");
    container.innerHTML = "";

    outputs.forEach((output) => {
      const wrapper = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = output;
      checkbox.dataset.role = "output";
      wrapper.append(checkbox, document.createTextNode(output));
      container.appendChild(wrapper);
    });
  }

  function renderSelectOptions(id, values) {
    const select = el(id);
    select.innerHTML = "";
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }

  function applyDefaults() {
    el("device-path").value = defaults.device_path || "";
    el("offset").value = defaults.offset ?? 0;
    el("max-retries").value = defaults.max_retries ?? 10;
    el("ripping-retries").value = valueOrEmpty(defaults.ripping_retries);
    el("speed").value = valueOrEmpty(defaults.speed);
    el("paranoia-level").value = defaults.paranoia_level || "max";

    el("overread-leadinout").checked = !!defaults.overread_leadinout;
    el("decode-hdcd").checked = !!defaults.decode_hdcd;
    el("force-deemphasis").checked = !!defaults.force_deemphasis;
    el("disable-deemphasis").checked = !!defaults.disable_deemphasis;
    el("disable-replaygain").checked = !!defaults.disable_replaygain;
    el("find-drive-offset").checked = !!defaults.find_drive_offset;

    el("bitrate").value = defaults.bitrate ?? 256;
    el("directory-scheme").value = defaults.directory_scheme || "";
    el("track-scheme").value = defaults.track_scheme || "";
    el("log-scheme").value = defaults.log_scheme || "";
    el("cue-scheme").value = defaults.cue_scheme || "";
    el("track-selection").value = (defaults.track_selection || []).join(",");
    el("sanitation").value = defaults.sanitation || "unicode";

    el("print-info-only").checked = !!defaults.print_info_only;
    el("disable-mb").checked = !!defaults.disable_mb;
    el("disable-accurip").checked = !!defaults.disable_accurip;
    el("disable-coverart-db").checked = !!defaults.disable_coverart_db;
    el("disable-coverart-embedding").checked = !!defaults.disable_coverart_embedding;
    el("eject-on-success").checked = !!defaults.eject_on_success;
    el("print-version").checked = !!defaults.print_version;
    el("show-help").checked = !!defaults.show_help;

    el("album-metadata").value = defaults.album_metadata || "";
    el("track-metadata").value = "";
    el("release").value = defaults.release || "";
    el("disc-number").value = valueOrEmpty(defaults.disc_number);
    el("total-discs").value = valueOrEmpty(defaults.total_discs);
    el("cover-arts").value = "";
    el("coverart-lookup-size").value = String(defaults.coverart_lookup_size ?? -1);

    const selected = new Set(defaults.outputs || ["flac"]);
    document.querySelectorAll("input[data-role='output']").forEach((node) => {
      node.checked = selected.has(node.value);
    });
  }

  async function probeBinary() {
    clearError();
    setMessage("probe-result", t("message.probingBinary"));

    try {
      const body = {
        binary_path: el("binary-path").value.trim(),
      };
      const result = await apiPost("/api/probe", body);
      const lines = [];
      lines.push(`-V rc=${result.version_returncode}`);
      lines.push(result.version_output || t("message.noOutput"));
      lines.push("");
      lines.push(`-h rc=${result.help_returncode}`);
      lines.push(result.help_preview || t("message.noOutput"));
      setMessage("probe-result", lines.join("\n"));
    } catch (err) {
      showError(err.message);
      setMessage("probe-result", "");
    }
  }

  async function scanDisc() {
    clearError();
    state.scanInProgress = true;
    state.lastScanSuccess = false;
    updateStatusPanel();

    try {
      const payload = {
        binary_path: el("binary-path").value.trim(),
        working_directory: el("working-directory").value.trim(),
        config: collectConfig(),
      };

      const result = await apiPost("/api/scan", payload);
      state.discInfo = result.disc || {};
      state.discTracks = Array.isArray(result.tracks) ? result.tracks : [];
      renderScannedDisc(state.discInfo, state.discTracks);
      renderDiscSummary();
      state.lastScanSuccess = true;
    } catch (err) {
      showError(err.message);
      setMessage("scan-summary", "");
    } finally {
      state.scanInProgress = false;
      updateStatusPanel();
    }
  }

  async function openDrive() {
    clearError();
    setMessage("probe-result", t("message.ejectingDrive"));

    try {
      const result = await apiPost("/api/eject", {
        device_path: el("device-path").value.trim(),
      });

      const lines = [];
      lines.push(result.message || t("message.ejectDone"));
      if (result.output_preview) {
        lines.push(result.output_preview);
      }
      setMessage("probe-result", lines.filter(Boolean).join("\n"));
    } catch (err) {
      showError(err.message);
      setMessage("probe-result", "");
    }
  }

  async function refreshPreview() {
    clearError();

    try {
      const payload = {
        binary_path: el("binary-path").value.trim(),
        config: collectConfig(),
      };
      const preview = await apiPost("/api/preview", payload);
      el("command-preview").textContent = preview.shell_command || "";
    } catch (err) {
      showError(err.message);
      el("command-preview").textContent = "";
    }
  }

  async function startJob() {
    clearError();

    const config = collectConfig();
    prepareTracksForRip(config);
    prepareRipMetaForStart(config);
    state.lastScanSuccess = false;

    try {
      const payload = {
        binary_path: el("binary-path").value.trim(),
        working_directory: el("working-directory").value.trim(),
        config,
      };

      const snapshot = await apiPost("/api/start", payload);
      if (snapshot.job_id !== state.currentJobId) {
        state.currentJobId = snapshot.job_id;
        state.nextLogIndex = null;
        state.activeTrackNo = null;
        resetRipMetaRuntimeFields();
        el("job-log").textContent = "";
      }

      await refreshStatusAndLogs();
    } catch (err) {
      showError(err.message);
    }
  }

  async function stopJob() {
    clearError();

    try {
      await apiPost("/api/stop", {});
      await refreshStatusAndLogs();
    } catch (err) {
      showError(err.message);
    }
  }

  async function refreshStatusAndLogs() {
    try {
      const status = await apiGet("/api/status");
      state.runnerStatus = status;

      if (status.job_id !== state.currentJobId) {
        state.currentJobId = status.job_id;
        state.nextLogIndex = null;
        state.activeTrackNo = null;
        resetRipMetaRuntimeFields();
        el("job-log").textContent = "";
      }

      hydrateRuntimeFromStatus(status);

      if (status.log_oldest_index !== undefined && status.log_oldest_index !== null) {
        if (state.nextLogIndex === null) {
          state.nextLogIndex = status.log_oldest_index;
        }
      }

      const since = state.nextLogIndex ?? 0;
      const logs = await apiGet(`/api/logs?since=${encodeURIComponent(String(since))}`);
      appendLogs(logs.lines || []);
      state.nextLogIndex = logs.next_index;

      if (!status.is_running) {
        state.ripMeta.currentTrackNo = null;
        state.ripMeta.currentTrackProgress = 0;
        state.ripMeta.eta = null;
      }

      updateStatusPanel();
    } catch (err) {
      showError(err.message);
    }
  }

  function hydrateRuntimeFromStatus(status) {
    const scan = status && typeof status.scan === "object" ? status.scan : {};
    const disc = status && typeof status.disc === "object" ? status.disc : {};
    const rip = status && typeof status.rip === "object" ? status.rip : {};

    const discInfo = disc && typeof disc.info === "object" ? disc.info : null;
    const discTracks = Array.isArray(disc.tracks) ? disc.tracks : [];
    if (discInfo) {
      state.discInfo = discInfo;
    }
    if (discTracks.length > 0) {
      state.discTracks = discTracks;
    }

    const ripTracks = Array.isArray(rip.tracks) ? rip.tracks : [];
    if (ripTracks.length > 0) {
      applyRipTracksSnapshot(ripTracks);
    } else if (state.trackRows.size === 0 && state.discTracks.length > 0) {
      renderScannedDisc(state.discInfo || {}, state.discTracks);
    }

    const backendDiscTracks = normalizeOptionalInt(rip.disc_tracks);
    if (backendDiscTracks !== null) {
      state.ripMeta.discTracks = backendDiscTracks;
    }

    if (Array.isArray(rip.planned_track_numbers)) {
      const planned = normalizeTrackSelection(rip.planned_track_numbers);
      state.ripMeta.plannedTrackNumbers = new Set(planned);
    } else if (rip.planned_track_numbers === null) {
      state.ripMeta.plannedTrackNumbers = null;
    }

    const totalTracks = normalizeOptionalInt(rip.total_tracks);
    if (totalTracks !== null) {
      state.ripMeta.totalTracks = totalTracks;
    }

    const currentTrackNo = normalizeOptionalInt(rip.current_track_no);
    if (currentTrackNo !== null) {
      state.ripMeta.currentTrackNo = currentTrackNo;
    } else if (!status.is_running) {
      state.ripMeta.currentTrackNo = null;
    }

    const currentProgress = Number.parseFloat(String(rip.current_track_progress));
    if (!Number.isNaN(currentProgress)) {
      state.ripMeta.currentTrackProgress = clamp(currentProgress, 0, 100);
    } else if (!status.is_running) {
      state.ripMeta.currentTrackProgress = 0;
    }

    if (typeof rip.eta === "string" && rip.eta.trim()) {
      state.ripMeta.eta = rip.eta.trim();
    } else if (rip.eta === null || !status.is_running) {
      state.ripMeta.eta = null;
    }

    state.lastScanSuccess = !status.is_running && !!scan.last_success;
    renderDiscSummary();
  }

  function applyRipTracksSnapshot(tracks) {
    if (state.trackRows.size === 0) {
      el("tracks-body").innerHTML = "";
      state.activeTrackNo = null;
    }

    const seen = new Set();
    tracks.forEach((track) => {
      const trackNo = normalizeOptionalInt(track.number);
      if (trackNo === null || trackNo <= 0) {
        return;
      }

      seen.add(trackNo);
      upsertTrackRow(trackNo, {
        title: track.title || `Track ${String(trackNo).padStart(2, "0")}`,
        artist: track.artist || "",
        duration: track.duration || "",
        status: track.status || "detected",
        progress: Number(track.progress || 0),
        accuripText: track.accurip_text || track.accurip || "",
        accuripConfidence: normalizeOptionalInt(track.accurip_confidence),
        accuripMaxConfidence: normalizeOptionalInt(track.accurip_max_confidence),
      });
    });

    state.trackRows.forEach((row, trackNo) => {
      if (seen.has(trackNo)) {
        return;
      }
      row.tr.remove();
      state.trackRows.delete(trackNo);
    });

    el("tracks-empty").style.display = tracks.length > 0 ? "none" : "block";
  }

  function updateStatusPanel() {
    const statusLabel = el("status-label");
    const statusIndicator = el("status-indicator");
    const statusCard = el("status-card");

    const status = state.runnerStatus;
    const isRunning = !!(status && status.is_running);

    let label = t("status.idle");
    let indicatorClass = "idle";
    let indicatorActive = false;

    if (state.scanInProgress) {
      label = t("status.scanning");
      indicatorClass = "active";
      indicatorActive = true;
    } else if (isRunning) {
      label = t("status.ripping");
      indicatorClass = "active";
      indicatorActive = true;
    } else if (status && status.state === "failed") {
      const code = status.returncode;
      label = code === null || code === undefined ? t("status.failed") : `${t("status.failed")} (${code})`;
      indicatorClass = "error";
    } else if (state.lastScanSuccess) {
      label = t("status.scanned");
      indicatorClass = "success";
    } else if (status && status.state === "finished") {
      label = t("status.ripped");
      indicatorClass = "success";
    } else if (status && status.state === "stopped") {
      label = t("status.stopped");
      indicatorClass = "idle";
    }

    statusLabel.textContent = label;

    statusIndicator.className = "status-indicator";
    if (indicatorClass === "active") {
      statusIndicator.classList.add("active");
    } else if (indicatorClass === "success") {
      statusIndicator.classList.add("success");
    } else if (indicatorClass === "error") {
      statusIndicator.classList.add("error");
    } else {
      statusIndicator.classList.add("idle");
    }

    if (indicatorActive) {
      statusIndicator.classList.add("active");
    }

    statusCard.classList.remove("active", "success", "error");
    if (indicatorActive) {
      statusCard.classList.add("active");
    } else if (indicatorClass === "success") {
      statusCard.classList.add("success");
    } else if (indicatorClass === "error") {
      statusCard.classList.add("error");
    }

    const progress = computeOverallRipProgress();
    el("status-progress").textContent = t("status.tracks", {
      done: progress.done,
      total: progress.total,
      percent: progress.percent.toFixed(1),
    });

    if (state.scanInProgress) {
      el("status-eta").textContent = t("status.eta", { eta: t("status.etaScanning") });
    } else if (isRunning && state.ripMeta.eta) {
      el("status-eta").textContent = t("status.eta", { eta: state.ripMeta.eta });
    } else {
      el("status-eta").textContent = t("status.eta", { eta: "-" });
    }
  }

  function prepareRipMetaForStart(config) {
    resetRipMetaRuntimeFields();

    const selected = normalizeTrackSelection(config.track_selection || []);
    if (selected.length > 0) {
      state.ripMeta.plannedTrackNumbers = new Set(selected);
      state.ripMeta.totalTracks = selected.length;
      return;
    }

    if (state.trackRows.size > 0) {
      const all = Array.from(state.trackRows.keys()).sort((a, b) => a - b);
      state.ripMeta.plannedTrackNumbers = new Set(all);
      state.ripMeta.totalTracks = all.length;
      return;
    }

    state.ripMeta.plannedTrackNumbers = null;
    state.ripMeta.totalTracks = 0;
  }

  function resetRipMetaRuntimeFields() {
    state.ripMeta.discTracks = null;
    state.ripMeta.currentTrackNo = null;
    state.ripMeta.currentTrackProgress = 0;
    state.ripMeta.eta = null;
  }

  function computeOverallRipProgress() {
    const planned = state.ripMeta.plannedTrackNumbers;
    let total = state.ripMeta.totalTracks || 0;

    if (total <= 0 && planned && planned.size > 0) {
      total = planned.size;
    }

    if (total <= 0 && planned && planned.size === 0) {
      return { done: 0, total: 0, percent: 0 };
    }

    if (total <= 0 && state.ripMeta.discTracks) {
      total = state.ripMeta.discTracks;
    }

    if (total <= 0) {
      return { done: 0, total: 0, percent: 0 };
    }

    let done = 0;
    if (planned && planned.size > 0) {
      planned.forEach((trackNo) => {
        const row = state.trackRows.get(trackNo);
        if (row && row.statusValue === "done") {
          done += 1;
        }
      });
    } else {
      state.trackRows.forEach((row) => {
        if (row.statusValue === "done") {
          done += 1;
        }
      });
    }

    let currentFraction = 0;
    const currentTrackNo = state.ripMeta.currentTrackNo;
    const currentProgress = state.ripMeta.currentTrackProgress;
    if (currentTrackNo && currentProgress > 0) {
      const row = state.trackRows.get(currentTrackNo);
      const inPlan = !planned || planned.size === 0 || planned.has(currentTrackNo);
      if (inPlan && row && row.statusValue !== "done") {
        currentFraction = clamp(currentProgress / 100, 0, 1);
      }
    }

    const overall = clamp(((done + currentFraction) / total) * 100, 0, 100);
    return {
      done,
      total,
      percent: overall,
    };
  }

  function renderScannedDisc(disc, tracks) {
    state.trackRows.clear();
    state.activeTrackNo = null;

    const tbody = el("tracks-body");
    tbody.innerHTML = "";

    tracks.forEach((track) => {
      upsertTrackRow(track.number, {
        title: track.title || `Track ${String(track.number).padStart(2, "0")}`,
        artist: track.artist || "",
        duration: track.duration || "",
        status: "detected",
        progress: Number(track.progress || 0),
        accuripText: track.accurip_text || track.accurip || "",
        accuripConfidence: normalizeOptionalInt(track.accurip_confidence),
        accuripMaxConfidence: normalizeOptionalInt(track.accurip_max_confidence),
      });
    });

    el("tracks-empty").style.display = tracks.length > 0 ? "none" : "block";
  }

  function renderDiscSummary() {
    if (!state.discInfo && (!state.discTracks || state.discTracks.length === 0)) {
      setMessage("scan-summary", "");
      return;
    }

    const disc = state.discInfo || {};
    const tracks = Array.isArray(state.discTracks) ? state.discTracks : [];

    const lines = [];
    lines.push(`${t("disc.summary.album")}: ${disc.album || t("disc.unknownAlbum")}`);
    lines.push(`${t("disc.summary.artist")}: ${disc.album_artist || t("disc.unknownArtist")}`);
    lines.push(`${t("disc.summary.tracks")}: ${tracks.length || disc.disc_tracks || 0}`);
    lines.push(`${t("disc.summary.totalTime")}: ${disc.total_time || "-"}`);
    lines.push(`${t("disc.summary.accuraterip")}: ${disc.accuraterip || "-"}`);

    setMessage("scan-summary", lines.join("\n"));
  }

  function prepareTracksForRip(config) {
    if (state.trackRows.size === 0) {
      return;
    }

    const selected = normalizeTrackSelection(config.track_selection || []);
    const selectedSet = selected.length > 0 ? new Set(selected) : null;

    state.trackRows.forEach((row, trackNo) => {
      const shouldQueue = !selectedSet || selectedSet.has(trackNo);
      upsertTrackRow(trackNo, {
        status: shouldQueue ? "queued" : "detected",
        progress: shouldQueue ? 0 : row.progressValue,
        accuripText: shouldQueue ? "" : row.accuripText,
        accuripConfidence: shouldQueue ? null : row.accuripConfidence,
        accuripMaxConfidence: shouldQueue ? row.accuripMaxConfidence : row.accuripMaxConfidence,
      });
    });
  }

  function appendLogs(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    const log = el("job-log");
    const parts = [];

    lines.forEach((entry) => {
      const index = entry.index ?? "?";
      const text = entry.line ?? "";
      const signal = parseTrackSignal(text);
      if (!signal.hideInLog) {
        parts.push(`[${index}] ${text}`);
      }
    });

    if (parts.length > 0) {
      log.textContent += `${parts.join("\n")}\n`;
      if (log.textContent.length > 900000) {
        log.textContent = log.textContent.slice(-650000);
      }
      log.scrollTop = log.scrollHeight;
    }
  }

  function parseTrackSignal(rawLine) {
    const line = String(rawLine || "").trim();
    const signal = { hideInLog: false };

    if (!line) {
      return signal;
    }

    let m = line.match(/^Disc\s+tracks:\s+(\d+)$/i);
    if (m) {
      state.ripMeta.discTracks = Number.parseInt(m[1], 10);
      if (!state.ripMeta.totalTracks) {
        state.ripMeta.totalTracks = state.ripMeta.discTracks;
      }
      return signal;
    }

    m = line.match(/^Tracks\s+to\s+rip:\s+(.+)$/i);
    if (m) {
      applyTracksToRipDeclaration(m[1].trim());
      return signal;
    }

    m = line.match(/^Track\s+(\d+)\s+info:/i);
    if (m) {
      const trackNo = Number.parseInt(m[1], 10);
      state.activeTrackNo = trackNo;
      upsertTrackRow(trackNo, { status: "detected" });
      return signal;
    }

    m = line.match(/^Track\s+(\d+)\s+ripped and encoded successfully!$/i);
    if (m) {
      const trackNo = Number.parseInt(m[1], 10);
      state.activeTrackNo = trackNo;
      state.ripMeta.currentTrackNo = trackNo;
      state.ripMeta.currentTrackProgress = 100;
      upsertTrackRow(trackNo, { status: "done", progress: 100 });
      return signal;
    }

    m = line.match(/^Ripping(?:\s+and\s+encoding)?\s+track\s+(\d+),\s+progress\s+-\s+([0-9]+(?:\.[0-9]+)?)%/i);
    if (m) {
      const trackNo = Number.parseInt(m[1], 10);
      const progress = Number.parseFloat(m[2]);
      state.activeTrackNo = trackNo;
      state.ripMeta.currentTrackNo = trackNo;
      state.ripMeta.currentTrackProgress = progress;

      const etaMatch = line.match(/,\s+ETA\s+-\s+(.+?)(?:,\s+errors\s+-\s+\d+)?$/i);
      if (etaMatch) {
        state.ripMeta.eta = etaMatch[1].trim();
      }

      upsertTrackRow(trackNo, {
        status: "running",
        progress,
      });

      signal.hideInLog = true;
      return signal;
    }

    if (state.activeTrackNo === null) {
      return signal;
    }

    m = line.match(/^Duration:\s+(.+)$/i);
    if (m) {
      upsertTrackRow(state.activeTrackNo, { duration: m[1].trim() });
      return signal;
    }

    m = line.match(/^title:\s+(.+)$/i);
    if (m) {
      upsertTrackRow(state.activeTrackNo, { title: m[1].trim() });
      return signal;
    }

    m = line.match(/^artist:\s+(.+)$/i);
    if (m) {
      upsertTrackRow(state.activeTrackNo, { artist: m[1].trim() });
      return signal;
    }

    m = line.match(/^Accurip:\s+(.+?)(?:\s+\(max\s+confidence:\s*(\d+)\))?$/i);
    if (m) {
      const maxConf = normalizeOptionalInt(m[2]);
      upsertTrackRow(state.activeTrackNo, {
        accuripText: m[1].trim(),
        accuripMaxConfidence: maxConf,
      });
      return signal;
    }

    m = line.match(/^Accurip\s+v[12]:\s+[0-9A-F]+(?:\s+\(([^)]*)\))?/i);
    if (m) {
      const detail = (m[1] || "").trim();
      const confMatch = detail.match(/confidence\s+(\d+)/i);
      upsertTrackRow(state.activeTrackNo, {
        accuripText: detail || null,
        accuripConfidence: confMatch ? normalizeOptionalInt(confMatch[1]) : null,
      });
      return signal;
    }

    if (/^Error\b/i.test(line) || /\bfailed\b/i.test(line) || /ripping\s+incomplete/i.test(line)) {
      upsertTrackRow(state.activeTrackNo, { status: "error" });
    }

    return signal;
  }

  function applyTracksToRipDeclaration(rawValue) {
    const value = String(rawValue || "").trim().toLowerCase();
    if (!value) {
      return;
    }

    if (value === "all") {
      if (state.ripMeta.discTracks && state.ripMeta.discTracks > 0) {
        state.ripMeta.totalTracks = state.ripMeta.discTracks;
      } else if (state.trackRows.size > 0) {
        state.ripMeta.totalTracks = state.trackRows.size;
      }
      state.ripMeta.plannedTrackNumbers = null;
      return;
    }

    if (value === "none") {
      state.ripMeta.totalTracks = 0;
      state.ripMeta.plannedTrackNumbers = new Set();
      return;
    }

    const matches = rawValue.match(/\d+/g);
    if (!matches || matches.length === 0) {
      return;
    }

    const values = matches.map((item) => Number.parseInt(item, 10)).filter((item) => !Number.isNaN(item) && item > 0);
    if (values.length === 0) {
      return;
    }

    state.ripMeta.plannedTrackNumbers = new Set(values);
    state.ripMeta.totalTracks = state.ripMeta.plannedTrackNumbers.size;
  }

  function upsertTrackRow(trackNo, patch) {
    const number = Number.parseInt(String(trackNo), 10);
    if (Number.isNaN(number) || number <= 0) {
      return;
    }

    let row = state.trackRows.get(number);
    if (!row) {
      row = createTrackRow(number);
      state.trackRows.set(number, row);
      el("tracks-empty").style.display = "none";
    }

    const title = patch.title ?? row.titleCell.textContent;
    const artist = patch.artist ?? row.artistCell.textContent;
    const duration = patch.duration ?? row.durationCell.textContent;
    const status = patch.status ?? row.statusValue;
    const progress = patch.progress ?? row.progressValue;

    const accuripText = patch.accuripText === null ? "" : patch.accuripText ?? row.accuripText;
    const accuripConfidence = patch.accuripConfidence === undefined ? row.accuripConfidence : patch.accuripConfidence;
    const accuripMaxConfidence =
      patch.accuripMaxConfidence === undefined ? row.accuripMaxConfidence : patch.accuripMaxConfidence;

    row.titleCell.textContent = title || `Track ${String(number).padStart(2, "0")}`;
    row.artistCell.textContent = artist || "";
    row.durationCell.textContent = duration || "";

    row.accuripText = accuripText || "";
    row.accuripConfidence = normalizeOptionalInt(accuripConfidence);
    row.accuripMaxConfidence = normalizeOptionalInt(accuripMaxConfidence);
    row.accuripCell.textContent = formatAccuripCell(row);

    applyTrackStatus(row, status);
    applyTrackProgress(row, progress);
  }

  function createTrackRow(trackNo) {
    const tbody = el("tracks-body");
    const tr = document.createElement("tr");

    const numberCell = document.createElement("td");
    numberCell.textContent = String(trackNo).padStart(2, "0");

    const titleCell = document.createElement("td");
    titleCell.textContent = `Track ${String(trackNo).padStart(2, "0")}`;

    const artistCell = document.createElement("td");
    const durationCell = document.createElement("td");

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = "status-pill status-detected";
    statusPill.textContent = t("trackStatus.detected");
    statusCell.appendChild(statusPill);

    const progressCell = document.createElement("td");
    const progressWrap = document.createElement("div");
    progressWrap.className = "progress-wrap";

    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressBar.appendChild(progressFill);

    const progressPct = document.createElement("span");
    progressPct.className = "progress-pct";
    progressPct.textContent = "0.0%";

    progressWrap.append(progressBar, progressPct);
    progressCell.appendChild(progressWrap);

    const accuripCell = document.createElement("td");

    tr.append(numberCell, titleCell, artistCell, durationCell, statusCell, progressCell, accuripCell);

    const existingRows = Array.from(tbody.querySelectorAll("tr"));
    const insertBefore = existingRows.find((rowNode) => {
      const value = Number.parseInt(rowNode.firstChild.textContent, 10);
      return value > trackNo;
    });

    if (insertBefore) {
      tbody.insertBefore(tr, insertBefore);
    } else {
      tbody.appendChild(tr);
    }

    return {
      tr,
      titleCell,
      artistCell,
      durationCell,
      statusCell: statusPill,
      progressFill,
      progressPct,
      accuripCell,
      statusValue: "detected",
      progressValue: 0,
      accuripText: "",
      accuripConfidence: null,
      accuripMaxConfidence: null,
    };
  }

  function applyTrackStatus(row, status) {
    const normalized = normalizeTrackStatus(status);
    row.statusValue = normalized;

    row.tr.classList.toggle("track-running", normalized === "running");
    row.statusCell.className = `status-pill ${statusClass(normalized)}`;
    row.statusCell.textContent = statusLabel(normalized);
  }

  function applyTrackProgress(row, value) {
    const parsed = Number.parseFloat(String(value));
    const normalized = Number.isNaN(parsed) ? row.progressValue : clamp(parsed, 0, 100);
    row.progressValue = normalized;

    row.progressFill.style.width = `${normalized}%`;
    row.progressPct.textContent = `${normalized.toFixed(1)}%`;
  }

  function formatAccuripCell(row) {
    const confidence = normalizeOptionalInt(row.accuripConfidence);
    const maxConfidence = normalizeOptionalInt(row.accuripMaxConfidence);
    const text = String(row.accuripText || "").trim();

    if (confidence !== null && maxConfidence !== null) {
      return `${confidence}/${maxConfidence}`;
    }
    if (confidence !== null) {
      return String(confidence);
    }
    return text;
  }

  function normalizeTrackStatus(status) {
    const s = String(status || "").toLowerCase();
    if (["running", "ripping", "encoding"].includes(s)) {
      return "running";
    }
    if (["done", "finished", "ok"].includes(s)) {
      return "done";
    }
    if (["error", "failed"].includes(s)) {
      return "error";
    }
    if (["queued", "waiting"].includes(s)) {
      return "queued";
    }
    return "detected";
  }

  function statusClass(status) {
    if (status === "running") {
      return "status-running";
    }
    if (status === "done") {
      return "status-done";
    }
    if (status === "error") {
      return "status-error";
    }
    if (status === "queued") {
      return "status-queued";
    }
    return "status-detected";
  }

  function statusLabel(status) {
    if (status === "running") {
      return t("trackStatus.running");
    }
    if (status === "done") {
      return t("trackStatus.done");
    }
    if (status === "error") {
      return t("trackStatus.error");
    }
    if (status === "queued") {
      return t("trackStatus.queued");
    }
    return t("trackStatus.detected");
  }

  function refreshAllTrackLabels() {
    state.trackRows.forEach((row) => {
      applyTrackStatus(row, row.statusValue);
      row.accuripCell.textContent = formatAccuripCell(row);
    });
    updateStatusPanel();
  }

  function collectConfig() {
    return {
      device_path: el("device-path").value.trim(),
      offset: intOrNull(el("offset").value),
      max_retries: intOrNull(el("max-retries").value),
      ripping_retries: intOrNull(el("ripping-retries").value),
      speed: intOrNull(el("speed").value),
      pregap_rules: parsePregapRules(el("pregap-rules").value),
      paranoia_level: el("paranoia-level").value.trim() || null,
      overread_leadinout: el("overread-leadinout").checked,
      decode_hdcd: el("decode-hdcd").checked,
      force_deemphasis: el("force-deemphasis").checked,
      disable_deemphasis: el("disable-deemphasis").checked,
      disable_replaygain: el("disable-replaygain").checked,
      outputs: getSelectedOutputs(),
      bitrate: floatOrNull(el("bitrate").value),
      directory_scheme: el("directory-scheme").value,
      track_scheme: el("track-scheme").value,
      log_scheme: el("log-scheme").value,
      cue_scheme: el("cue-scheme").value,
      track_selection: parseTrackSelection(el("track-selection").value),
      sanitation: el("sanitation").value,
      print_info_only: el("print-info-only").checked,
      album_metadata: el("album-metadata").value.trim(),
      track_metadata: parseTrackMetadata(el("track-metadata").value),
      release: el("release").value.trim(),
      disc_number: intOrNull(el("disc-number").value),
      total_discs: intOrNull(el("total-discs").value),
      cover_arts: parseCoverArts(el("cover-arts").value),
      disable_mb: el("disable-mb").checked,
      disable_accurip: el("disable-accurip").checked,
      disable_coverart_db: el("disable-coverart-db").checked,
      coverart_lookup_size: intOrNull(el("coverart-lookup-size").value),
      disable_coverart_embedding: el("disable-coverart-embedding").checked,
      eject_on_success: el("eject-on-success").checked,
      find_drive_offset: el("find-drive-offset").checked,
      print_version: el("print-version").checked,
      show_help: el("show-help").checked,
    };
  }

  function getSelectedOutputs() {
    const selected = [];
    document.querySelectorAll("input[data-role='output']").forEach((node) => {
      if (node.checked) {
        selected.push(node.value);
      }
    });
    return selected;
  }

  function parsePregapRules(rawText) {
    const rules = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const parts = line.split("=");
      if (parts.length !== 2) {
        throw new Error(t("error.pregapFormat", { line: lineNumber }));
      }

      const track = toInt(parts[0].trim(), t("error.trackLabel"));
      const action = parts[1].trim();
      if (!action) {
        throw new Error(t("error.pregapActionMissing", { line: lineNumber }));
      }

      rules.push({ track, action });
    });

    return rules;
  }

  function parseTrackMetadata(rawText) {
    const entries = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const equalsPos = line.indexOf("=");
      if (equalsPos <= 0 || equalsPos === line.length - 1) {
        throw new Error(t("error.trackMetadataFormat", { line: lineNumber }));
      }

      const trackRaw = line.slice(0, equalsPos).trim();
      const metadata = line.slice(equalsPos + 1).trim();
      const track = toInt(trackRaw, t("error.trackLabel"));
      entries.push({ track, metadata });
    });

    return entries;
  }

  function parseCoverArts(rawText) {
    const entries = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const equalsPos = line.indexOf("=");
      if (equalsPos < 0) {
        entries.push({ source: line.trim() });
        return;
      }

      if (equalsPos === 0 || equalsPos === line.length - 1) {
        throw new Error(t("error.coverArtFormat", { line: lineNumber }));
      }

      const left = line.slice(0, equalsPos).trim();
      const right = line.slice(equalsPos + 1).trim();
      if (!left || !right) {
        throw new Error(t("error.coverArtIncomplete", { line: lineNumber }));
      }

      if (looksLikeCoverDestination(left)) {
        entries.push({ destination: left, source: right });
      } else {
        entries.push({ source: line.trim() });
      }
    });

    return entries;
  }

  function looksLikeCoverDestination(raw) {
    if (/^\d+$/.test(raw)) {
      return true;
    }
    return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(raw);
  }

  function parseTrackSelection(rawText) {
    if (!rawText || !rawText.trim()) {
      return [];
    }

    return rawText
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => toInt(part, t("error.trackLabel")));
  }

  function normalizeTrackSelection(value) {
    if (!value) {
      return [];
    }

    const arr = Array.isArray(value) ? value : [value];
    const unique = new Set();
    arr.forEach((item) => {
      const num = Number.parseInt(String(item), 10);
      if (!Number.isNaN(num) && num > 0) {
        unique.add(num);
      }
    });

    return Array.from(unique).sort((a, b) => a - b);
  }

  function eachNonEmptyLine(rawText, callback) {
    const lines = String(rawText || "").split(/\r?\n/);
    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }
      callback(line, idx + 1);
    });
  }

  function intOrNull(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    if (!text) {
      return null;
    }

    return toInt(text, t("error.integer"));
  }

  function floatOrNull(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    if (!text) {
      return null;
    }

    const parsed = Number.parseFloat(text);
    if (Number.isNaN(parsed)) {
      throw new Error(t("error.float", { value: text }));
    }

    return parsed;
  }

  function toInt(raw, label) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(t("error.integerLabel", { label }));
    }

    return parsed;
  }

  function normalizeOptionalInt(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    if (Number.isNaN(parsed)) {
      return null;
    }

    return parsed;
  }

  async function apiPost(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    return parseApiResponse(response);
  }

  async function apiGet(url) {
    const response = await fetch(url);
    return parseApiResponse(response);
  }

  async function parseApiResponse(response) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return {};
    }

    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    return payload;
  }

  function setMessage(id, message) {
    el(id).textContent = message || "";
  }

  function showError(message) {
    el("error-box").textContent = message || "";
  }

  function clearError() {
    showError("");
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? "" : value;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getCookie(name) {
    const target = `${encodeURIComponent(name)}=`;
    const parts = document.cookie ? document.cookie.split(";") : [];

    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (part.startsWith(target)) {
        return decodeURIComponent(part.slice(target.length));
      }
    }

    return null;
  }

  function setCookie(name, value, days = 365) {
    const maxAge = Math.max(0, Math.floor(days * 24 * 60 * 60));
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}; path=/; max-age=${maxAge}; samesite=lax`;
  }

  initialize().catch((error) => {
    showError(error && error.message ? error.message : String(error));
  });
})();

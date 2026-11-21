// content.js — TruePlacement content script
//
// Select text on any page to show the TruePlacement scanner.
// The script is designed to survive extension reloads gracefully.
// If Chrome invalidates the extension context, the page widget is
// silently removed instead of producing "Uncaught (in promise)"
// Extension context invalidated errors.

(() => {
  "use strict";

  const MIN_SELECTION_LENGTH = 30;
  const CARD_WIDTH = 320;

  // ============================================================
  // ICONS
  // ============================================================

  const ICONS = {
    check: `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M4.5 12.5l5 5L19.5 7"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `,

    warn: `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3.2L22 20.8H2L12 3.2z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
        />
        <path
          d="M12 9.8v4.6"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
        <circle
          cx="12"
          cy="17.3"
          r="1"
          fill="currentColor"
        />
      </svg>
    `,

    close: `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    `,

    shield: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />
        <path d="M9 12l2 2l4 -4" />
      </svg>
    `,

    grip: `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="1.6" />
        <circle cx="15" cy="6" r="1.6" />
        <circle cx="9" cy="12" r="1.6" />
        <circle cx="15" cy="12" r="1.6" />
        <circle cx="9" cy="18" r="1.6" />
        <circle cx="15" cy="18" r="1.6" />
      </svg>
    `,

    openPanel: `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M9 6h9v9"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M18 6L8 16"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <path
          d="M13 6H6.5A1.5 1.5 0 005 7.5V17.5A1.5 1.5 0 006.5 19h10A1.5 1.5 0 0018 17.5V11"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `
  };

  // ============================================================
  // HTML ESCAPING
  // ============================================================

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
    );
  }

  // ============================================================
  // EXTENSION LIFECYCLE
  // ============================================================

  let invalidated = false;

  let shadowRoot = null;
  let toolbarEl = null;
  let cardEl = null;
  let pendingRange = null;
  let debounceTimer = null;

  /**
   * Chrome can invalidate an extension context when:
   *
   * - the extension is reloaded
   * - the extension is updated
   * - the extension is removed/reinstalled
   *
   * The old content script may still exist inside an already-open page.
   *
   * Calling chrome.runtime APIs from that old script can then produce:
   *
   * "Extension context invalidated."
   */

  function isContextAlive() {
    if (invalidated) {
      return false;
    }

    try {
      return Boolean(
        chrome &&
        chrome.runtime &&
        chrome.runtime.id
      );
    } catch (error) {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    if (!error) {
      return false;
    }

    let message = "";

    try {
      message =
        error.message ||
        error.reason ||
        String(error);
    } catch (_) {
      return false;
    }

    return (
      typeof message === "string" &&
      message.toLowerCase().includes(
        "extension context invalidated"
      )
    );
  }

  /**
   * Safely obtain an extension resource URL.
   *
   * This is one of the main APIs that can throw after an
   * extension reload.
   */
  function safeExtensionUrl(path) {
    if (!isContextAlive()) {
      return "";
    }

    try {
      return chrome.runtime.getURL(path);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        invalidateExtension();
      }

      return "";
    }
  }

  /**
   * Safely communicate with the background service worker.
   */
  function safeSendMessage(message) {
    if (!isContextAlive()) {
      return;
    }

    try {
      const result = chrome.runtime.sendMessage(message);

      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (isContextInvalidatedError(error)) {
            invalidateExtension();
          }
        });
      }
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        invalidateExtension();
      }
    }
  }

  /**
   * Remove all UI/listeners belonging to this old content script.
   */
  function invalidateExtension() {
    if (invalidated) {
      return;
    }

    invalidated = true;

    try {
      teardown();
    } catch (_) {
      // Ignore cleanup errors.
    }
  }

  function teardown() {
    clearTimeout(debounceTimer);
    debounceTimer = null;

    try {
      document.removeEventListener(
        "mouseup",
        handleMouseUp,
        true
      );
    } catch (_) {}

    try {
      document.removeEventListener(
        "mousedown",
        handleMouseDown,
        true
      );
    } catch (_) {}

    try {
      document.removeEventListener(
        "keydown",
        handleKeyDown,
        true
      );
    } catch (_) {}

    try {
      window.removeEventListener(
        "scroll",
        handleScroll,
        true
      );
    } catch (_) {}

    const host = document.getElementById(
      "trueplacement-host"
    );

    if (host && host.parentNode) {
      try {
        host.parentNode.removeChild(host);
      } catch (_) {}
    }

    shadowRoot = null;
    toolbarEl = null;
    cardEl = null;
    pendingRange = null;
  }

  // ============================================================
  // SHADOW DOM
  // ============================================================

  function ensureShadow() {
    if (invalidated) {
      return null;
    }

    if (shadowRoot) {
      return shadowRoot;
    }

    if (!isContextAlive()) {
      invalidateExtension();
      return null;
    }

    const existingHost = document.getElementById(
      "trueplacement-host"
    );

    if (existingHost) {
      try {
        existingHost.remove();
      } catch (_) {}
    }

    const host = document.createElement("div");

    host.id = "trueplacement-host";

    host.style.position = "fixed";
    host.style.left = "0";
    host.style.top = "0";
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";

    document.documentElement.appendChild(host);

    try {
      shadowRoot = host.attachShadow({
        mode: "open"
      });
    } catch (error) {
      try {
        host.remove();
      } catch (_) {}

      return null;
    }

    // ----------------------------------------------------------
    // CSS
    // ----------------------------------------------------------

    const style = document.createElement("style");

    shadowRoot.appendChild(style);

    const cssUrl = safeExtensionUrl(
      "content.css"
    );

    if (cssUrl) {
      fetch(cssUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(
              `CSS request failed: ${response.status}`
            );
          }

          return response.text();
        })
        .then((css) => {
          if (!invalidated && style) {
            style.textContent = css;
          }
        })
        .catch((error) => {
          if (isContextInvalidatedError(error)) {
            invalidateExtension();
          }
        });
    }

    // ----------------------------------------------------------
    // ROOT
    // ----------------------------------------------------------

    const root = document.createElement("div");

    root.className = "tp-root";

    shadowRoot.appendChild(root);

    // ----------------------------------------------------------
    // TOOLBAR
    // ----------------------------------------------------------

    toolbarEl = document.createElement("div");

    toolbarEl.className = "tp-toolbar";

    toolbarEl.innerHTML = `
      <button
        type="button"
        class="tp-ask-btn"
      >
        <span class="tp-ask-icon" aria-hidden="true">${ICONS.shield}</span>
        <span>Ask TruePlacement</span>
      </button>
    `;

    root.appendChild(toolbarEl);

    toolbarEl.addEventListener(
      "mousedown",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      }
    );

    const askButton = toolbarEl.querySelector(
      ".tp-ask-btn"
    );

    if (askButton) {
      askButton.addEventListener(
        "click",
        onScanClick
      );
    }

    // ----------------------------------------------------------
    // CARD
    // ----------------------------------------------------------

    cardEl = document.createElement("div");

    cardEl.className = "tp-card";

    root.appendChild(cardEl);

    cardEl.addEventListener(
      "mousedown",
      (event) => {
        event.stopPropagation();
      }
    );

    attachCardDragHandlers();

    return shadowRoot;
  }

  // ============================================================
  // DRAG TO MOVE
  // ============================================================

  let cardDragging = false;
  let cardUserPositioned = false;
  let cardDragOffsetX = 0;
  let cardDragOffsetY = 0;

  function attachCardDragHandlers() {
    if (!cardEl) {
      return;
    }

    cardEl.addEventListener("pointerdown", (event) => {
      const head = event.target.closest(".tp-card-head");

      if (!head || event.target.closest(".tp-card-close")) {
        return;
      }

      cardDragging = true;
      cardUserPositioned = true;

      const box = cardEl.getBoundingClientRect();
      cardDragOffsetX = event.clientX - box.left;
      cardDragOffsetY = event.clientY - box.top;

      cardEl.classList.add("tp-dragging");

      try {
        cardEl.setPointerCapture(event.pointerId);
      } catch (_) {}
    });

    cardEl.addEventListener("pointermove", (event) => {
      if (!cardDragging) {
        return;
      }

      const margin = 6;
      const maxLeft = window.innerWidth - cardEl.offsetWidth - margin;
      const maxTop = window.innerHeight - cardEl.offsetHeight - margin;

      let left = event.clientX - cardDragOffsetX;
      let top = event.clientY - cardDragOffsetY;

      left = Math.min(Math.max(margin, left), Math.max(margin, maxLeft));
      top = Math.min(Math.max(margin, top), Math.max(margin, maxTop));

      cardEl.style.left = `${left}px`;
      cardEl.style.top = `${top}px`;
    });

    function endDrag(event) {
      if (!cardDragging) {
        return;
      }

      cardDragging = false;
      cardEl.classList.remove("tp-dragging");

      try {
        cardEl.releasePointerCapture(event.pointerId);
      } catch (_) {}
    }

    cardEl.addEventListener("pointerup", endDrag);
    cardEl.addEventListener("pointercancel", endDrag);
  }

  // ============================================================
  // TOOLBAR
  // ============================================================

  function positionToolbar(rect) {
    if (
      invalidated ||
      !toolbarEl ||
      !rect
    ) {
      return;
    }

    const toolbarWidth = 190;

    const top =
      rect.top > 56
        ? rect.top - 40
        : rect.bottom + 10;

    const left = Math.max(
      10,
      Math.min(
        rect.left,
        window.innerWidth -
          toolbarWidth -
          10
      )
    );

    try {
      toolbarEl.style.top =
        `${Math.max(10, top)}px`;

      toolbarEl.style.left =
        `${left}px`;
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        invalidateExtension();
      }
    }
  }

  function showToolbar(text, rect) {
    if (invalidated) {
      return;
    }

    if (!ensureShadow()) {
      return;
    }

    if (!toolbarEl) {
      return;
    }

    pendingRange = {
      text,
      rect
    };

    positionToolbar(rect);

    toolbarEl.classList.add(
      "tp-show"
    );
  }

  function hideToolbar() {
    if (toolbarEl) {
      try {
        toolbarEl.classList.remove(
          "tp-show"
        );
      } catch (_) {}
    }

    pendingRange = null;
  }

  // ============================================================
  // CARD POSITION
  // ============================================================

  function positionCard(rect) {
    if (
      invalidated ||
      !cardEl ||
      !rect
    ) {
      return;
    }

    // Once the user has dragged the card, leave it exactly where
    // they put it -- don't snap it back on re-render (loading ->
    // result) or on scroll.
    if (cardUserPositioned) {
      return;
    }

    const margin = 10;

    let top =
      rect.bottom + margin;

    let left = Math.max(
      margin,
      Math.min(
        rect.left,
        window.innerWidth -
          CARD_WIDTH -
          margin
      )
    );

    try {
      cardEl.style.width =
        `${CARD_WIDTH}px`;

      cardEl.style.left =
        `${left}px`;

      cardEl.style.top =
        `${top}px`;
    } catch (_) {
      return;
    }

    requestAnimationFrame(() => {
      if (
        invalidated ||
        !cardEl
      ) {
        return;
      }

      try {
        const height =
          cardEl.offsetHeight;

        if (
          top + height >
          window.innerHeight - margin
        ) {
          top = Math.max(
            margin,
            rect.top -
              height -
              margin
          );

          if (
            top + height >
            window.innerHeight -
              margin
          ) {
            top = Math.max(
              margin,
              window.innerHeight -
                height -
                margin
            );
          }
        }

        cardEl.style.top =
          `${top}px`;
      } catch (_) {}
    });
  }

  function openCard(rect) {
    if (invalidated) {
      return false;
    }

    if (!ensureShadow()) {
      return false;
    }

    if (!cardEl) {
      return false;
    }

    positionCard(rect);

    cardEl.classList.add(
      "tp-show"
    );

    return true;
  }

  function closeCard() {
    if (!cardEl) {
      return;
    }

    try {
      cardEl.classList.remove(
        "tp-show"
      );
    } catch (_) {}
  }

  // ============================================================
  // CARD HEADER
  // ============================================================

  function cardHeader() {
    const iconUrl = safeExtensionUrl(
      "icons/icon32.png"
    );

    return `
      <div class="tp-card-head" title="Drag to move">

        <span class="tp-drag-grip" aria-hidden="true">
          ${ICONS.grip}
        </span>

        <div class="tp-card-brand">

          ${
            iconUrl
              ? `<img
                   src="${iconUrl}"
                   alt=""
                 />`
              : ""
          }

          <span>
            TruePlacement
          </span>

        </div>

        <button
          type="button"
          class="tp-card-close"
          aria-label="Close"
        >
          ${ICONS.close}
        </button>

      </div>
    `;
  }

  // ============================================================
  // LOADING UI
  // ============================================================

  function loadingHtml() {
    return `
      ${cardHeader()}

      <div class="tp-loading-row">

        <div class="tp-spinner"></div>

        <div>

          <b>
            Checking this posting
          </b>

          <small>
            Running the on-device model —
            this stays in your browser.
          </small>

        </div>

      </div>
    `;
  }

  // ============================================================
  // SCAN
  // ============================================================

  function onScanClick() {
    if (
      invalidated ||
      !pendingRange
    ) {
      return;
    }

    const text =
      pendingRange.text;

    const rect =
      pendingRange.rect;

    hideToolbar();

    openCardAndScan(
      text,
      rect
    );
  }

  async function openCardAndScan(
    text,
    rect
  ) {
    // A brand new selection/scan always starts freshly anchored
    // to the selected text, even if a previous card was dragged.
    cardUserPositioned = false;

    if (
      invalidated ||
      !openCard(rect)
    ) {
      return;
    }

    if (!cardEl) {
      return;
    }

    cardEl.innerHTML =
      loadingHtml();

    cardEl.classList.remove(
      "tp-card-fraud",
      "tp-card-real"
    );

    const closeButton =
      cardEl.querySelector(
        ".tp-card-close"
      );

    if (closeButton) {
      closeButton.addEventListener(
        "click",
        closeCard
      );
    }

    positionCard(rect);

    try {
      if (
        typeof TruePlacementModel ===
        "undefined"
      ) {
        throw new Error(
          "TruePlacementModel is not available."
        );
      }

      const analysisPromise =
        TruePlacementModel.analyze(
          text,
          {}
        );

      const delayPromise =
        new Promise((resolve) => {
          setTimeout(
            resolve,
            320
          );
        });

      const [
        result
      ] = await Promise.all([
        analysisPromise,
        delayPromise
      ]);

      if (
        invalidated ||
        !cardEl
      ) {
        return;
      }

      renderCard(
        result,
        rect,
        text
      );

    } catch (error) {
      if (
        isContextInvalidatedError(
          error
        )
      ) {
        invalidateExtension();
        return;
      }

      if (
        invalidated ||
        !cardEl
      ) {
        return;
      }

      console.error(
        "TruePlacement analysis error:",
        error
      );

      cardEl.innerHTML = `
        ${cardHeader()}

        <div class="tp-error">
          Couldn't analyze that text.
          Try selecting it again.
        </div>
      `;

      const closeBtn =
        cardEl.querySelector(
          ".tp-card-close"
        );

      if (closeBtn) {
        closeBtn.addEventListener(
          "click",
          closeCard
        );
      }

      positionCard(rect);
    }
  }

  // ============================================================
  // RESULT CARD
  // ============================================================

  function renderCard(
    result,
    rect,
    text
  ) {
    if (
      invalidated ||
      !cardEl ||
      !result
    ) {
      return;
    }

    const isFraud =
      result.prediction === 1;

    const kind =
      isFraud
        ? "fraud"
        : "real";

    const pct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          Number(
            result.confidence || 0
          ) * 100
        )
      )
    );

    const title =
      isFraud
        ? "Likely fraudulent"
        : "Looks genuine";

    const icon =
      isFraud
        ? ICONS.warn
        : ICONS.check;

    const confLabel =
      result.overridden
        ? "confidence (pre-override)"
        : "confidence";

    const caption =
      isFraud
        ? "The wording and details of this posting match common scam patterns."
        : "Nothing in the wording or details raised a strong red flag.";

    let html =
      cardHeader();

    html += `
      <div
        class="tp-verdict
               tp-verdict-${kind}"
      >

        <div class="tp-verdict-icon">
          ${icon}
        </div>

        <div class="tp-verdict-body">

          <div class="tp-verdict-eyebrow">
            Verdict
          </div>

          <div class="tp-verdict-title">
            ${title}
          </div>

        </div>

        <div class="tp-verdict-pct">
          ${pct}<span>%</span>
        </div>

      </div>

      <div class="tp-confidence">
        <i
          style="width:${pct}%"
        ></i>
      </div>

      <div class="tp-verdict-foot">

        <span>
          ${confLabel}
        </span>

        <span class="tp-verdict-caption">
          ${escapeHtml(caption)}
        </span>

      </div>
    `;

    if (result.outOfDomain) {
      html += `
        <div class="tp-note tp-note-caution">
          This text doesn't read much like a
          job posting — treat this verdict as
          unreliable.
        </div>
      `;
    }

    if (result.overridden) {
      html += `
        <div class="tp-note tp-note-brand">
          The model leaned genuine, but this
          text requests a fee or deposit —
          a near-certain scam signal — so
          the verdict was changed.
        </div>
      `;
    }

    html += `
      <button
        type="button"
        class="tp-open-report"
        data-open-report
      >

        <span>
          Show full report
        </span>

        ${ICONS.openPanel}

      </button>

      <div class="tp-card-footer">
        TF-IDF + Linear SVM,
        on-device inference
      </div>
    `;

    cardEl.innerHTML =
      html;

    cardEl.classList.toggle(
      "tp-card-fraud",
      isFraud
    );
    cardEl.classList.toggle(
      "tp-card-real",
      !isFraud
    );

    const closeButton =
      cardEl.querySelector(
        ".tp-card-close"
      );

    if (closeButton) {
      closeButton.addEventListener(
        "click",
        closeCard
      );
    }

    const reportButton =
      cardEl.querySelector(
        "[data-open-report]"
      );

    if (reportButton) {
      reportButton.addEventListener(
        "click",
        () => {
          openFullReport(text);
          closeCard();
        }
      );
    }

    positionCard(rect);
  }

  // ============================================================
  // OPEN FULL REPORT
  // ============================================================

  function openFullReport(text) {
    if (
      invalidated ||
      !text
    ) {
      return;
    }

    safeSendMessage({
      type:
        "trueplacement:open-full-report",
      text
    });
  }

  // ============================================================
  // MOUSE EVENTS
  // ============================================================

  function isInsideWidget(event) {
    if (
      !event ||
      !event.composedPath
    ) {
      return false;
    }

    const path =
      event.composedPath();

    return path.some(
      (node) =>
        node === toolbarEl ||
        node === cardEl ||
        node === shadowRoot
    );
  }

  function handleMouseUp(event) {
    if (invalidated) {
      return;
    }

    if (isInsideWidget(event)) {
      return;
    }

    clearTimeout(
      debounceTimer
    );

    debounceTimer =
      setTimeout(() => {
        if (invalidated) {
          return;
        }

        let selection;

        try {
          selection =
            window.getSelection();
        } catch (_) {
          return;
        }

        const text =
          selection
            ? selection
                .toString()
                .trim()
            : "";

        if (
          !text ||
          text.length <
            MIN_SELECTION_LENGTH
        ) {
          hideToolbar();
          return;
        }

        if (
          !selection ||
          selection.rangeCount === 0
        ) {
          return;
        }

        let range;

        try {
          range =
            selection.getRangeAt(0);
        } catch (_) {
          return;
        }

        let rect;

        try {
          rect =
            range.getBoundingClientRect();
        } catch (_) {
          return;
        }

        if (!rect) {
          return;
        }

        if (
          rect.width === 0 &&
          rect.height === 0
        ) {
          return;
        }

        showToolbar(
          text,
          rect
        );
      }, 160);
  }

  function handleMouseDown(event) {
    if (invalidated) {
      return;
    }

    if (isInsideWidget(event)) {
      return;
    }

    hideToolbar();
    closeCard();
  }

  function handleKeyDown(event) {
    if (invalidated) {
      return;
    }

    if (
      event.key === "Escape"
    ) {
      hideToolbar();
      closeCard();
    }
  }

  function handleScroll() {
    if (invalidated) {
      return;
    }

    // Only hide the selection toolbar.
    // An already-open result card remains visible.
    hideToolbar();
  }

  // ============================================================
  // EVENT LISTENERS
  // ============================================================

  document.addEventListener(
    "mouseup",
    handleMouseUp,
    true
  );

  document.addEventListener(
    "mousedown",
    handleMouseDown,
    true
  );

  document.addEventListener(
    "keydown",
    handleKeyDown,
    true
  );

  window.addEventListener(
    "scroll",
    handleScroll,
    true
  );

  // ============================================================
  // GLOBAL ERROR HANDLING
  // ============================================================

  /**
   * If Chrome invalidates this content script's extension
   * context, rejected promises can otherwise appear as:
   *
   * Uncaught (in promise) Error:
   * Extension context invalidated.
   *
   * Catch those globally and clean up.
   */

  window.addEventListener(
    "unhandledrejection",
    (event) => {
      if (
        isContextInvalidatedError(
          event.reason
        )
      ) {
        event.preventDefault();
        invalidateExtension();
      }
    }
  );

  window.addEventListener(
    "error",
    (event) => {
      if (
        isContextInvalidatedError(
          event.error
        ) ||
        isContextInvalidatedError(
          event.message
        )
      ) {
        event.preventDefault();
        invalidateExtension();
      }
    }
  );

  // ============================================================
  // INITIAL CONTEXT CHECK
  // ============================================================

  if (!isContextAlive()) {
    invalidateExtension();
  }

})();
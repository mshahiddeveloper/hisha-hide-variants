(() => {
  "use strict";

  const VERSION = "0.7.0";
  const HIDDEN_CARD_CLASS = "hisha-hidden-product-card";
  const HIDDEN_OPTION_CLASS = "hisha-hidden-variant-option";
  const PREPAINT_CLASS = "hisha-variants-pending";
  const MAX_FALLBACK_PRODUCT_REQUESTS = 8;
  const MAX_CONCURRENT_PRODUCT_REQUESTS = 2;
  const PRODUCT_LINK_PATTERN = /(?:^|\/)products\/([^/?#]+)/i;
  const CARD_SELECTORS = [
    "[data-product-card]",
    "product-card",
    ".product-card-wrapper",
    ".product-card",
    ".product-item",
    ".product-grid-item",
    ".card-wrapper",
    ".predictive-search__list-item",
    'li[class*="product"]',
    'article[class*="product"]',
  ].join(",");
  const OPTION_CONTROL_SELECTORS = [
    'select[name^="options["]',
    'input[type="radio"][name^="options["]',
    "variant-selects select",
    'variant-selects input[type="radio"]',
    "variant-radios select",
    'variant-radios input[type="radio"]',
    "[data-variant-picker] select",
    '[data-variant-picker] input[type="radio"]',
    ".product-form__input select",
    '.product-form__input input[type="radio"]',
  ].join(",");

  const readJson = (selector, fallback) => {
    const element = document.querySelector(selector);

    if (!element) return fallback;

    try {
      return JSON.parse(element.textContent || "");
    } catch {
      return fallback;
    }
  };

  const DEFAULT_SETTINGS = {
    entitled: false,
    entitlementValidUntil: null,
    hideSoldOutVariants: true,
    hideFullySoldOutProducts: false,
    manualHiddenProductIds: [],
    manualShownProductIds: [],
    manualHiddenVariantIds: [],
    manualShownVariantIds: [],
  };
  let settings = { ...DEFAULT_SETTINGS };
  let context = {};
  let product = null;
  let rootUrl = "/";
  let manualHiddenProductIds = new Set();
  let manualShownProductIds = new Set();
  let manualHiddenVariantIds = new Set();
  let manualShownVariantIds = new Set();
  let pageProducts = new Map();
  const productCache = new Map();
  const requestQueue = [];
  let activeRequests = 0;
  let fallbackRequestsStarted = 0;
  let applyingVariant = false;
  let cardScanQueued = false;
  let variantRefreshQueued = false;

  const shopifyNumericId = (value) =>
    String(value ?? "")
      .trim()
      .split("/")
      .pop();

  const normalizedIdSet = (values) =>
    new Set(
      (Array.isArray(values) ? values : [])
        .map(shopifyNumericId)
        .filter(Boolean),
    );

  const hydratePageData = () => {
    settings = {
      ...DEFAULT_SETTINGS,
      ...readJson("[data-hisha-settings]", {}),
    };
    context = readJson("[data-hisha-context]", {});
    product = readJson("[data-hisha-product]", null);
    pageProducts = new Map(
      readJson("[data-hisha-page-products]", [])
        .filter((item) => item?.handle)
        .map((item) => [String(item.handle).toLocaleLowerCase(), item]),
    );
    rootUrl = context.rootUrl || window.Shopify?.routes?.root || "/";
    manualHiddenProductIds = normalizedIdSet(settings.manualHiddenProductIds);
    manualShownProductIds = normalizedIdSet(settings.manualShownProductIds);
    manualHiddenVariantIds = normalizedIdSet(settings.manualHiddenVariantIds);
    manualShownVariantIds = normalizedIdSet(settings.manualShownVariantIds);
  };

  const releaseVariantPrepaint = () => {
    document.documentElement.classList.remove(PREPAINT_CLASS);
  };

  const hasValidEntitlementLease = () => {
    if (settings.entitled !== true) return false;

    const validUntil = Date.parse(String(settings.entitlementValidUntil ?? ""));
    return Number.isFinite(validUntil) && validUntil > Date.now();
  };

  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .toLocaleLowerCase();

  const isSoldOut = (productData) => {
    if (!productData) return false;
    if (productData.available === false) return true;

    return (
      Array.isArray(productData.variants) &&
      productData.variants.length > 0 &&
      productData.variants.every((variant) => variant.available === false)
    );
  };

  const manuallyHidesEveryAvailableVariant = (productData) => {
    const availableVariants = (productData?.variants || []).filter(
      (variant) => variant.available !== false,
    );

    return (
      availableVariants.length > 0 &&
      availableVariants.every((variant) =>
        manualHiddenVariantIds.has(shopifyNumericId(variant.id)) &&
        !manualShownVariantIds.has(shopifyNumericId(variant.id)),
      )
    );
  };

  const hasManuallyShownVariant = (productData) =>
    (productData?.variants || []).some((variant) =>
      manualShownVariantIds.has(shopifyNumericId(variant.id)),
    );

  const shouldHideProduct = (productData) =>
    Boolean(
      productData &&
      !manualShownProductIds.has(shopifyNumericId(productData.id)) &&
      !hasManuallyShownVariant(productData) &&
      (manualHiddenProductIds.has(shopifyNumericId(productData.id)) ||
        manuallyHidesEveryAvailableVariant(productData) ||
        (settings.hideFullySoldOutProducts && isSoldOut(productData))),
    );

  const productPathFromLink = (anchor) => {
    try {
      const url = new URL(anchor.href, window.location.origin);

      if (url.origin !== window.location.origin) return null;

      const match = PRODUCT_LINK_PATTERN.exec(url.pathname);
      if (!match) return null;

      return {
        handle: decodeURIComponent(match[1]),
        path: url.pathname.slice(0, (match.index ?? 0) + match[0].length),
      };
    } catch {
      return null;
    }
  };

  const runQueuedRequests = () => {
    while (
      activeRequests < MAX_CONCURRENT_PRODUCT_REQUESTS &&
      requestQueue.length
    ) {
      const task = requestQueue.shift();
      activeRequests += 1;

      task()
        .catch(() => undefined)
        .finally(() => {
          activeRequests -= 1;
          runQueuedRequests();
        });
    }
  };

  const loadProduct = (path) => {
    if (productCache.has(path)) return productCache.get(path);
    if (fallbackRequestsStarted >= MAX_FALLBACK_PRODUCT_REQUESTS) {
      return Promise.resolve(null);
    }

    fallbackRequestsStarted += 1;

    const pending = new Promise((resolve) => {
      requestQueue.push(async () => {
        try {
          const response = await fetch(`${path}.js`, {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });

          resolve(response.ok ? await response.json() : null);
        } catch {
          resolve(null);
        }
      });
      runQueuedRequests();
    });

    productCache.set(path, pending);
    return pending;
  };

  const hideProductCard = (anchor) => {
    const card =
      anchor.closest(
        "li.grid__item,li.productgrid--item,.predictive-search__list-item,[data-product-item]",
      ) || anchor.closest(CARD_SELECTORS);
    if (card) card.classList.add(HIDDEN_CARD_CLASS);
  };

  const scanProductCards = () => {
    if (
      !settings.hideFullySoldOutProducts &&
      !manualHiddenProductIds.size &&
      !manualHiddenVariantIds.size
    ) {
      return;
    }

    const anchors = document.querySelectorAll(
      'a[href*="/products/"]:not([data-hisha-product-checked])',
    );

    anchors.forEach((anchor) => {
      anchor.dataset.hishaProductChecked = "true";
      const linkedProduct = productPathFromLink(anchor);

      if (!linkedProduct) return;
      if (product?.handle === linkedProduct.handle) return;
      if (!anchor.closest(CARD_SELECTORS)) return;

      const pageProduct = pageProducts.get(
        linkedProduct.handle.toLocaleLowerCase(),
      );
      if (pageProduct) {
        if (pageProduct.hidden) hideProductCard(anchor);
        return;
      }

      loadProduct(linkedProduct.path).then((productData) => {
        if (shouldHideProduct(productData)) hideProductCard(anchor);
      });
    });
  };

  const getProductScope = () => {
    const variantInput = document.querySelector(
      'main form[action*="/cart/add"] [name="id"], main [name="id"]',
    );

    return (
      variantInput?.closest(
        "product-info,main-product,[data-section-type='product'],section,.product",
      ) ||
      document.querySelector("main") ||
      document
    );
  };

  const optionNames = () =>
    (product?.options || []).map((option) =>
      typeof option === "string" ? option : option.name,
    );

  const normalizedVariants = () =>
    (product?.variants || []).map((variant) => ({
      id: String(variant.id),
      available:
        manualShownVariantIds.has(shopifyNumericId(variant.id)) ||
        (!manualHiddenVariantIds.has(shopifyNumericId(variant.id)) &&
          (settings.hideSoldOutVariants ? variant.available !== false : true)),
      options:
        variant.options ||
        [variant.option1, variant.option2, variant.option3].filter(
          (value) => value != null,
        ),
    }));

  const buildOptionGroups = (scope) => {
    const names = optionNames();
    const controls = Array.from(
      scope.querySelectorAll(OPTION_CONTROL_SELECTORS),
    ).filter((control) => control.name !== "id");
    const controlNames = [
      ...new Set(controls.map((control) => control.name.trim())),
    ];
    const groups = new Map();

    controls.forEach((control) => {
      const controlName = control.name.trim();
      const bracketName = controlName.match(/^options\[(.*)]$/)?.[1];
      const name = bracketName || controlName.replace(/-\d+$/, "");
      let index = names.findIndex(
        (optionName) => normalize(optionName) === normalize(name),
      );

      const declaredPosition = Number(
        control.dataset.optionPosition ||
          control.dataset.optionIndex ||
          control.dataset.index?.match(/\d+/)?.[0],
      );

      if (index < 0 && Number.isInteger(declaredPosition)) {
        index = declaredPosition > 0 ? declaredPosition - 1 : declaredPosition;
      }
      if (index < 0) index = controlNames.indexOf(controlName);
      if (index < 0) return;

      const group = groups.get(index) || { controls: [], name };
      group.controls.push(control);
      groups.set(index, group);
    });

    return groups;
  };

  const selectedOptions = (groups, variants, scope) => {
    const selected = {};

    groups.forEach((group, index) => {
      const select = group.controls.find(
        (control) => control.tagName === "SELECT",
      );
      const radio = group.controls.find((control) => control.checked);
      const value = radio?.value ?? select?.value;
      if (value) selected[index] = value;
    });

    const variantId = selectedVariantId(scope, variants);
    const selectedVariant = variants.find(
      (variant) => variant.id === String(variantId),
    );

    selectedVariant?.options.forEach((value, index) => {
      if (!selected[index]) selected[index] = value;
    });

    return selected;
  };

  const selectedVariantId = (scope, variants) => {
    const variantIds = new Set(variants.map((variant) => variant.id));

    return Array.from(
      scope.querySelectorAll('select[name="id"],input[name="id"]'),
    ).find((control) => {
      if (control instanceof HTMLInputElement) {
        const type = control.type.toLocaleLowerCase();
        if ((type === "radio" || type === "checkbox") && !control.checked) {
          return false;
        }
      }

      return variantIds.has(String(control.value));
    })?.value;
  };

  const matchingVariant = (variants, selected) =>
    variants.find((variant) =>
      variant.options.every(
        (value, index) =>
          !selected[index] || normalize(value) === normalize(selected[index]),
      ),
    );

  const closestAvailableVariant = (variants, selected) => {
    const availableVariants = variants.filter((variant) => variant.available);
    const optionCount = Math.max(
      0,
      ...availableVariants.map((variant) => variant.options.length),
    );

    for (let prefixLength = optionCount; prefixLength >= 0; prefixLength -= 1) {
      const match = availableVariants.find((variant) =>
        variant.options
          .slice(0, prefixLength)
          .every(
            (value, index) =>
              !selected[index] ||
              normalize(value) === normalize(selected[index]),
          ),
      );

      if (match) return match;
    }

    return null;
  };

  const setAppDisabled = (control, unavailable) => {
    if (unavailable && !control.disabled) {
      control.disabled = true;
      control.dataset.hishaDisabled = "true";
    } else if (!unavailable && control.dataset.hishaDisabled === "true") {
      control.disabled = false;
      delete control.dataset.hishaDisabled;
    }
  };

  const setOptionVisibility = (option, available) => {
    if (!available && !option.hidden) {
      option.hidden = true;
      option.dataset.hishaHidden = "true";
    } else if (available && option.dataset.hishaHidden === "true") {
      option.hidden = false;
      delete option.dataset.hishaHidden;
    }

    setAppDisabled(option, !available);
  };

  const syncVariantIdControls = (scope, variants, variant) => {
    const variantIds = new Set(variants.map((candidate) => candidate.id));
    const changedVariantControls = [];

    scope
      .querySelectorAll('select[name="id"],input[name="id"]')
      .forEach((control) => {
        if (control instanceof HTMLSelectElement) {
          if (
            !Array.from(control.options).some(
              (option) => String(option.value) === variant.id,
            )
          ) {
            return;
          }

          if (String(control.value) !== variant.id) {
            control.value = variant.id;
            changedVariantControls.push(control);
          }
          return;
        }

        if (!(control instanceof HTMLInputElement)) return;

        const type = control.type.toLocaleLowerCase();
        if (type === "radio" || type === "checkbox") {
          if (!variantIds.has(String(control.value))) return;

          const shouldCheck = String(control.value) === variant.id;
          if (control.checked !== shouldCheck) {
            control.checked = shouldCheck;
            if (shouldCheck) changedVariantControls.push(control);
          }
          return;
        }

        if (type !== "hidden" && type !== "text") return;
        if (!control.form?.action.includes("/cart/add")) return;
        if (control.value && !variantIds.has(String(control.value))) return;

        if (String(control.value) !== variant.id) {
          control.value = variant.id;
          changedVariantControls.push(control);
        }
      });

    changedVariantControls.forEach((control) => {
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });

    return changedVariantControls.length > 0;
  };

  const finishVariantUpdate = () => {
    window.setTimeout(() => {
      applyingVariant = false;
      refreshVariantOptions();
    }, 0);
  };

  const updateControlsToVariant = (groups, variants, variant, scope) => {
    applyingVariant = true;
    const changedOptionControls = [];

    groups.forEach((group, index) => {
      group.controls.forEach((control) => {
        if (control.tagName === "SELECT") {
          if (control.value !== variant.options[index]) {
            control.value = variant.options[index];
            changedOptionControls.push(control);
          }
        } else {
          const shouldCheck =
            normalize(control.value) === normalize(variant.options[index]);
          if (control.checked !== shouldCheck) {
            control.checked = shouldCheck;
            if (shouldCheck) changedOptionControls.push(control);
          }
        }
      });
    });

    changedOptionControls.forEach((control) =>
      control.dispatchEvent(new Event("change", { bubbles: true })),
    );

    syncVariantIdControls(scope, variants, variant);
    finishVariantUpdate();
  };

  const ensureVariantIdControls = (scope, variants, variant) => {
    applyingVariant = true;
    const changed = syncVariantIdControls(scope, variants, variant);

    if (changed) {
      finishVariantUpdate();
    } else {
      applyingVariant = false;
    }

    return changed;
  };

  const setRadioVisibility = (radio, available, scope) => {
    setAppDisabled(radio, !available);
    radio.classList.toggle(HIDDEN_OPTION_CLASS, !available);

    const escapedId = window.CSS?.escape
      ? window.CSS.escape(radio.id)
      : radio.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    const label = radio.id
      ? scope.querySelector(`label[for="${escapedId}"]`)
      : radio.closest("label");

    label?.classList.toggle(HIDDEN_OPTION_CLASS, !available);
  };

  const renderAvailabilityNote = (scope, hiddenValues) => {
    let note = scope.querySelector("[data-hisha-stock-note]");
    const message = String(context.availabilityNote ?? "").trim();

    if (!hiddenValues || !message) {
      note?.remove();
      return;
    }

    if (!note) {
      note = document.createElement("p");
      note.className = "hisha-stock-note";
      note.dataset.hishaStockNote = "true";
      note.setAttribute("role", "status");
      note.setAttribute("aria-live", "polite");

      const form = scope.querySelector('form[action*="/cart/add"]');
      const firstControl = scope.querySelector(OPTION_CONTROL_SELECTORS);
      const picker = firstControl?.closest(
        "variant-selects,variant-radios,[data-variant-picker]",
      );
      const optionGroup = firstControl?.closest(
        "fieldset,.product-form__input",
      );

      if (picker) picker.after(note);
      else if (optionGroup) optionGroup.after(note);
      else if (form) form.before(note);
      else firstControl?.parentElement?.append(note);
    }

    if (note.textContent !== message) note.textContent = message;
  };

  const updateVariantIdVisibility = (scope, variants) => {
    const unavailableIds = new Set(
      variants
        .filter((variant) => !variant.available)
        .map((variant) => variant.id),
    );

    scope.querySelectorAll('select[name="id"] option').forEach((option) => {
      if (!variants.some((variant) => variant.id === String(option.value))) {
        return;
      }

      setOptionVisibility(option, !unavailableIds.has(String(option.value)));
    });
    scope
      .querySelectorAll(
        'input[type="radio"][name="id"],input[type="checkbox"][name="id"]',
      )
      .forEach((input) => {
        if (!variants.some((variant) => variant.id === String(input.value))) {
          return;
        }

        setRadioVisibility(
          input,
          !unavailableIds.has(String(input.value)),
          scope,
        );
      });

    return unavailableIds.size;
  };

  function refreshVariantOptions() {
    if (
      (!settings.hideSoldOutVariants && !manualHiddenVariantIds.size) ||
      !product
    ) {
      releaseVariantPrepaint();
      return;
    }

    if (applyingVariant) return;

    const scope = getProductScope();
    const variants = normalizedVariants();
    const groups = buildOptionGroups(scope);

    if (!variants.length) {
      releaseVariantPrepaint();
      return;
    }

    if (!groups.size) {
      const selectedId = selectedVariantId(scope, variants);
      const selectedVariant = variants.find(
        (variant) => variant.id === String(selectedId),
      );
      const availableVariant = selectedVariant?.available
        ? selectedVariant
        : variants.find((variant) => variant.available);

      if (
        availableVariant &&
        ensureVariantIdControls(scope, variants, availableVariant)
      ) {
        return;
      }

      const hiddenVariantCount = updateVariantIdVisibility(scope, variants);
      renderAvailabilityNote(scope, hiddenVariantCount);
      releaseVariantPrepaint();
      return;
    }

    const selected = selectedOptions(groups, variants, scope);
    const currentVariant = matchingVariant(variants, selected);
    const availableVariant = closestAvailableVariant(variants, selected);

    if ((!currentVariant || !currentVariant.available) && availableVariant) {
      updateControlsToVariant(groups, variants, availableVariant, scope);
      return;
    }

    const hiddenValues = new Set();

    groups.forEach((group, index) => {
      group.controls.forEach((control) => {
        if (control.tagName === "SELECT") {
          Array.from(control.options).forEach((option) => {
            if (!option.value) return;

            if (option.dataset.productUrl) {
              setOptionVisibility(option, true);
              return;
            }

            const available = variants.some(
              (variant) =>
                variant.available &&
                normalize(variant.options[index]) === normalize(option.value) &&
                variant.options.every(
                  (value, otherIndex) =>
                    otherIndex >= index ||
                    !selected[otherIndex] ||
                    normalize(value) === normalize(selected[otherIndex]),
                ),
            );
            setOptionVisibility(option, available);
            if (!available) hiddenValues.add(`${index}:${option.value}`);
          });
          return;
        }

        if (control.dataset.productUrl) {
          setRadioVisibility(control, true, scope);
          return;
        }

        const available = variants.some(
          (variant) =>
            variant.available &&
            normalize(variant.options[index]) === normalize(control.value) &&
            variant.options.every(
              (value, otherIndex) =>
                otherIndex >= index ||
                !selected[otherIndex] ||
                normalize(value) === normalize(selected[otherIndex]),
            ),
        );
        setRadioVisibility(control, available, scope);
        if (!available) hiddenValues.add(`${index}:${control.value}`);
      });
    });

    updateVariantIdVisibility(scope, variants);

    if (
      currentVariant?.available &&
      ensureVariantIdControls(scope, variants, currentVariant)
    ) {
      return;
    }

    renderAvailabilityNote(scope, hiddenValues.size);
    releaseVariantPrepaint();
  }

  const queueVariantRefresh = () => {
    if (variantRefreshQueued) return;

    variantRefreshQueued = true;
    window.queueMicrotask(() => {
      variantRefreshQueued = false;
      refreshVariantOptions();
    });
  };

  const queueCardScan = () => {
    if (cardScanQueued) return;

    cardScanQueued = true;
    window.queueMicrotask(() => {
      cardScanQueued = false;
      scanProductCards();
    });
  };

  const scheduleRefresh = () => {
    queueVariantRefresh();
    queueCardScan();
  };

  const containsVariantControls = (node) => {
    if (node.nodeType !== 1) return false;

    return (
      node.matches(OPTION_CONTROL_SELECTORS) ||
      Boolean(node.querySelector(OPTION_CONTROL_SELECTORS))
    );
  };

  const containsProductCard = (node) => {
    if (node.nodeType !== 1) return false;

    return (
      node.matches(CARD_SELECTORS) ||
      node.matches('a[href*="/products/"]') ||
      Boolean(node.querySelector('a[href*="/products/"]'))
    );
  };

  const handleMutations = (mutations) => {
    const pickerChanged = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some(containsVariantControls),
    );

    if (
      pickerChanged &&
      (settings.hideSoldOutVariants || manualHiddenVariantIds.size) &&
      product
    ) {
      document.documentElement.classList.add(PREPAINT_CLASS);
    }

    if (pickerChanged) queueVariantRefresh();

    if (
      mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(containsProductCard),
      )
    ) {
      queueCardScan();
    }
  };

  const initialize = () => {
    hydratePageData();

    if (!hasValidEntitlementLease()) {
      releaseVariantPrepaint();
      return;
    }

    if (
      product &&
      shouldHideProduct(product) &&
      !context.designMode &&
      !window.Shopify?.designMode
    ) {
      document.documentElement.classList.add("hisha-product-redirecting");
      window.location.replace(rootUrl);
      return;
    }

    scanProductCards();
    refreshVariantOptions();

    document.addEventListener("change", (event) => {
      if (event.target?.matches?.(`[name="id"],${OPTION_CONTROL_SELECTORS}`)) {
        queueVariantRefresh();
      }
    });

    new MutationObserver(handleMutations).observe(document.body, {
      childList: true,
      subtree: true,
    });

    window.HiShaHideVariants = Object.freeze({
      version: VERSION,
      settings: Object.freeze({ ...settings }),
      refresh: scheduleRefresh,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();

import type { WeaverClient } from "@weaver-conf/weaver-client";
import {
  type BrowseState,
  SchemaBrowserController,
  type Selection,
} from "./schema-browser-controller";

function element(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function visible(state: BrowseState): Selection[] {
  if (!state.page) return [];
  return [
    ...state.page.anchors.filter(
      (item) => state.includeFragments || item.kind === "service",
    ),
    ...(state.includeFragments ? state.page.slots : []),
  ];
}

function createDisclosure(container: HTMLElement) {
  const button = document.createElement("button");
  button.textContent = "View schema";
  button.type = "button";
  button.setAttribute("aria-controls", "inspector-schema-content");
  button.setAttribute("aria-expanded", "false");
  const content = element("div");
  content.id = "inspector-schema-content";
  content.hidden = true;
  const explanation = element(
    "p",
    "Registered service roots and fragment anchors are independent of the selected dotted config key. Choose an exact path and environment; no prefix is inferred. Slots are declarations without detail; fragments may be on other pages.",
  );
  const provenance = element(
    "p",
    "Offline seeded example (not server registrations); separate from local property policy.",
  );
  container.append(button, content);
  return { button, content, explanation, provenance };
}

function createButtons() {
  const back = document.createElement("button");
  back.textContent = "Back";
  const next = document.createElement("button");
  next.textContent = "Next page";
  const restart = document.createElement("button");
  restart.textContent = "Restart first page";
  const retry = document.createElement("button");
  retry.textContent = "Retry";
  return { back, next, restart, retry };
}

function createPanel(container: HTMLElement) {
  const { button, content, explanation, provenance } =
    createDisclosure(container);
  const toggleLabel = element("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("aria-label", "Include fragments and declared slots");
  toggleLabel.append(toggle, " Include fragments and declared slots");
  const selectLabel = element(
    "label",
    "Registered schema identity (current page) ",
  );
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Registered schema identity");
  selectLabel.append(selector);
  const { back, next, restart, retry } = createButtons();
  const identity = element("p");
  const status = element("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const code = element("code");
  const pre = element("pre");
  pre.append(code);
  content.append(
    explanation,
    provenance,
    toggleLabel,
    selectLabel,
    back,
    next,
    restart,
    retry,
    identity,
    status,
    pre,
  );
  return {
    button,
    content,
    toggle,
    selector,
    back,
    next,
    restart,
    retry,
    identity,
    status,
    code,
  };
}

type Panel = ReturnType<typeof createPanel>;

function paint(panel: Panel, state: BrowseState, choices: Selection[]): void {
  const {
    button,
    content,
    toggle,
    selector,
    back,
    next,
    restart,
    retry,
    identity,
    status,
    code,
  } = panel;
  content.hidden = !state.open;
  button.setAttribute("aria-expanded", String(state.open));
  toggle.checked = state.includeFragments;
  toggle.disabled = !!state.error && !state.page;
  if (!state.selected) selector.selectedIndex = 0;
  identity.textContent = state.selected
    ? `${state.selected.kind}: ${state.selected.path} · environment: ${state.selected.environment}`
    : "";
  status.textContent =
    state.page &&
    !choices.length &&
    state.page.anchors.length + state.page.slots.length > 0
      ? "No identities match on this page. Include fragments or try the next page."
      : state.status;
  if (state.historyTruncated && !state.error)
    status.textContent +=
      " Earlier pages dropped from Back history; close and reopen to start over.";
  code.textContent = state.detail
    ? JSON.stringify(state.detail.schema, null, 2)
    : "";
  back.hidden = !state.open || !!state.error || !state.history.length;
  next.hidden = !state.open || !!state.error || !state.page?.hasMore;
  restart.hidden = state.error !== "stale";
  retry.hidden = state.error !== "retry";
}

function populate(panel: Panel, choices: Selection[]): void {
  const { selector } = panel;
  selector.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.textContent = "Select an identity";
  placeholder.value = "";
  selector.append(placeholder);
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = `${choice.kind}:${choice.path}:${choice.environment}`;
    option.textContent = `${choice.kind}: ${choice.path} · ${choice.environment}`;
    selector.append(option);
  }
}

export function renderSchemaBrowser(
  container: HTMLElement,
  client: WeaverClient,
) {
  const panel = createPanel(container);
  const { button, content, toggle, selector, back, next, restart, retry } =
    panel;
  let choices: Selection[] = [];
  let previousPage: BrowseState["page"];
  let previousFilter = false;
  const controller = new SchemaBrowserController(client, (state) => {
    if (
      state.page !== previousPage ||
      state.includeFragments !== previousFilter
    ) {
      choices = visible(state);
      populate(panel, choices);
      previousPage = state.page;
      previousFilter = state.includeFragments;
    }
    paint(panel, state, choices);
    if (
      state.error === "stale" &&
      content.contains(document.activeElement) &&
      document.activeElement !== restart
    )
      restart.focus();
  });
  button.addEventListener("click", () => {
    if (controller.state.open) {
      controller.close();
      button.focus();
    } else controller.open();
  });
  toggle.addEventListener("change", () =>
    controller.setFragments(toggle.checked),
  );
  selector.addEventListener("change", () =>
    controller.select(choices[selector.selectedIndex - 1]),
  );
  next.addEventListener("click", () => controller.next());
  back.addEventListener("click", () => controller.back());
  restart.addEventListener("click", () => {
    controller.restart();
    button.focus();
  });
  retry.addEventListener("click", () => controller.retry());
  controller.reset();
  return controller;
}

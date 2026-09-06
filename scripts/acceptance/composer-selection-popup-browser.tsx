import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ComposerSelectionPopup } from "../../apps/desktop/src/renderer/ComposerSelectionPopup";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

type Patch = { model?: string | null; thinkingLevel?: string };

const targetIndex = 4_790;
const targetProvider = `provider-${targetIndex % 37}`;
const targetId = `m${targetIndex}`;
const targetValue = `p${targetIndex % 37}\0${targetId}`;
const models = [
  { value: "", label: "Default", detail: "Native default" },
  ...Array.from({ length: 4_791 }, (_, index) => ({
    value: `p${index % 37}\0m${index}`,
    label: `Model ${index}`,
    detail: `provider-${index % 37} · m${index}`,
  })),
];
const patches: Patch[] = [];

function Fixture() {
  const [model, setModel] = useState("p0\0m0");
  const [effort, setEffort] = useState<string | undefined>("high");
  const [disabled, setDisabled] = useState(false);
  return <main>
    <button id="outside-target" type="button">outside target</button>
    <button id="toggle-disabled" type="button" onClick={() => setDisabled(value => !value)}>toggle disabled</button>
    <div style={{ position: "fixed", right: 24, bottom: 24 }}>
      <ComposerSelectionPopup
        modelValue={model}
        modelLabel={models.find(item => item.value === model)?.label ?? "retained"}
        modelTitle="controlled"
        models={models}
        levels={["auto", "off", "low", "high", "max"]}
        effort={effort}
        effectiveEffort="low"
        defaultEffortLabel="Native default: low"
        disabled={disabled}
        onModel={value => {
          patches.push({ model: value || null, thinkingLevel: undefined });
          setModel(value);
        }}
        onEffort={thinkingLevel => {
          patches.push({ thinkingLevel });
          setEffort(thinkingLevel);
        }}
        onReset={() => {
          patches.push({ model: null, thinkingLevel: undefined });
          setModel("");
          setEffort(undefined);
        }}
      />
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="Model and reasoning effort"]');
const menu = () => document.querySelector<HTMLElement>(".composer-selection-menu");
const modelRow = () => [...document.querySelectorAll<HTMLButtonElement>('.composer-selection-options > button[role="menuitemradio"]')]
  .find(item => item.textContent?.includes(`Model ${targetIndex}`) && item.textContent?.includes(`${targetProvider} · ${targetId}`));
const namedElement = (name: string): HTMLElement | null => {
  if (name === "trigger") return trigger();
  if (name === "model-menu") return [...document.querySelectorAll<HTMLButtonElement>('.composer-selection-menu > button[role="menuitem"]')]
    .find(item => item.firstChild?.textContent?.trim() === "Model") ?? null;
  if (name === "power") return document.querySelector('[aria-label="Reasoning power"]');
  if (name === "search") return document.querySelector('[aria-label="Search models"]');
  if (name === "target-model") return modelRow() ?? null;
  if (name === "auto") return [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
    .find(item => item.textContent?.trim() === "auto") ?? null;
  if (name === "off") return [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
    .find(item => item.textContent?.trim() === "off") ?? null;
  if (name === "reset") return document.querySelector('[aria-label="Reset composer selections"]');
  if (name === "outside") return document.getElementById("outside-target");
  if (name === "toggle-disabled") return document.getElementById("toggle-disabled");
  return null;
};
const rect = (element: Element | null) => {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
};

Object.assign(window, {
  composerSelectionPoint(name: string) {
    const element = namedElement(name);
    if (!element) throw new Error(`Missing native-input target: ${name}`);
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  },
  composerSelectionSnapshot() {
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.composer-selection-options > button[role="menuitemradio"]')];
    const popup = menu();
    const popupRect = popup?.getBoundingClientRect();
    return {
      ready: Boolean(trigger()),
      open: Boolean(popup),
      menuLabel: popup?.getAttribute("aria-label") ?? null,
      trigger: rect(trigger()),
      menu: rect(popup),
      power: rect(document.querySelector('[aria-label="Reasoning power"]')),
      search: rect(document.querySelector('[aria-label="Search models"]')),
      catalogRows: rows.length,
      targetVisible: Boolean(modelRow()),
      targetProvider,
      targetId,
      triggerText: trigger()?.textContent?.trim() ?? null,
      headerText: document.querySelector(".composer-selection-header")?.textContent?.trim() ?? null,
      powerDisabled: document.querySelector<HTMLInputElement>('[aria-label="Reasoning power"]')?.disabled ?? null,
      powerOutput: document.querySelector(".composer-selection-power output")?.textContent?.trim() ?? null,
      checkedEfforts: [...document.querySelectorAll<HTMLButtonElement>('.composer-selection-menu > button[role="menuitemradio"][aria-checked="true"]')].map(item => item.textContent?.trim()),
      activeId: document.activeElement?.id || document.activeElement?.getAttribute("aria-label") || null,
      fitting: Boolean(popupRect && popupRect.left >= 0 && popupRect.top >= 0 && popupRect.right <= innerWidth && popupRect.bottom <= innerHeight),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      patches: [...patches],
    };
  },
  composerSelectionResult() {
    const modelPatches = patches.filter(patch => Object.hasOwn(patch, "model"));
    const resetPatches = patches.filter(patch => patch.model === null && Object.hasOwn(patch, "thinkingLevel") && patch.thinkingLevel === undefined);
    return {
      patches: [...patches],
      targetValue,
      passed:
        patches.some(patch => patch.thinkingLevel === "max") &&
        modelPatches.some(patch => patch.model === targetValue) &&
        patches.some(patch => patch.thinkingLevel === "auto") &&
        patches.some(patch => patch.thinkingLevel === "off") &&
        resetPatches.length === 1,
    };
  },
});

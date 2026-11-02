import type { WorkerBinding } from "./state.ts";
import { RGBA } from "@opentui/core";

export interface UiOption<T> {
  title: string;
  value: T;
  description?: string;
  category?: string;
  disabled?: boolean;
}

export interface ProjectChoice {
  id: string;
  title: string;
  location: string;
}
export interface WorkerChoice {
  workerID: string;
  title: string;
  location: string;
  agent: string;
}
export type UiState =
  "ready" | "loading" | "empty" | "error" | "disconnected" | "awaiting-rearm";
export type WorkerAction = "share" | "hold" | "resume" | "takeover";

export interface NativeUiPort {
  select<T>(
    title: string,
    options: readonly UiOption<T>[],
  ): Promise<T | undefined>;
  notice(state: UiState, reason: string): Promise<void>;
  projects(): Promise<readonly ProjectChoice[]>;
  agents(location: string): Promise<readonly string[]>;
  workers(location: string, agent: string): Promise<readonly WorkerChoice[]>;
  open(workerID: string): boolean;
  control(action: WorkerAction, task: WorkerBinding): Promise<WorkerBinding>;
}

export interface Overview {
  title: string;
  placeholder: string;
  current?: string;
  options: readonly UiOption<string>[];
  footer: string;
}

export class CoordinationUI {
  constructor(private readonly port: NativeUiPort) {}
  async selectTarget(
    kind: "create" | "adopt",
  ): Promise<WorkerChoice | undefined> {
    try {
      const projects = await this.port.projects();
      const project = await this.choose(
        "Project",
        projects.map((value) => ({
          title: value.title,
          description: value.location,
          value,
        })),
      );
      if (!project) return undefined;
      const agents = await this.port.agents(project.location);
      const agent = await this.choose(
        "Agent",
        agents.map((value) => ({
          title: value,
          description: project.location,
          value,
        })),
      );
      if (!agent) return undefined;
      if (kind === "create")
        return {
          workerID: "",
          title: project.title,
          location: project.location,
          agent,
        };
      const workers = await this.port.workers(project.location, agent);
      const workerID = await this.choose(
        "Worker",
        workers.map((worker) => ({
          title: worker.title,
          description: `${worker.location} / ${worker.agent}`,
          value: worker.workerID,
        })),
      );
      const worker = workers.find((value) => value.workerID === workerID);
      if (
        !worker ||
        worker.location !== project.location ||
        worker.agent !== agent
      )
        return undefined;
      return structuredClone(worker);
    } catch (error) {
      await this.port.notice("error", errorReason(error));
      return undefined;
    }
  }

  async open(task: WorkerBinding): Promise<boolean> {
    const opened = this.port.open(task.workerID);
    if (!opened)
      await this.port.notice("error", "Selected worker could not be opened");
    return opened;
  }

  async control(
    action: WorkerAction,
    task: WorkerBinding,
  ): Promise<WorkerBinding | undefined> {
    try {
      const binding = await this.port.control(action, structuredClone(task));
      if (
        binding.id !== task.id ||
        binding.workerID !== task.workerID ||
        binding.epoch < task.epoch
      ) {
        throw new Error("Control result does not match the selected task");
      }
      return structuredClone(binding);
    } catch (error) {
      await this.port.notice("error", errorReason(error));
      return undefined;
    }
  }

  private async choose<T>(
    title: string,
    options: readonly UiOption<T>[],
  ): Promise<T | undefined> {
    if (!options.length) {
      await this.port.notice("empty", `${title}: no available choices`);
      return undefined;
    }
    const selected = await this.port.select(title, options);
    if (selected === undefined) return undefined;
    if (
      !options.some(
        (option) =>
          !option.disabled &&
          JSON.stringify(option.value) === JSON.stringify(selected),
      )
    ) {
      throw new Error(`${title}: selection is unavailable`);
    }
    return selected;
  }
}

export interface NativePaintSurface {
  withBuffers<T>(
    callback: (cells: {
      width: number;
      height: number;
      fg: Uint16Array;
      bg: Uint16Array;
    }) => T,
  ): T;
}

export function applyNativeNoColor(
  renderer: {
    addPostProcessFn(fn: (surface: NativePaintSurface) => void): void;
    removePostProcessFn(fn: (surface: NativePaintSurface) => void): void;
  },
  enabled = Boolean(process.env.NO_COLOR),
): () => void {
  if (!enabled) return () => {};
  const foreground = RGBA.defaultForeground().buffer,
    background = RGBA.defaultBackground().buffer;
  const paint = (surface: NativePaintSurface) =>
    surface.withBuffers((cells) => {
      for (let i = 0; i < cells.width * cells.height; i++) {
        cells.fg.set(foreground, i * foreground.length);
        cells.bg.set(background, i * background.length);
      }
    });
  renderer.addPostProcessFn(paint);
  return () => renderer.removePostProcessFn(paint);
}

export const NATIVE_UI = Object.freeze({
  title: "Coordinate / search",
  placeholder: "Search projects, tasks and worker status",
  footer: "Native navigation / select / back",
  actions: "Create / Adopt / Open / Share / Hold / Resume / Takeover",
  detailWidth: 60,
  detailInset: 16,
  minDetailColumns: 8,
});

export function coordinatorSessionChoices(
  home: string,
  reusable: boolean,
): {
  title: string;
  options: readonly UiOption<string>[];
} {
  return {
    title: "Set up coordinator",
    options: [
      reusable
        ? {
            title: "Use coordinator session",
            value: "reuse",
            description:
              "Open the verified coordinator session; no prompt is sent",
          }
        : {
            title: "Create coordinator",
            value: "create",
            description: `Create a blank session at ${display(home)}; no prompt is sent`,
          },
      {
        title: "Inspect home",
        value: "home",
        description: "Read the full canonical coordinator path",
      },
      {
        title: "Back",
        value: "back",
        description: "Leave supervision stopped",
      },
    ],
  };
}

export function coordinatorHomeDetails(
  home: string,
  width: number,
): { title: string; options: readonly UiOption<number>[] } {
  return textDetails("Canonical home (read only)", [display(home)], width);
}

export function supervisionChoices(): {
  title: string;
  options: readonly UiOption<string>[];
} {
  return {
    title: "Connected - supervision stopped",
    options: [
      {
        title: "Start supervision",
        value: "start",
        description: "Reconcile current workers and explicitly rearm",
      },
      {
        title: "Not now",
        value: "not-now",
        description: "Keep attachment approved and supervision stopped",
      },
    ],
  };
}

export function overview(
  tasks: readonly WorkerBinding[],
  state: UiState,
  selected?: string,
  width = 80,
  nativeStatus: Readonly<Record<string, "needs-input" | "running">> = {},
): Overview {
  const options = tasks.map((task) => ({
    title: [
      display(projectName(task.location)),
      ...(width >= NATIVE_UI.detailWidth ? [display(task.agent)] : []),
      nativeStatus[task.workerID] ?? task.status,
    ].join(" / "),
    value: task.workerID,
    category: display(task.group ?? "Tasks"),
    description:
      state === "ready"
        ? taskDetail(task, width)
        : `${state}: controls unavailable until current state is reconciled`,
    disabled: state !== "ready",
  }));
  if (!options.length)
    options.push({
      title: state === "ready" ? "empty" : state,
      value: "",
      category: "Tasks",
      description: "No workers available",
      disabled: true,
    });
  return {
    title: NATIVE_UI.title,
    placeholder:
      state === "ready"
        ? NATIVE_UI.placeholder
        : `${state}: controls unavailable`,
    ...(selected === undefined ? {} : { current: selected }),
    options,
    footer: `${NATIVE_UI.actions}\n${NATIVE_UI.footer}`,
  };
}

/** Selectable text segments use native keyboard navigation and never mutate refs. */
export function sharedVersionDetails(
  task: WorkerBinding,
  width: number,
): {
  title: string;
  options: readonly UiOption<number>[];
} {
  return textDetails(
    "Shared versions (read only)",
    [JSON.stringify(task.shared ?? [])],
    width,
  );
}

export function coordinationStatusDetails(
  tasks: readonly WorkerBinding[],
  state: UiState,
  reason: string,
  width: number,
  nativeStatus: Readonly<Record<string, "needs-input" | "running">> = {},
): { title: string; options: readonly UiOption<number>[] } {
  return textDetails(
    "Status (read only)",
    [
      `State: ${state}`,
      `Reason: ${display(reason)}`,
      ...tasks.flatMap((task) => [
        `Project: ${display(task.location)}`,
        `Task: ${display(task.id)} / ${display(task.title)}`,
        `Worker: ${display(task.workerID)}`,
        `Agent: ${display(task.agent)}`,
        `Status: ${nativeStatus[task.workerID] ?? task.status}`,
      ]),
      ...(!tasks.length ? ["No workers available"] : []),
    ],
    width,
  );
}

function textDetails(
  title: string,
  lines: readonly string[],
  width: number,
): {
  title: string;
  options: readonly UiOption<number>[];
} {
  const columns = Math.max(
    NATIVE_UI.minDetailColumns,
    Math.min(Math.floor(width), NATIVE_UI.detailWidth) - NATIVE_UI.detailInset,
  );
  const options: UiOption<number>[] = [];
  let offset = 0;
  for (const line of lines) {
    const text = Array.from(line);
    for (let start = 0; start < text.length; start += columns)
      options.push({
        title: text.slice(start, start + columns).join(""),
        value: offset + start,
      });
    offset += text.length;
  }
  return { title, options };
}

/** Plain-text native-dialog content inventory, not an OpenCode renderer capture. */
export function describeOverview(view: Overview): string {
  const lines = [view.title];
  let category: string | undefined;
  for (const option of view.options) {
    if (option.category !== category) {
      category = option.category;
      lines.push(`Group: ${category ?? "Tasks"}`);
    }
    lines.push(`${view.current === option.value ? "> " : "  "}${option.title}`);
    if (option.description) lines.push(`  ${option.description}`);
  }
  return [...lines, view.footer].join("\n");
}

function projectName(location: string): string {
  return location.split(/[\\/]/).filter(Boolean).at(-1) ?? location;
}

function taskDetail(task: WorkerBinding, width: number): string {
  const shared = task.shared
    ?.map((ref) => `${display(ref.id)} v${ref.version}`)
    .join(", ");
  const detail =
    width >= NATIVE_UI.detailWidth ? `Goal: ${display(task.goal)}` : "";
  return [detail, shared && `shared snapshot ${shared}`]
    .filter(Boolean)
    .join("; ");
}

function display(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function errorReason(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Native coordination is unavailable";
}

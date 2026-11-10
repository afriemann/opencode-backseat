import type {
  OpenCodeClient,
  PermissionCreateInput,
  PermissionReplyInput,
  SessionFormReplyInput,
  SessionFormCreateInput,
  JsonValue,
  SessionUpdateInput,
  SessionPromptInput,
  SessionCreateInput,
  ExperimentalSessionImportInput,
} from "@opencode/client";
import { PAYLOAD_BYTES, bulkText, exact, text, list, object } from "./state.ts";
import { Form, Session, SessionMessage } from "@opencode/client/effect";
import { Schema } from "effect";
import { readNativeInventory } from "./native-sessions.ts";

const string = { type: "string", minLength: 1 } as const;
const strings = { type: "array", items: string } as const;
const boolean = { type: "boolean" } as const;
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const NATIVE_SEND_KINDS = [
  "prompt",
  "synthetic",
  "shell",
  "compact",
  "command",
  "skill",
] as const;
export type NativeSendKind = (typeof NATIVE_SEND_KINDS)[number];
const mentionSchema = schema(
  {
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 0 },
    text: string,
  },
  ["start", "end", "text"],
);
const attachmentProperties = {
  files: {
    type: "array",
    items: schema(
      {
        uri: string,
        name: string,
        description: string,
        mention: mentionSchema,
        source: {
          anyOf: [
            schema({ type: { const: "inline" } }, ["type"]),
            schema({ type: { const: "uri" }, uri: string }, ["type", "uri"]),
          ],
        },
      },
      ["uri"],
    ),
  },
  agents: {
    type: "array",
    items: schema({ name: string, mention: mentionSchema }, ["name"]),
  },
  skills: {
    type: "array",
    items: schema({ id: string, mention: mentionSchema }, ["id"]),
  },
};
const deliverySchema = { enum: ["steer", "queue"] };
export const NATIVE_SEND_OPTIONS = {
  prompt: schema(
    {
      ...attachmentProperties,
      metadata: { type: "object" },
      delivery: deliverySchema,
      resume: boolean,
    },
    [],
  ),
  synthetic: schema(
    {
      description: string,
      metadata: { type: "object" },
      delivery: deliverySchema,
      resume: boolean,
    },
    [],
  ),
  shell: schema({}, []),
  compact: schema({ delivery: deliverySchema }, []),
  command: schema(
    { ...attachmentProperties, name: string, delivery: deliverySchema },
    ["name"],
  ),
  skill: schema({ skillID: string, resume: boolean }, ["skillID"]),
};
export const NATIVE_SEND_DESCRIPTIONS = {
  synthetic:
    "Insert native synthetic text, optionally hidden when options.description is omitted. resume false stores without starting a turn.",
  shell:
    "Execute text as a native shell command in the selected session under configured OpenCode permissions.",
  compact:
    "Compact the selected native session with optional delivery. text is not used by compaction.",
  command:
    "Execute the selected native slash command options.name with text and optional attachments. Native commands do not accept caller-selected admission IDs; an uncertain outcome remains blocked rather than being retried.",
  skill:
    "Activate options.skillID in the selected native session. text is not used. The native skill API has no caller-selected admission ID; an uncertain outcome remains blocked rather than being retried.",
};
export interface NativeSend {
  sessionID: string;
  text: string;
  kind?: NativeSendKind;
  options?: Record<string, unknown>;
}
export function prepareNativeSend(input: NativeSend, sendID: string): Work {
  const { sessionID } = input;
  const kind = input.kind ?? "prompt";
  if (!NATIVE_SEND_KINDS.includes(kind))
    throw new Error("Unsupported native send operation");
  if (Buffer.byteLength(input.text) > PAYLOAD_BYTES)
    throw new Error("Oversized native send text");
  const value = object(input.options ?? {});
  if (Buffer.byteLength(JSON.stringify(value)) > PAYLOAD_BYTES)
    throw new Error("Oversized native send options");
  const keys =
    kind === "prompt"
      ? ["files", "agents", "skills", "metadata", "delivery", "resume"]
      : kind === "synthetic"
        ? ["description", "metadata", "delivery", "resume"]
        : kind === "compact"
          ? ["delivery"]
          : kind === "command"
            ? ["name", "files", "agents", "skills", "delivery"]
            : kind === "skill"
              ? ["skillID", "resume"]
              : [];
  exact(value, keys);
  const delivery =
    value.delivery === undefined ? undefined : text(value.delivery);
  if (delivery !== undefined && delivery !== "steer" && delivery !== "queue")
    throw new Error("Invalid native delivery option");
  const resume = optionalBoolean(value.resume);
  const metadata =
    value.metadata === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(object(value.metadata)).map(([key, entry]) => [
            key,
            json(entry),
          ]),
        );
  const mention = (input: unknown) => {
    const row = object(input);
    exact(row, ["start", "end", "text"]);
    if (
      !Number.isSafeInteger(row.start) ||
      !Number.isSafeInteger(row.end) ||
      (row.start as number) < 0 ||
      (row.end as number) < (row.start as number)
    )
      throw new Error("Invalid native attachment mention");
    return {
      start: row.start as number,
      end: row.end as number,
      text: bulkText(row.text),
    };
  };
  const files: SessionPromptInput["files"] =
    value.files === undefined
      ? undefined
      : list(value.files, (item) => {
          const row = object(item);
          exact(row, ["uri", "source", "name", "description", "mention"]);
          let source:
            { type: "inline" } | { type: "uri"; uri: string } | undefined;
          if (row.source !== undefined) {
            const selected = object(row.source);
            exact(
              selected,
              selected.type === "inline" ? ["type"] : ["type", "uri"],
            );
            if (selected.type === "inline") source = { type: "inline" };
            else if (selected.type === "uri")
              source = { type: "uri", uri: text(selected.uri) };
            else throw new Error("Invalid native attachment source");
          }
          return {
            uri: text(row.uri),
            ...(source === undefined ? {} : { source }),
            ...(row.name === undefined ? {} : { name: text(row.name) }),
            ...(row.description === undefined
              ? {}
              : { description: bulkText(row.description) }),
            ...(row.mention === undefined
              ? {}
              : { mention: mention(row.mention) }),
          };
        });
  const agents =
    value.agents === undefined
      ? undefined
      : list(value.agents, (item) => {
          const row = object(item);
          exact(row, ["name", "mention"]);
          return {
            name: text(row.name),
            ...(row.mention === undefined
              ? {}
              : { mention: mention(row.mention) }),
          };
        });
  const skills =
    value.skills === undefined
      ? undefined
      : list(value.skills, (item) => {
          const row = object(item);
          exact(row, ["id", "mention"]);
          return {
            id: text(row.id),
            ...(row.mention === undefined
              ? {}
              : { mention: mention(row.mention) }),
          };
        });
  const attachments = {
    ...(files === undefined ? {} : { files }),
    ...(agents === undefined ? {} : { agents }),
    ...(skills === undefined ? {} : { skills }),
  };
  const scheduling: Pick<SessionPromptInput, "delivery" | "resume"> = {
    ...(delivery === undefined ? {} : { delivery }),
    ...(resume === undefined ? {} : { resume }),
  };
  const description =
    value.description === undefined ? undefined : bulkText(value.description);
  switch (kind) {
    case "prompt":
      return (client, signal) =>
        client.session.prompt(
          {
            sessionID,
            id: sendID,
            text: input.text,
            ...attachments,
            ...scheduling,
            ...(metadata === undefined ? {} : { metadata }),
          },
          { signal },
        );
    case "synthetic":
      return (client, signal) =>
        client.session.synthetic(
          {
            sessionID,
            id: sendID,
            text: input.text,
            ...scheduling,
            ...(metadata === undefined ? {} : { metadata }),
            ...(description === undefined ? {} : { description }),
          },
          { signal },
        );
    case "shell":
      return (client, signal) =>
        client.session.shell(
          { sessionID, id: sendID, command: input.text },
          { signal },
        );
    case "compact":
      return (client, signal) =>
        client.session.compact(
          {
            sessionID,
            id: sendID,
            ...(delivery === undefined ? {} : { delivery }),
          },
          { signal },
        );
    case "command": {
      const name = text(value.name);
      return (client, signal) =>
        client.session.command(
          {
            sessionID,
            name,
            text: input.text,
            ...attachments,
            ...(delivery === undefined ? {} : { delivery }),
          },
          { signal },
        );
    }
    case "skill": {
      const id = text(value.skillID);
      return (client, signal) =>
        client.experimental.session.skill(
          { sessionID, id, ...(resume === undefined ? {} : { resume }) },
          { signal },
        );
    }
  }
}

export const NATIVE_OPERATIONS = {
  create_native_session: {
    description:
      "Create and follow a native session. sessionID is a new stable native session ID, not an existing target. location and agent select its destination; optional parentID selects native ancestry only. Retain the returned identity on uncertainty and never create a replacement as a retry.",
    input: schema(
      {
        title: string,
        parentID: string,
        model: schema({ id: string, providerID: string, variant: string }, [
          "id",
          "providerID",
        ]),
        metadata: { type: "object" },
        permissions: {
          type: "array",
          items: schema(
            {
              action: string,
              resource: string,
              effect: { enum: ["allow", "deny", "ask"] },
            },
            ["action", "resource", "effect"],
          ),
        },
      },
      [],
    ),
  },
  import_session: {
    description:
      "Import and follow a native exported transfer in the selected location. sessionID and agent must exactly match transfer.info; the native location override selects the destination. Configured OpenCode permissions apply to the transfer. Retain the identity on uncertainty, never retry automatically.",
    input: schema(
      {
        transfer: schema(
          {
            info: { type: "object" },
            messages: { type: "array", items: { type: "object" } },
          },
          ["info", "messages"],
        ),
      },
      ["transfer"],
    ),
  },
  create_session_form: {
    description:
      "Create a native form with an explicit formID, title and nonempty native typed fields. Use string, number, integer, boolean, multiselect or external field definitions, including native options and conditional visibility. Approval binds the exact form; never retry an uncertain creation with another ID.",
    input: schema(
      {
        formID: string,
        title: string,
        fields: {
          type: "array",
          minItems: 1,
          items: { type: "object" },
        },
        metadata: { type: "object" },
      },
      ["formID", "title", "fields"],
    ),
  },
  cancel_session_input: {
    description:
      "Cancel one selected pending inbox item. Approval binds the current item; a missing, delivered, or changed item is not substituted.",
    input: schema({ inboxID: string }, ["inboxID"]),
  },
  update_session_input: {
    description:
      "Change one pending inbox item's delivery to steer or queue. Does not enqueue another message or retry an uncertain send.",
    input: schema({ inboxID: string, delivery: { enum: ["steer", "queue"] } }, [
      "inboxID",
      "delivery",
    ]),
  },
  cancel_session_form: {
    description:
      "Cancel one inspected pending native form. Approval binds its current contents; completed or changed forms are rejected.",
    input: schema({ formID: string }, ["formID"]),
  },
  fork_session: {
    description:
      "Fork the selected native session, optionally before messageID, and follow the new session. Returns the new native session.",
    input: schema({ before: string }, []),
  },
  switch_session_agent: {
    description:
      "Persistently switch the worker to newAgent. Subsequent turns use that agent; this is not a one-message override.",
    input: schema({ newAgent: string }, ["newAgent"]),
  },
  switch_session_model: {
    description:
      "Persistently select a native provider/model and optional variant for subsequent worker turns.",
    input: schema(
      {
        model: schema({ id: string, providerID: string, variant: string }, [
          "id",
          "providerID",
        ]),
      },
      ["model"],
    ),
  },
  update_session: {
    description:
      "Update the selected session title, metadata, session permission rules, or archived flag. permissions replaces the session rules; archived false unarchives an archived session.",
    input: schema(
      {
        title: string,
        metadata: { type: "object" },
        permissions: {
          type: "array",
          items: schema(
            {
              action: string,
              resource: string,
              effect: { enum: ["allow", "deny", "ask"] },
            },
            ["action", "resource", "effect"],
          ),
        },
        archived: boolean,
      },
      [],
    ),
  },
  move_session: {
    description:
      "Move the selected native session to absolute workdir, with steer or queue delivery. Does not move repository files.",
    input: schema({ workdir: string, delivery: { enum: ["steer", "queue"] } }, [
      "workdir",
    ]),
  },
  interrupt_session: {
    description:
      "Interrupt native worker execution. Optional resume uses the host execution option.",
    input: schema({ resume: boolean }, []),
  },
  background_session: {
    description: "Put the selected native execution in the background.",
    input: schema({}, []),
  },
  wait_session: {
    description:
      "Wait for the selected native execution through the cancellable host API. Does not poll all session history or grant consent.",
    input: schema({}, []),
  },
  generate_session: {
    description:
      "Generate text against the selected native session with prompt, without inserting a user message. This invokes the configured model and returns generated text.",
    input: schema({ prompt: string }, ["prompt"]),
  },
  recap_session: {
    description:
      "Recap the selected native session: its own model summarizes goal, work done, current state, open problems and next steps without inserting a message. Optional focus guides the recap. The result lists the session's direct child sessions (id, title, agent, status); recap one by calling this tool again with its id and location. Sends the transcript to that session's model.",
    input: schema({ focus: string }, []),
  },
  stage_session_revert: {
    description:
      "Stage a native revert at messageID, optionally including files. Inspect the returned native revert before committing it.",
    input: schema({ messageID: string, files: boolean }, ["messageID"]),
  },
  clear_session_revert: {
    description:
      "Clear the selected session's staged native revert without committing it.",
    input: schema({}, []),
  },
  commit_session_revert: {
    description:
      "Commit the selected session's staged native revert under configured OpenCode permissions.",
    input: schema({}, []),
  },
  set_session_environment: {
    description:
      "Replace the selected native session environment with variables. Empty strings are allowed. Never copy secrets into conversation or logs; this changes native execution settings only.",
    input: schema(
      {
        variables: { type: "object", additionalProperties: { type: "string" } },
      },
      ["variables"],
    ),
  },
  put_session_instruction: {
    description:
      "Put a native per-session instruction entry by key and JSON value. This persists through compaction without starting a model turn.",
    input: schema({ key: string, value: {} }, ["key", "value"]),
  },
  remove_session_instruction: {
    description:
      "Remove one native per-session instruction entry by key, not unrelated instructions.",
    input: schema({ key: string }, ["key"]),
  },
  mark_session_viewed: {
    description:
      "Mark the selected native session viewed at the native idle timestamp returned by session inspection. Does not open a terminal UI.",
    input: schema({ idle: { type: "number", minimum: 0 } }, ["idle"]),
  },
  reply_permission: {
    description:
      "Reply to one pending native permission request using once, always, or reject. Configured OpenCode permissions apply to the selected request and decision. This does not grant permissions to the coordinator itself. Returns completed or throws when the request or target changed.",
    input: schema(
      {
        requestID: string,
        decision: { enum: ["once", "always", "reject"] },
        message: string,
      },
      ["requestID", "decision"],
    ),
  },
  reply_form: {
    description:
      "Answer one pending native session form. answer maps field IDs to strings, finite numbers, booleans, or string arrays from the inspected form. Configured OpenCode permissions apply to the form and answers; changed or completed forms are rejected.",
    input: schema(
      {
        formID: string,
        answer: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      },
      ["formID", "answer"],
    ),
  },
  request_permission: {
    description:
      "Create a native permission request for the selected worker with explicit action, resources and optional save patterns. Configured OpenCode permissions apply; creating the request does not answer it. Returns the native request ID and effect.",
    input: schema({ action: string, resources: strings, save: strings }, [
      "action",
      "resources",
    ]),
  },
  remove_saved_permission: {
    description:
      "Remove one saved native permission belonging to the selected session's project. Approval covers the saved rule, not all rules or other projects. Does not change unrelated saved permissions or resume supervision.",
    input: schema({ id: string }, ["id"]),
  },
} as const;
export type NativeOperationName = keyof typeof NATIVE_OPERATIONS;
export const NATIVE_OPERATION_NAMES = Object.keys(
  NATIVE_OPERATIONS,
) as NativeOperationName[];
export interface SessionOperation {
  operation: NativeOperationName;
  sessionID: string;
  location: string;
  agent?: string;
  payload: Record<string, unknown>;
}
type Work = (client: OpenCodeClient, signal: AbortSignal) => Promise<unknown>;
const RECAP_PROMPT =
  "Recap this session for a coordinator who has not read it: the goal, what was done, the current state, open problems or failures, pending decisions, and next steps. Be concise and factual; mention subagent work only briefly.";
const simple = (execute: Work): PreparedOperation => ({
  subject: async () => null,
  execute,
});
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new Error("Expected a boolean native option");
}
function json(value: unknown, depth = 0): JsonValue {
  if (depth > 20) throw new Error("Native JSON value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => json(entry, depth + 1));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        json(entry, depth + 1),
      ]),
    );
  throw new Error("Expected a native JSON value");
}
export interface PreparedOperation {
  subject: Work;
  execute: Work;
}

function nativePermissions(
  value: unknown,
): NonNullable<SessionCreateInput["permissions"]> | undefined {
  if (value === undefined) return undefined;
  return list(value, (entry) => {
    const row = object(entry);
    exact(row, ["action", "resource", "effect"]);
    const effect = text(row.effect);
    if (effect !== "allow" && effect !== "deny" && effect !== "ask")
      throw new Error("Invalid native permission effect");
    return { action: text(row.action), resource: text(row.resource), effect };
  });
}
export function prepareNativeOperation(
  input: SessionOperation,
): PreparedOperation {
  const { operation, sessionID } = input;
  const value = object(input.payload);
  const definition = NATIVE_OPERATIONS[operation];
  if (!definition) throw new Error("Unsupported native session operation");
  if (Buffer.byteLength(JSON.stringify(value)) > PAYLOAD_BYTES)
    throw new Error("Oversized native operation payload");
  exact(value, Object.keys(definition.input.properties));
  const selectedSession = async (
    client: OpenCodeClient,
    signal: AbortSignal,
  ) => {
    const session = await client.session.get({ sessionID }, { signal });
    if (
      session.id !== sessionID ||
      session.location.directory !== input.location ||
      session.agent !== input.agent
    )
      throw new Error("Selected native operation target changed");
    return session;
  };
  switch (operation) {
    case "create_native_session": {
      const permissions = nativePermissions(value.permissions);
      let model: NonNullable<SessionCreateInput["model"]> | undefined;
      if (value.model !== undefined) {
        const row = object(value.model);
        exact(row, ["id", "providerID", "variant"]);
        model = {
          id: text(row.id),
          providerID: text(row.providerID),
          ...(row.variant === undefined ? {} : { variant: text(row.variant) }),
        };
      }
      const parentID =
        value.parentID === undefined ? undefined : text(value.parentID);
      const payload: SessionCreateInput = {
        id: sessionID,
        agent: input.agent,
        location: { directory: input.location },
        ...(value.title === undefined ? {} : { title: bulkText(value.title) }),
        ...(parentID === undefined ? {} : { parentID }),
        ...(model === undefined ? {} : { model }),
        ...(permissions === undefined ? {} : { permissions }),
        ...(value.metadata === undefined
          ? {}
          : {
              metadata: Object.fromEntries(
                Object.entries(object(value.metadata)).map(([key, entry]) => [
                  key,
                  json(entry),
                ]),
              ),
            }),
      };
      return {
        subject: async (client, signal) =>
          parentID === undefined
            ? null
            : client.session.get({ sessionID: parentID }, { signal }),
        execute: (client, signal) => client.session.create(payload, { signal }),
      };
    }
    case "import_session": {
      const transfer = object(value.transfer);
      exact(transfer, ["info", "messages"]);
      let payload: ExperimentalSessionImportInput;
      try {
        const info = Schema.decodeUnknownSync(Session.Info, {
          onExcessProperty: "error",
        })(transfer.info);
        const messages = Schema.decodeUnknownSync(
          Schema.Array(SessionMessage.Info),
          { onExcessProperty: "error" },
        )(transfer.messages);
        payload = JSON.parse(
          JSON.stringify({
            info: Schema.encodeUnknownSync(Session.Info)(info),
            messages: Schema.encodeUnknownSync(
              Schema.Array(SessionMessage.Info),
            )(messages),
            location: { directory: input.location },
          }),
        ) as ExperimentalSessionImportInput;
      } catch {
        // Native schema diagnostics embed transferred conversation content.
        throw new Error("Invalid native session transfer");
      }
      if (payload.info.id !== sessionID || payload.info.agent !== input.agent)
        throw new Error(
          "Native transfer identity does not match the selected import",
        );
      return simple((client, signal) =>
        client.experimental.session.import(payload, { signal }),
      );
    }
    case "create_session_form": {
      const id = text(value.formID),
        title = text(value.title);
      let fields: Form.Fields;
      try {
        fields = Schema.decodeUnknownSync(Form.Fields, {
          onExcessProperty: "error",
        })(value.fields);
      } catch {
        // Native schema errors include field contents; expose only the validation category.
        throw new Error("Invalid native form field definitions");
      }
      const metadata =
        value.metadata === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(object(value.metadata)).map(([key, entry]) => [
                key,
                json(entry),
              ]),
            );
      // The generated wire type omits optional undefined keys present in decoded native fields.
      const wireFields = JSON.parse(
        JSON.stringify(fields),
      ) as SessionFormCreateInput["fields"];
      return simple((client, signal) =>
        client.session.form.create(
          {
            sessionID,
            id,
            title,
            fields: wireFields,
            ...(metadata === undefined ? {} : { metadata }),
          },
          { signal },
        ),
      );
    }
    case "cancel_session_input":
    case "update_session_input": {
      const inboxID = text(value.inboxID);
      const delivery =
        operation === "update_session_input" ? text(value.delivery) : undefined;
      if (
        delivery !== undefined &&
        delivery !== "steer" &&
        delivery !== "queue"
      )
        throw new Error("Invalid native delivery option");
      return {
        async subject(client, signal) {
          const rows = await client.session.inbox.list(
            { sessionID },
            { signal },
          );
          const matches = rows.filter(
            (row) => row.id === inboxID && row.sessionID === sessionID,
          );
          if (matches.length !== 1)
            throw new Error("Selected native inbox item is unavailable");
          return matches[0];
        },
        execute: (client, signal) =>
          delivery === undefined
            ? client.session.inbox.cancel({ sessionID, inboxID }, { signal })
            : client.session.inbox.update(
                { sessionID, inboxID, delivery },
                { signal },
              ),
      };
    }
    case "cancel_session_form": {
      const formID = text(value.formID);
      return {
        async subject(client, signal) {
          const form = await client.session.form.get(
            { sessionID, formID },
            { signal },
          );
          if (
            form.id !== formID ||
            form.sessionID !== sessionID ||
            form.state.status !== "pending"
          )
            throw new Error("Native form changed or is no longer pending");
          return form;
        },
        execute: (client, signal) =>
          client.session.form.cancel({ sessionID, formID }, { signal }),
      };
    }
    case "fork_session": {
      const before =
        value.before === undefined ? undefined : text(value.before);
      return simple((client, signal) =>
        client.session.fork(
          { sessionID, ...(before === undefined ? {} : { before }) },
          { signal },
        ),
      );
    }
    case "switch_session_agent": {
      const agent = text(value.newAgent);
      return simple((client, signal) =>
        client.session.switchAgent({ sessionID, agent }, { signal }),
      );
    }
    case "switch_session_model": {
      const selected = object(value.model);
      exact(selected, ["id", "providerID", "variant"]);
      const model = {
        id: text(selected.id),
        providerID: text(selected.providerID),
        ...(selected.variant === undefined
          ? {}
          : { variant: text(selected.variant) }),
      };
      return simple((client, signal) =>
        client.session.switchModel({ sessionID, model }, { signal }),
      );
    }
    case "update_session": {
      const metadata =
        value.metadata === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(object(value.metadata)).map(([key, entry]) => [
                key,
                json(entry),
              ]),
            );
      const permissions = nativePermissions(value.permissions);
      const payload: SessionUpdateInput = {
        sessionID,
        ...(value.title === undefined ? {} : { title: bulkText(value.title) }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(permissions === undefined ? {} : { permissions }),
        ...(value.archived === undefined
          ? {}
          : { archived: optionalBoolean(value.archived) }),
      };
      return simple((client, signal) =>
        client.session.update(payload, { signal }),
      );
    }
    case "move_session": {
      const directory = text(value.workdir);
      if (!directory.startsWith("/"))
        throw new Error("Select an absolute native workdir");
      const delivery =
        value.delivery === undefined ? undefined : text(value.delivery);
      if (
        delivery !== undefined &&
        delivery !== "steer" &&
        delivery !== "queue"
      )
        throw new Error("Invalid native delivery option");
      return simple((client, signal) =>
        client.session.move(
          {
            sessionID,
            directory,
            ...(delivery === undefined ? {} : { delivery }),
          },
          { signal },
        ),
      );
    }
    case "interrupt_session": {
      const resume = optionalBoolean(value.resume);
      return simple((client, signal) =>
        client.session.interrupt(
          { sessionID, ...(resume === undefined ? {} : { resume }) },
          { signal },
        ),
      );
    }
    case "background_session":
      return simple((client, signal) =>
        client.session.background({ sessionID }, { signal }),
      );
    case "wait_session":
      return simple((client, signal) =>
        client.experimental.session.wait({ sessionID }, { signal }),
      );
    case "generate_session": {
      const prompt = bulkText(value.prompt);
      return simple((client, signal) =>
        client.session.generate({ sessionID, prompt }, { signal }),
      );
    }
    case "recap_session": {
      const focus =
        value.focus === undefined ? undefined : bulkText(value.focus);
      const prompt = [
        RECAP_PROMPT,
        ...(focus === undefined ? [] : [`Focus especially on: ${focus}`]),
      ].join("\n");
      return simple(async (client, signal) => {
        const recap = await client.session.generate(
          { sessionID, prompt },
          { signal },
        );
        const children: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined,
          complete = true;
        do {
          const page = await readNativeInventory(client, cursor, signal, {
            parentID: sessionID,
            includeArchived: true,
          });
          if (!page.available || page.deferred?.length) {
            complete = false;
            break;
          }
          for (const row of page.sessions)
            children.push({
              id: row.id,
              title: row.title,
              ...(row.agent ? { agent: row.agent } : {}),
              status: row.status,
              location: row.location,
              archived: row.archived,
            });
          cursor = page.cursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= 50)) {
            complete = false;
            break;
          }
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return { sessionID, recap, children, childrenComplete: complete };
      });
    }
    case "stage_session_revert": {
      const messageID = text(value.messageID),
        files = optionalBoolean(value.files);
      return simple((client, signal) =>
        client.session.revert.stage(
          { sessionID, messageID, ...(files === undefined ? {} : { files }) },
          { signal },
        ),
      );
    }
    case "clear_session_revert":
      return simple((client, signal) =>
        client.session.revert.clear({ sessionID }, { signal }),
      );
    case "commit_session_revert":
      return {
        subject: async (client, signal) =>
          (await selectedSession(client, signal)).revert ?? null,
        execute: (client, signal) =>
          client.session.revert.commit({ sessionID }, { signal }),
      };
    case "set_session_environment": {
      const variables = Object.fromEntries(
        Object.entries(object(value.variables)).map(([key, entry]) => {
          if (typeof entry !== "string")
            throw new Error("Native environment values must be strings");
          return [key, entry];
        }),
      );
      return simple((client, signal) =>
        client.session.environment({ sessionID, variables }, { signal }),
      );
    }
    case "put_session_instruction": {
      const key = text(value.key),
        entry = json(value.value);
      return simple((client, signal) =>
        client.experimental.session.instructions.entry.put(
          { sessionID, key, value: entry },
          { signal },
        ),
      );
    }
    case "remove_session_instruction": {
      const key = text(value.key);
      return simple((client, signal) =>
        client.experimental.session.instructions.entry.remove(
          { sessionID, key },
          { signal },
        ),
      );
    }
    case "mark_session_viewed": {
      const idle = value.idle;
      if (typeof idle !== "number" || !Number.isFinite(idle) || idle < 0)
        throw new Error("Invalid native idle timestamp");
      return simple((client, signal) =>
        client.session.view({ sessionID, idle }, { signal }),
      );
    }
    case "reply_permission": {
      const requestID = text(value.requestID);
      const decision = text(value.decision);
      if (decision !== "once" && decision !== "always" && decision !== "reject")
        throw new Error("Invalid native permission decision");
      const payload: PermissionReplyInput = {
        sessionID,
        requestID,
        decision,
        ...(value.message === undefined
          ? {}
          : { message: bulkText(value.message) }),
      };
      return {
        async subject(client, signal) {
          const request = await client.permission.get(
            { sessionID, requestID },
            { signal },
          );
          if (request.id !== requestID || request.sessionID !== sessionID)
            throw new Error("Native permission request changed");
          return request;
        },
        execute: (client, signal) =>
          client.permission.reply(payload, { signal }),
      };
    }
    case "reply_form": {
      const formID = text(value.formID);
      const answer: SessionFormReplyInput["answer"] = Object.fromEntries(
        Object.entries(object(value.answer)).map(([key, item]) => {
          if (
            typeof item === "boolean" ||
            typeof item === "string" ||
            (typeof item === "number" && Number.isFinite(item))
          )
            return [key, item];
          if (Array.isArray(item))
            return [
              key,
              list(item, (entry) => {
                if (typeof entry !== "string")
                  throw new Error(
                    "Native multiselect answers must contain strings",
                  );
                return entry;
              }),
            ];
          throw new Error("Invalid native form answer");
        }),
      );
      return {
        async subject(client, signal) {
          const form = await client.session.form.get(
            { sessionID, formID },
            { signal },
          );
          if (
            form.id !== formID ||
            form.sessionID !== sessionID ||
            form.state.status !== "pending"
          )
            throw new Error("Native form changed or is no longer pending");
          return form;
        },
        execute: (client, signal) =>
          client.session.form.reply({ sessionID, formID, answer }, { signal }),
      };
    }
    case "request_permission": {
      const payload: PermissionCreateInput = {
        sessionID,
        action: text(value.action),
        resources: list(value.resources, text),
        ...(value.save === undefined ? {} : { save: list(value.save, text) }),
      };
      return {
        subject: async () => null,
        execute: (client, signal) =>
          client.permission.create(payload, { signal }),
      };
    }
    case "remove_saved_permission": {
      const id = text(value.id);
      return {
        async subject(client, signal) {
          const session = await selectedSession(client, signal);
          const rows = await client.permission.saved.list(
            { projectID: session.projectID },
            { signal },
          );
          const matches = rows.filter(
            (row) => row.id === id && row.projectID === session.projectID,
          );
          if (matches.length !== 1)
            throw new Error(
              "Saved permission is unavailable in the selected project",
            );
          return matches[0];
        },
        execute: (client, signal) =>
          client.permission.saved.remove({ id }, { signal }),
      };
    }
  }
}

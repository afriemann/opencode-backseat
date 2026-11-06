import type {
  CreationHost,
  TaskGoal,
  WorkerBinding,
  WorkerSnapshot,
} from "../src/state.ts";
import {
  coordinatorAgent,
  type CoordinatorPermissionRule,
} from "../src/coordinator-agent.ts";
import type { NativeBackendHost } from "../src/server.ts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

export const coordinatorDefinition = {
  ...coordinatorAgent,
  permissions: coordinatorAgent.permissions.map((rule) => ({ ...rule })),
  request: { settings: {}, headers: {}, body: {} },
};

export const inheritedPolicy: CoordinatorPermissionRule[] = [
  { action: "question", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "git *", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "execute", resource: "*", effect: "allow" },
  { action: "browser", resource: "*", effect: "deny" },
];

export function fixtureApproval(
  home: string,
  coordinatorID = "coordinator",
): NativeBackendHost["permission"] {
  return {
    async assert(input) {
      if (
        input.sessionID !== coordinatorID ||
        ![
          "backseat.start_supervision",
          "backseat.resume",
          "backseat.adopt",
          "backseat.create",
          "backseat.share",
          "backseat.hold",
          "backseat.takeover",
          "backseat.delete_session",
        ].includes(input.action) ||
        !input.resources.length ||
        input.resources.some((resource) => {
          const value: unknown = JSON.parse(resource);
          return !Array.isArray(value) || value[0] !== home;
        })
      )
        throw new Error("Unapproved fixture control target");
    },
  };
}

export interface NativeObservationProof {
  snapshot: WorkerSnapshot;
  invalidation: number;
  registry: { incarnation: string; usable: boolean };
  runtime: { app: string; bun: string };
  modelCalls: number;
}

export async function captureNativeObservation(): Promise<{
  observation: NativeObservationProof;
  hostLog: string;
}> {
  const executable = Bun.which("opencode");
  if (!executable)
    throw new Error("Native host tests require opencode on PATH");
  const root = resolve(
    import.meta.dir,
    "../.opencode/backseat/native-fixtures",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, "observation-"));
  const probe = join(home, "probe");
  await mkdir(probe, { mode: 0o700 });
  const stream =
    [
      {
        choices: [
          {
            delta: { content: "Local native fixture finished" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  const model = createServer((request, response) => {
    request.resume();
    if (
      request.method !== "POST" ||
      request.url !== "/chat/completions" ||
      request.headers.authorization
    ) {
      response.writeHead(403).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(stream);
  });
  await new Promise<void>((ready, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", () => {
      model.removeListener("error", reject);
      ready();
    });
  });
  const address = model.address();
  if (!address || typeof address === "string")
    throw new Error("Native fixture has no owned loopback address");
  const endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
  let hostLog = "";
  try {
    await writeFile(
      join(probe, "package.json"),
      JSON.stringify({ type: "module", exports: { ".": "./server.js" } }),
    );
    await writeFile(
      join(probe, "server.js"),
      `
import { Plugin } from "@opencode/plugin";
import { realpath, writeFile } from "node:fs/promises";
import { createWorkerObserver, workerObservationKeys } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
export default Plugin.define({id:"backseat",async setup(ctx){
  const home=${JSON.stringify(home)},endpoint=${JSON.stringify(endpoint)},abort=new AbortController();
  let modelCalls=0,writing=Promise.resolve();
  await ctx.session.hook("title",event=>{event.result="Local native observation fixture"});
  await ctx.session.hook("http.request",event=>{
    if(event.model.providerID!=="backseat-fixture"||event.model.id!=="local"||event.kind!=="primary"||event.request.url!==endpoint||event.request.method!=="POST")throw new Error("Unowned model route is forbidden");
    event.request=new Request(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:event.request.body,signal:event.request.signal,redirect:"error",duplex:"half"});
    modelCalls++;
  });
  await ctx.session.hook("experimental.ws.handshake",()=>{throw new Error("Model WebSocket is forbidden")});
  const observer=await createWorkerObserver({session:ctx.session,storage:ctx.storage,canonical:realpath,plugin:ctx.plugin},home,home);
  await ctx.session.hook("experimental.idle",event=>observer.idle(event));
  void(async()=>{try{for await(const event of ctx.event.subscribe({signal:abort.signal})){
    await observer.event(event);
    if(event.type==="session.execution.succeeded"||event.type==="session.idle"){
      const sessionID=event.data.sessionID,keys=workerObservationKeys(home,home,sessionID);
      writing=writing.then(async()=>{const snapshot=await ctx.storage.get(keys.snapshot);if(snapshot)await writeFile(home+"/proof.json",JSON.stringify({snapshot,invalidation:(await ctx.storage.get(keys.invalidation))??0,registry:await ctx.storage.get(keys.observer),runtime:{app:ctx.app.version,bun:Bun.version},modelCalls}))});
      await writing;
    }
  }}catch(error){if(!abort.signal.aborted)process.stderr.write(JSON.stringify({service:"native-fixture",message:"Observation fixture failed",errorClass:error?.constructor?.name})+"\\n")}})();
  return async()=>{abort.abort();await writing;await observer.dispose()};
}});
`,
    );
    await writeFile(
      join(home, "opencode.json"),
      JSON.stringify({
        model: "backseat-fixture/local",
        providers: {
          "backseat-fixture": {
            package: "@opencode/ai/providers/openai-compatible",
            env: [],
            settings: { baseURL: endpoint.replace(/\/chat\/completions$/, "") },
            models: { local: {} },
          },
        },
        plugins: [{ package: probe }],
      }),
    );
    const child = spawn(
      executable,
      [
        "run",
        "--standalone",
        "--print-logs",
        "Inspect the owned local fixture.",
      ],
      {
        cwd: home,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8",
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (bytes) => {
      hostLog = (hostLog + String(bytes)).slice(-200000);
    });
    child.stderr.on("data", (bytes) => {
      hostLog = (hostLog + String(bytes)).slice(-200000);
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Native observation fixture timed out"));
      }, 45000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) done();
        else
          reject(
            new Error(`Native observation fixture exited ${code}: ${hostLog}`),
          );
      });
    });
    const observation = JSON.parse(
      await readFile(join(home, "proof.json"), "utf8"),
    ) as NativeObservationProof;
    if (!observation.snapshot || !observation.registry)
      throw new Error("Native observation proof is unavailable");
    return { observation, hostLog };
  } finally {
    model.closeAllConnections();
    await new Promise<void>((done, reject) =>
      model.close((error) => (error ? reject(error) : done())),
    );
    await rm(home, { recursive: true, force: true });
  }
}

export const goal: TaskGoal = {
  id: "api-task",
  title: "Endpoint update",
  goal: "Update the endpoint",
  criteria: ["Endpoint returns the approved response"],
  constraints: ["Keep current permissions"],
  scope: ["Endpoint implementation"],
  location: "/projects/api",
  agent: "engineer",
};

export function creationHost(
  options: { location?: boolean; agent?: boolean } = {},
) {
  const events: string[] = [],
    starts: Array<{ sessionID: string; text: string }> = [],
    saved: WorkerBinding[] = [];
  const host: CreationHost = {
    async locationExists() {
      return options.location ?? true;
    },
    async agentAvailable(location, agent) {
      events.push(`agent:${location}:${agent}`);
      return options.agent ?? true;
    },
    async approve() {
      events.push("approval");
    },
    async create(input) {
      events.push("create");
      return { id: "worker-api", agent: input.agent, location: input.location };
    },
    async prompt(input) {
      events.push("prompt");
      starts.push(input);
    },
    async save(binding) {
      saved.push(binding);
    },
  };
  return { host, events, starts, saved };
}

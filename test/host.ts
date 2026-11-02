import type { CreationHost, TaskGoal, WorkerBinding } from "../src/state.ts";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  watch,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerSnapshot } from "../src/state.ts";
import { Rpc } from "@opencode/plugin/rpc";
import { createServer } from "node:http";
import type { NativeBackendHost } from "../src/server.ts";
import {
  coordinationStatusDetails,
  coordinatorHomeDetails,
} from "../src/ui.ts";

/** A scoped approval boundary, not an unconditional permission fake. */
export function fixtureApproval(
  home: string,
  coordinatorID = "coordinator",
): NativeBackendHost["permission"] {
  return {
    async assert(input) {
      if (
        input.sessionID !== coordinatorID ||
        ![
          "conman.attach",
          "conman.resume",
          "conman.adopt",
          "conman.create",
          "conman.share",
          "conman.hold",
          "conman.takeover",
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

const fixtureDefinition = Rpc.define({
  id: "conman.native-observation-fixture",
  methods: {
    proof: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
});
const fixtureRpc = `import { Rpc } from "@opencode/plugin/rpc"; export const FixtureRpc = Rpc.define(${JSON.stringify(fixtureDefinition)});`;

const nativeModelProbe = (home: string, endpoint: string) => `
import { Plugin } from "@opencode/plugin";
import { realpath } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { FixtureRpc } from "./rpc.js";
import { createWorkerObserver, workerObservationKeys } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
export default Plugin.define({id:"conman",async setup(ctx){
  const home=${JSON.stringify(home)}, abort=new AbortController(), completed=new Set(), waiters=new Map();
  let modelCalls=0;
  const trace=value=>appendFileSync(home+"/model-trace.jsonl",JSON.stringify(value)+"\\n");
  const endpoint=${JSON.stringify(endpoint)};
  await ctx.session.hook("title",event=>{event.result="Local native observation fixture"});
  await ctx.session.hook("http.request",event=>{
    trace({hook:"http.request",kind:event.kind,model:event.model,ownedURL:event.request.url===endpoint,method:event.request.method});
    if(event.model.providerID!=="conman-fixture"||event.model.id!=="local"||event.kind!=="primary"||
      event.request.url!==endpoint||event.request.method!=="POST")
      throw new Error("External model HTTP is forbidden in the local fixture");
    event.request=new Request(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:event.request.body,signal:event.request.signal,redirect:"error",duplex:"half"});
    modelCalls++;
  });
  await ctx.session.hook("experimental.ws.handshake",()=>{throw new Error("Model WebSocket is forbidden in the local fixture")});
  const observer=await createWorkerObserver({session:ctx.session,storage:ctx.storage,canonical:realpath,plugin:ctx.plugin},home,home);
  await ctx.session.hook("experimental.idle",event=>observer.idle(event));
  await ctx.rpc.register(FixtureRpc,{proof:async({sessionID})=>{
    if(!completed.has(sessionID))await new Promise(resolve=>waiters.set(sessionID,resolve));
    const keys=workerObservationKeys(home,home,sessionID);
    return {snapshot:await ctx.storage.get(keys.snapshot),invalidation:(await ctx.storage.get(keys.invalidation))??0,
      registry:await ctx.storage.get(keys.observer),runtime:{app:ctx.app.version,bun:Bun.version},modelCalls};
  }});
  void(async()=>{try{for await(const event of ctx.event.subscribe({signal:abort.signal})){
    if(event.type.startsWith("session."))trace({event:event.type});
    await observer.event(event);
    if(event.type==="session.execution.succeeded"){
      completed.add(event.data.sessionID);waiters.get(event.data.sessionID)?.();waiters.delete(event.data.sessionID);
    }
  }}catch(error){if(!abort.signal.aborted)process.stderr.write(JSON.stringify({service:"native-fixture",message:String(error)})+"\\n")}})();
  return async()=>{abort.abort();await observer.dispose()};
}});
`;

async function localModelServer() {
  // @opencode/ai 2.2.5 openai-compatible-chat reuses OpenAIChat.protocol:
  // choices[].delta.content, finish_reason, usage, then the SSE [DONE] sentinel.
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
  const server = createServer((request, response) => {
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
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      ready();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Native fixture has no owned loopback address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((closed, reject) =>
        server.close((error) => (error ? reject(error) : closed())),
      );
    },
  };
}

export interface NativeCoordinatorProof {
  stage: string;
  error?: string;
  home: string;
  workerHome: string;
  runtime: { app: string; bun: string };
  passive?: unknown;
  denied?: boolean;
  observation?: unknown;
  snapshot?: unknown;
  validation?: unknown;
  admission?: unknown;
  requests: Array<{ kind: string; tools?: string[] }>;
}

// This plugin guards transport only. Product server owns observation, RPC,
// permissions, validation and persistence; no fixture publishes observations.
const nativeFlowGuard = (home: string, endpoint: string) => `
import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
export default Plugin.define({id:"conman.native-flow-driver",async setup(ctx){
  const endpoint=${JSON.stringify(endpoint)},home=${JSON.stringify(home)};
  await ctx.session.hook("title",event=>{event.result="Owned coordinator flow"});
  await ctx.session.hook("http.request",event=>{
    if(event.model.providerID!=="conman-fixture"||event.model.id!=="local"||
      !["primary","generate"].includes(event.kind)||event.request.url!==endpoint||event.request.method!=="POST")
      throw new Error("Unowned model route is forbidden");
    appendFileSync(home+"/flow-route.jsonl",JSON.stringify({kind:event.kind})+"\\n");
    event.request=new Request(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:event.request.body,signal:event.request.signal,redirect:"error",duplex:"half"});
  });
  await ctx.session.hook("experimental.ws.handshake",()=>{throw new Error("Model WebSocket is forbidden")});
}});
`;

const nativeFlowDriver = (options: Record<string, unknown>) => `
import { Plugin } from "@opencode/plugin/tui";
import { writeFileSync } from "node:fs";
import { ConmanRpc, reasoningPayload } from ${JSON.stringify(new URL("../src/rpc.ts", import.meta.url).href)};
import { createObserverCapability } from ${JSON.stringify(new URL("../src/ownership.ts", import.meta.url).href)};
import { readNativeObservation } from ${JSON.stringify(new URL("../src/tui.ts", import.meta.url).href)};
import { decisionIdentity, fingerprint } from ${JSON.stringify(new URL("../src/context.ts", import.meta.url).href)};
import { followupText } from ${JSON.stringify(new URL("../src/dispatch.ts", import.meta.url).href)};
export default Plugin.define({id:"conman.native-flow-driver",setup(ctx){
  const o=${JSON.stringify(options)},signal=AbortSignal.timeout(20000),client=ctx.client,rpc=client.rpc(ConmanRpc);
   const proof={stage:"bootstrap",home:o.home,workerHome:o.workerHome,runtime:{app:ctx.app.version,bun:Bun.version},requests:[]};
   const errorMessage=error=>error?.message??error?.reason??error?.data?.message??String(error);
  writeFileSync(o.pid,JSON.stringify({pid:process.pid}));
  const record=stage=>{proof.stage=stage;writeFileSync(o.proof,JSON.stringify(proof))};
  let expected,terminal,sequence=0,generation,binding;
  const remove=ctx.data.listen(({details:event})=>{
    if(event.type==="permission.asked"){
      const pending=expected;
      if(!pending||(event.location&&event.location.directory!==o.home)||event.data.sessionID!==pending.sessionID||
        event.data.action!==pending.action||JSON.stringify(event.data.resources)!==JSON.stringify(pending.resources)){
        proof.unexpectedAsk={location:event.location,sessionID:event.data.sessionID,action:event.data.action,resources:event.data.resources,
          expected:pending?{sessionID:pending.sessionID,action:pending.action,resources:pending.resources}:undefined};
        proof.error="Unexpected native permission request; no reply issued";record("unexpected-ask");return;
      }
      expected=undefined;
      void(async()=>{try{
        const inventory=await client.permission.request.list({location:{directory:o.home}},{signal});
        const session=await client.session.get({sessionID:pending.sessionID},{signal});
        if(session.location.directory!==o.home||session.id!==pending.sessionID||session.time.archived)throw new Error("Permission coordinator left owned home");
         if(inventory.location.directory!==o.home||!inventory.data.some(r=>r.id===event.data.id&&r.sessionID===pending.sessionID&&r.action===pending.action&&JSON.stringify(r.resources)===JSON.stringify(pending.resources)))
           throw new Error("Permission request not confirmed in owned inventory");
         await pending.verify?.();
         pending.asked=true;
        await client.permission.reply({sessionID:pending.sessionID,requestID:event.data.id,decision:pending.decision},{signal});
       }catch(error){proof.error=errorMessage(error);record("permission-reply-failed")}})();
    }
    if(event.type==="session.execution.succeeded"&&terminal?.sessionID===event.data.sessionID){terminal.resolve();terminal=undefined;}
  });
  const run=async(sessionID,text,id)=>{
    const completed=new Promise((resolve,reject)=>{terminal={sessionID,resolve};signal.addEventListener("abort",()=>reject(new Error("Native terminal event unavailable")),{once:true})});
    const admitted=await client.session.prompt({sessionID,text,resume:true,...(id?{id}: {})},{signal});
    await completed;return admitted;
  };
  queueMicrotask(async()=>{try{
    proof.passive=await rpc.inspect({},{location:{directory:o.workerHome},signal});
    if(proof.passive.authority!=="passive"||proof.passive.home!==o.home)throw new Error("Worker location did not bootstrap product passive observer");
    const agents=await client.agent.list({location:{directory:o.workerHome}},{signal});
    const agent=agents.data.find(a=>!a.hidden&&a.mode!=="subagent");
    if(agents.location.directory!==o.workerHome||!agent)throw new Error("Native target agent unavailable");
    const coordinator=await client.session.create({title:"Owned coordinator",agent:agent.id,location:{directory:o.home}},{signal});
    const worker=await client.session.create({title:"Owned worker",agent:agent.id,location:{directory:o.workerHome}},{signal});
    const capability=createObserverCapability();
    const attachRequest={coordinatorID:coordinator.id,verifier:capability.verifier};
    const resources=[JSON.stringify([o.home,coordinator.id,capability.verifier,1])];
    record("attach-denial");
    const denied={sessionID:coordinator.id,action:"conman.attach",resources,decision:"reject"};expected=denied;
    let denialError;
    try{await rpc.attach(attachRequest,{location:{directory:o.home},signal})}catch(error){denialError=error;}
    if(!denied.asked||!denialError)throw new Error("Native denial did not reject attach");
    const afterDenial=await rpc.inspect({},{location:{directory:o.home},signal});
    if(afterDenial.observer)throw new Error("Denied attach persisted observer authority");
    proof.denied=true;
    record("attach-approval");
    const approved={sessionID:coordinator.id,action:"conman.attach",resources,decision:"once"};expected=approved;
    generation=(await rpc.attach(attachRequest,{location:{directory:o.home},signal})).generation;
    if(!approved.asked)throw new Error("Attach bypassed scripted native approval");
    const goal={id:"owned-seed-task",title:"Inspect owned seed",goal:"Read the owned seed file",criteria:["Owned seed contents inspected by native read"],
      constraints:["Read only the owned seed file; no external requests"],scope:[o.seed],location:o.workerHome,agent:agent.id};
    const control=async(operation,body,zero=false)=>rpc.control({operation,taskID:goal.id,proof:capability.sign(generation,++sequence,
      {operation,taskID:goal.id,revision:zero?0:binding.revision,epoch:zero?0:binding.epoch,body})},{location:{directory:o.home},signal});
    record("adopt");
    const adoption={sessionID:coordinator.id,action:"conman.adopt",resources:[JSON.stringify([o.home,goal,worker.id])],decision:"once"};expected=adoption;
    const adopted=await control("adopt",{goal,workerID:worker.id},true);
    binding=adopted.snapshot.bindings[0];
    if(!adoption.asked||!adopted.accepted||binding.workerID!==worker.id||binding.location!==o.workerHome)throw new Error("Approved native adoption did not bind owned worker");
    record("worker-read");await run(worker.id,"Read only this owned seed file: "+o.seed);
    record("observe");
     let observed=await rpc.observe({taskID:goal.id,workerID:worker.id},{location:{directory:o.home},signal});
    if(!observed.snapshot)throw new Error("Product worker observation unavailable: "+observed.reason);
    proof.passiveSnapshot=observed.snapshot;
    const page=await client.message.list({sessionID:worker.id,limit:200,order:"asc"},{signal});
    proof.historyMetadata={count:page.data.length,hasNext:!!page.cursor.next,hasPrevious:!!page.cursor.previous,types:page.data.map(message=>message.type),
      tools:page.data.flatMap(message=>message.type==="assistant"?message.content.filter(part=>part.type==="tool").map(part=>({messageID:message.id,callID:part.id,name:part.name,status:part.state.status,executed:part.executed,time:part.time,input:part.state.input,result:part.state.content})):[])};
    let observation;
    try{observation=await readNativeObservation(client,binding,[],signal,observed.snapshot)}catch(error){
      if(String(error).includes("Cursor cannot be combined with order")&&page.cursor.next){
        const continuation=await client.message.list({sessionID:worker.id,limit:200,cursor:page.cursor.next},{signal});
        proof.historyMetadata.continuationWithoutOrder={count:continuation.data.length,hasNext:!!continuation.cursor.next,types:continuation.data.map(message=>message.type)};
      }
      throw error;
    }
    proof.observation=observation;
    if(observation.state!=="settled"||observation.asks.length){
      const replay=[];
      for await(const event of client.experimental.session.log({sessionID:worker.id,follow:false},{signal})){
        if(replay.length>=1000)throw new Error("Diagnostic replay exceeds bound");
        replay.push({type:event.type,seq:event.durable?.seq,sessionID:event.data?.sessionID,assistantMessageID:event.data?.assistantMessageID,keys:Object.keys(event)});
      }
      proof.replay=replay;
      const replayFromZero=[];
      for await(const event of client.experimental.session.log({sessionID:worker.id,after:0,follow:false},{signal})){
        if(replayFromZero.length>=1000)throw new Error("Diagnostic zero-cursor replay exceeds bound");
        replayFromZero.push({type:event.type,seq:event.durable?.seq,sessionID:event.data?.sessionID,assistantMessageID:event.data?.assistantMessageID,keys:Object.keys(event)});
      }
      proof.replayFromZero=replayFromZero;
      throw new Error("Native full-client correlation did not settle: "+observation.state);
     }
     record("resume");
     const reconciliation={generation,workerID:worker.id,revision:binding.revision,epoch:binding.epoch,
       snapshotFingerprint:fingerprint(observed.snapshot),observedAt:Date.now(),state:observation.state,asks:[...observation.asks]};
     const resumeBody={reconciliation};
     const verifyResume=async()=>{
       // Do not recursively enter serialized coordinator RPC during its native
       // ask. Full native client reads remain live; the server checks its fresh
       // worker snapshot/context again after this actual permission reply.
       const read=await readNativeObservation(client,binding,[],signal,observed.snapshot);
       if(read.state!=="settled"||read.asks.length||fingerprint(observed.snapshot)!==reconciliation.snapshotFingerprint||fingerprint(read.context)!==fingerprint(observation.context))
         throw new Error("Resume native reconciliation changed around approval");
     };
     await verifyResume();
     const resume={sessionID:coordinator.id,action:"conman.resume",resources:[JSON.stringify([o.home,binding.id,binding.revision,binding.epoch,resumeBody])],decision:"once",verify:verifyResume};expected=resume;
     const resumed=await control("resume",resumeBody,false);
    if(!resume.asked||!resumed.accepted)throw new Error("Native resume was not explicitly approved");
     binding=resumed.snapshot.bindings[0];
     observed=await rpc.observe({taskID:goal.id,workerID:worker.id},{location:{directory:o.home},signal});
     observation=await readNativeObservation(client,binding,[],signal,observed.snapshot);
     if(observation.state!=="settled"||observation.asks.length||fingerprint(observed.snapshot)!==reconciliation.snapshotFingerprint)throw new Error("Native resume eligibility changed");
    const entries=observation.context.evidence;
    if(!entries.some(e=>e.kind==="tool"&&e.native?.state==="completed"&&JSON.stringify(e.input).includes(o.seed)&&JSON.stringify(e.result).includes(o.seedContent))){
      // Failure-only diagnostics; never synchronize the product observer or
      // substitute this read for the correlation/provenance gates above.
      proof.nativeProjection=await client.session.get({sessionID:worker.id},{signal});
      throw new Error("No current completed native read inputs/results support owned seed criterion");
    }
    const evidence={taskID:goal.id,workerID:worker.id,turn:observation.turn,entries};
    record("suggest");
     const suggestInput={taskID:goal.id,revision:binding.revision,epoch:binding.epoch,generation,evidence};
     const issued=await rpc.suggest({...suggestInput,proof:capability.sign(generation,++sequence,reasoningPayload("suggest",suggestInput))},{location:{directory:o.home},signal});
    if(!issued.suggestion||issued.suggestion.action!==o.action)throw new Error("Product did not issue expected task-only suggestion: "+issued.reason);
    const identity=decisionIdentity(binding,generation,evidence,observed.snapshot,issued.suggestion);
     const validateInput={generation,identity,evidence,suggestion:issued.suggestion};
     record("validate");proof.validation=await rpc.validate({...validateInput,proof:capability.sign(generation,++sequence,reasoningPayload("validate",validateInput))},{location:{directory:o.home},signal});
    if(proof.validation.status!=="accept"){
      proof.validationState=await rpc.inspect({},{location:{directory:o.home},signal});
      proof.validationObserved=await rpc.observe({taskID:goal.id,workerID:worker.id},{location:{directory:o.home},signal});
      proof.validationIdentity=identity;
      throw new Error("Product validation did not accept inspected evidence: "+proof.validation.rationale);
    }
    if(o.action==="continue"){
      const intent={id:"msg_owned-original-followup",taskID:goal.id,workerID:worker.id,identity:fingerprint(identity),text:followupText(binding,issued.suggestion.nextStep),nonprogress:0,status:"reserved"};
      record("reserve");const reserved=await control("reserve",{intent,decisionAt:Date.now(),receiptID:proof.validation.receiptID,identity});
      if(!reserved.accepted||reserved.snapshot.bindings[0].followups!==1)throw new Error("Follow-up was not durably reserved exactly once");
      const stored=reserved.snapshot.intents[0].intent;
       record("follow-up");proof.admission=await run(worker.id,stored.text,stored.id);
       if(proof.admission.id!==stored.id)throw new Error("Native prompt changed persisted original ID");
       const delivered=await client.message.list({sessionID:worker.id,order:"asc",limit:200},{signal});
       let deliveryPage=delivered,deliveryFound=false,deliveryCount=0;
       const deliveryCursors=new Set();
       for(;;){
         deliveryCount+=deliveryPage.data.length;if(deliveryCount>200)throw new Error("Native delivery history exceeds bound");
         deliveryFound ||= deliveryPage.data.some(message=>message.type==="user"&&message.id===stored.id);
         const cursor=deliveryPage.cursor.next;if(!cursor)break;
         if(deliveryCursors.has(cursor))throw new Error("Native delivery cursor repeated");deliveryCursors.add(cursor);
         deliveryPage=await client.message.list({sessionID:worker.id,limit:200,cursor},{signal});
       }
       if(!deliveryFound)throw new Error("Original persisted prompt ID absent from native delivered user history");
       proof.deliveryIdentity={sessionID:worker.id,callerID:stored.id,deliveredUserID:stored.id};
      proof.snapshot=(await control("finish",{intentID:stored.id,status:"admitted"})).snapshot;
    }else{
      record("record-completion");proof.snapshot=(await control("record",{result:{status:"complete",reason:"Current native read inputs and results independently inspected"},receiptID:proof.validation.receiptID,identity})).snapshot;
    }
    record("done");
   }catch(error){proof.error??=errorMessage(error);proof.stack=error?.stack;
     proof.failure={type:error?.type,tag:error?._tag,name:error?.name,code:error?.code,message:error?.message,reason:error?.reason};
     record(proof.stage)}finally{remove()}});
  return remove;
}});
`;

export async function captureNativeCoordinator(
  action: "continue" | "complete",
): Promise<NativeCoordinatorProof> {
  const root = resolve(import.meta.dir, "../.opencode/conman/native-fixtures");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(join(root, "flow-"));
  const home = join(fixture, "coordinator"),
    workerHome = join(fixture, "worker"),
    probe = join(home, "probe");
  await mkdir(home, { mode: 0o700 });
  await mkdir(workerHome, { mode: 0o700 });
  await mkdir(probe, { mode: 0o700 });
  const seed = join(workerHome, "owned-seed.txt"),
    seedContent = "Owned fixture seed: native read evidence";
  await writeFile(seed, seedContent);
  const requests: NativeCoordinatorProof["requests"] = [];
  let reads = 0;
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/chat/completions" ||
        request.headers.authorization
      ) {
        response.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 200000)
          throw new Error("Owned model request exceeds bound");
      }
      const input = JSON.parse(body) as {
        messages: Array<{ content?: unknown; role: string }>;
        tools?: Array<{
          type: string;
          function?: {
            name: string;
            description: string;
            parameters: {
              properties?: Record<
                string,
                { type?: string; description?: string }
              >;
              required?: string[];
            };
          };
        }>;
      };
      const prompt = input.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n");
      let delta: unknown,
        finish = "stop";
      if (prompt.includes("Return ONLY strict JSON")) {
        requests.push({ kind: "validation" });
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as {
          context: {
            evidence: Array<{
              native?: unknown;
              input?: unknown;
              result?: unknown;
            }>;
          };
        };
        const entry = data.context.evidence.find(
          (e) =>
            e.native &&
            JSON.stringify(e.input).includes(seed) &&
            JSON.stringify(e.result).includes(seedContent),
        );
        const judgment = entry
          ? {
              status: "accept",
              rationale:
                "The actual completed native read inspected the owned seed only.",
              ...(action === "complete"
                ? {
                    criteria: [
                      {
                        criterion:
                          "Owned seed contents inspected by native read",
                        status: "accept",
                        rationale:
                          "Native read input identifies owned seed and result includes exact seed contents.",
                        evidence: [entry.native],
                      },
                    ],
                  }
                : {}),
            }
          : {
              status: "unknown",
              rationale: "No inspected current read supports this judgment.",
            };
        delta = { content: JSON.stringify(judgment) };
      } else if (prompt.includes("Return only a JSON suggestion")) {
        requests.push({ kind: "suggestion" });
        const context = JSON.parse(
          prompt.slice(prompt.lastIndexOf("\n") + 1),
        ) as {
          task: { id: string; workerID: string; scope: string[] };
          evidence: Array<{
            id: string;
            native?: unknown;
            input?: unknown;
            result?: unknown;
          }>;
        };
        const entry = context.evidence.find(
          (e) =>
            e.native &&
            JSON.stringify(e.input).includes(seed) &&
            JSON.stringify(e.result).includes(seedContent),
        );
        if (!entry)
          throw new Error("Suggestion has no inspectable owned native read");
        delta = {
          content: JSON.stringify({
            taskID: context.task.id,
            workerID: context.task.workerID,
            action,
            ...(action === "complete"
              ? {
                  support: [
                    {
                      criterion: "Owned seed contents inspected by native read",
                      evidenceID: entry.id,
                    },
                  ],
                }
              : {
                  nextStep: "Read the owned seed file again: " + seed,
                  scope: context.task.scope,
                  progress: true,
                }),
          }),
        };
      } else if (reads === 0) {
        const tools =
          input.tools?.flatMap((tool) =>
            tool.function ? [tool.function] : [],
          ) ?? [];
        requests.push({
          kind: "worker-read",
          tools: tools.map((tool) => tool.name),
        });
        const tool = tools.find(
          (tool) => /read/i.test(tool.name) && /file/i.test(tool.description),
        );
        const properties = tool?.parameters.properties ?? {};
        const path = Object.entries(properties).find(
          ([key, value]) => value.type === "string" && /path/i.test(key),
        );
        if (
          !tool ||
          !path ||
          tool.parameters.required?.some((key) => key !== path[0])
        )
          throw new Error(
            "Actual native catalog has no supported file-read schema",
          );
        reads++;
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "owned-native-read",
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify({ [path[0]]: seed }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else {
        requests.push({ kind: "worker-finish" });
        delta = { content: "Owned native read finished." };
      }
      const events = [
        { choices: [{ delta, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: finish }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
          "data: [DONE]\n\n",
      );
    } catch (error) {
      requests.push({ kind: `error:${String(error)}` });
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      ready();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned flow listener unavailable");
  const endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
  let stopped = true;
  try {
    const proofPath = join(home, "flow-proof.json"),
      pidPath = join(home, "flow-pid.json");
    await writeFile(
      join(probe, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { ".": "./server.js", "./tui": "./tui.js" },
      }),
    );
    await writeFile(join(probe, "server.js"), nativeFlowGuard(home, endpoint));
    await writeFile(
      join(probe, "tui.js"),
      nativeFlowDriver({
        action,
        home,
        workerHome,
        seed,
        seedContent,
        proof: proofPath,
        pid: pidPath,
      }),
    );
    const config = {
      model: "conman-fixture/local",
      providers: {
        "conman-fixture": {
          package: "@opencode/ai/providers/openai-compatible",
          env: [],
          settings: { baseURL: endpoint.replace(/\/chat\/completions$/, "") },
          models: { local: {} },
        },
      },
      plugins: [
        { package: resolve(import.meta.dir, ".."), options: { home } },
        { package: probe },
      ],
    };
    await writeFile(join(home, "opencode.json"), JSON.stringify(config));
    await writeFile(join(workerHome, "opencode.json"), JSON.stringify(config));
    const child = spawn(
      "/usr/bin/script",
      [
        "-q",
        "-f",
        "-e",
        "-c",
        "exec /usr/bin/opencode --standalone",
        "/dev/null",
      ],
      {
        cwd: home,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8",
          TERM: "xterm-256color",
          COLUMNS: "100",
          LINES: "30",
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    stopped = false;
    let terminal = "";
    child.stdout?.on("data", (bytes) => {
      terminal = (terminal + String(bytes)).slice(-200000);
    });
    child.stderr?.on("data", (bytes) => {
      terminal = (terminal + String(bytes)).slice(-200000);
    });
    try {
      const proof = await readCapture<NativeCoordinatorProof>(
        proofPath,
        (value) => value.stage === "done" || !!value.error,
      );
      proof.requests = requests;
      await writeFile(
        `/tmp/opencode/conman-review-frontend-native-flow-${action}-proof.log`,
        JSON.stringify(proof),
      );
      return proof;
    } finally {
      await writeFile(
        `/tmp/opencode/conman-review-frontend-native-flow-${action}-terminal.log`,
        terminal,
      );
      await writeFile(
        `/tmp/opencode/conman-review-frontend-native-flow-${action}-host.log`,
        await readFile(
          join(home, "data/opencode/log/opencode.log"),
          "utf8",
        ).catch(() => "Native log unavailable"),
      );
      await writeFile(
        `/tmp/opencode/conman-review-frontend-native-flow-${action}-requests.log`,
        JSON.stringify(requests),
      );
      const pid = JSON.parse(
        await readFile(pidPath, "utf8").catch(() => "{}"),
      ) as { pid?: number };
      await stopNative(child, home, pid.pid);
      stopped = true;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((closed, reject) =>
      server.close((error) => (error ? reject(error) : closed())),
    );
    if (stopped) await rm(fixture, { recursive: true, force: true });
  }
}

export interface NativeFrame {
  commands?: Array<{ id?: string; title?: string; slash?: { name: string } }>;
  pid: number;
  width: number;
  height: number;
  text: string;
  pages?: string[];
  spans: Array<{
    text: string;
    fg: number[];
    bg: number[];
    attributes: number;
  }>;
}

const nativeProbe = (options: Record<string, unknown>) => `
import { Plugin } from "@opencode/plugin/tui";
import { writeFileSync } from "node:fs";
import { applyNativeNoColor, coordinationStatusDetails, overview, sharedVersionDetails, supervisionChoices } from ${JSON.stringify(new URL("../src/ui.ts", import.meta.url).href)};
import { setupNativeTui } from ${JSON.stringify(new URL("../src/tui.ts", import.meta.url).href)};
import { FixtureRpc } from "./rpc.js";
export default Plugin.define({ id: ${JSON.stringify(options.modelTurn ? "conman" : "conman.native-frame-probe")}, setup(context) {
  const o = ${JSON.stringify(options)};
  writeFileSync(o.optionsLog, JSON.stringify({ pid: process.pid, keys: Object.keys(context.options), widthType: typeof context.options.width, bun: globalThis.Bun?.version }));
  context.renderer.resize(o.width, o.height);
  const restore = applyNativeNoColor(context.renderer);
  const pages = [];
  const capture = buffer => {
    if (buffer.width !== o.width || buffer.height !== o.height) return;
    const text = new TextDecoder().decode(buffer.getRealCharBytes(true));
      if (!o.discovery && !o.startup && !text.includes(o.versions ? "Shared versions" : "Coordinate / search") && !text.includes("Status (read only)")) return;
     if (((o.statusReason && text.includes("Status (read only)")) || (o.startup && text.includes("Canonical home"))) && !pages.includes(text)) pages.push(text);
    const spans = buffer.getSpanLines().flatMap(line => line.spans.map(span => ({
      text: span.text, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes,
    })));
      writeFileSync(o.frame, JSON.stringify({ pid: process.pid, width: buffer.width, height: buffer.height, text, spans, pages,
        commands: o.discovery ? context.keymap.commands().filter(command=>command.id?.startsWith("conman.")).map(command=>({id:command.id,title:command.title,slash:command.slash})) : undefined }));
  };
  context.renderer.addPostProcessFn(capture);
  if(o.startup){
    const close=setupNativeTui(context);
    queueMicrotask(()=>{
      if(o.startup === "supervision") void context.ui.dialog.select(supervisionChoices());
      else context.keymap.dispatch("conman.overview");
    });
    return ()=>{close();context.renderer.removePostProcessFn(capture);restore()};
  }
  if(o.discovery){
    const close=setupNativeTui(context);
    queueMicrotask(()=>context.keymap.dispatch("command.palette.show"));
    return ()=>{close();context.renderer.removePostProcessFn(capture);restore()};
  }
  let action;
   const actions = ["Create", "Adopt", "Open", "Share", "Hold", "Resume", "Manual"].map((title, i) => ({
    title, bind: ["alt+c", "alt+a", "alt+o", "alt+s", "alt+h", "alt+r", "alt+t"][i],
    selection: "none", onTrigger() { action = title; },
  }));
  queueMicrotask(async () => {
    if(o.modelTurn){
      const session=await context.client.session.create({title:"Local native observation fixture",location:{directory:o.home}});
      await context.client.session.prompt({sessionID:session.id,text:"Finish the local fixture without tools or external requests.",resume:true});
      const signal=AbortSignal.timeout(15000);
      const proof=await context.client.rpc(FixtureRpc).proof({sessionID:session.id},{location:{directory:o.home},signal});
      writeFileSync(o.proof,JSON.stringify(proof));
    }
      const status = { title: "Status", bind: "alt+i", selection: "none", onTrigger() { action = "Status"; context.ui.dialog.clear(); } };
      let selected = await context.ui.dialog.select(o.versions ? sharedVersionDetails(o.bindings[0], o.width) :
        { ...overview(o.bindings, o.state, o.bindings[0].workerID, o.width, o.nativeStatus), actions: o.state === "ready" ? actions : [status] });
      if (action === "Status") selected = await context.ui.dialog.select(coordinationStatusDetails(o.bindings, o.state, o.statusReason, o.width, o.nativeStatus));
     writeFileSync(o.selection, JSON.stringify({ selected, action, closed: true }));
  });
  return () => { context.renderer.removePostProcessFn(capture); restore(); };
}});
`;

async function readCapture<T>(
  path: string,
  accept: (value: T) => boolean,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const read = async () => {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      return accept(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const events = watch(resolve(path, ".."), { signal: controller.signal });
    const first = await read();
    if (first) return first;
    for await (const event of events) {
      if (event.filename === path.split("/").at(-1)) {
        const value = await read();
        if (value) return value;
      }
    }
    throw new Error("Native capture stream ended");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function stopNative(
  process: ChildProcess,
  home: string,
  nativePID?: number,
) {
  if (nativePID) {
    const cwd = await readlink(`/proc/${nativePID}/cwd`).catch(() => undefined);
    const command = await readFile(`/proc/${nativePID}/cmdline`, "utf8").catch(
      () => "",
    );
    if (cwd !== home || !command.includes("--standalone"))
      throw new Error("Refusing to stop an unverified native fixture process");
    globalThis.process.kill(nativePID, "SIGTERM");
  }
  if (process.exitCode !== null) return;
  await new Promise<void>((resolveClose, reject) => {
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      reject(new Error("Private native host did not close"));
    }, 5000);
    process.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
}

export async function captureNativeOverview(
  bindings: readonly WorkerBinding[],
  width: number,
  height: number,
  noColor = false,
  nativeStatus: Record<string, "needs-input" | "running"> = {},
  modelTurn = false,
  state: import("../src/ui.ts").UiState = "ready",
  versions = false,
  statusReason?: string,
  discovery = false,
  startup: false | "session" | "supervision" = false,
) {
  const root = resolve(import.meta.dir, "../.opencode/conman/native-fixtures");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, "host-"));
  const probe = join(home, "probe");
  await mkdir(probe, { mode: 0o700 });
  const modelServer = modelTurn ? await localModelServer() : undefined;
  let nativeStopped = true;
  try {
    const framePath = join(home, "frame.json"),
      selectionPath = join(home, "selection.json"),
      optionsLog = join(home, "probe-options.json"),
      proofPath = join(home, "proof.json");
    await writeFile(
      join(probe, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          ".": "./server.js",
          "./tui": "./tui.js",
          "./rpc": "./rpc.js",
        },
      }),
    );
    await writeFile(join(probe, "rpc.js"), fixtureRpc);
    await writeFile(
      join(probe, "server.js"),
      modelServer
        ? nativeModelProbe(home, modelServer.endpoint)
        : startup
          ? `import {Plugin} from "@opencode/plugin";
import {Rpc} from "@opencode/plugin/rpc";
import {writeFileSync} from "node:fs";
import {ConmanRpc} from ${JSON.stringify(new URL("../src/rpc.ts", import.meta.url).href)};
export default Plugin.define({id:"conman.native-frame-probe",async setup(ctx){
  await ctx.session.hook("context",()=>{throw new Error("Model requests are forbidden in startup fixtures")});
  const rpc=Rpc.define({id:ConmanRpc.id,methods:{inspect:ConmanRpc.methods.inspect,attach:ConmanRpc.methods.attach},events:{}});
  await ctx.rpc.register(rpc,{
    inspect:async()=>({version:1,home:${JSON.stringify(home)},authority:"owned",bindings:[],snapshots:[],intents:[],completions:[]}),
    attach:async({coordinatorID})=>{
      const session=await ctx.session.get({sessionID:coordinatorID});
      const messages=await ctx.session.context({sessionID:coordinatorID});
      writeFileSync(${JSON.stringify(proofPath)},JSON.stringify({sessionID:session.id,location:session.location.directory,messages:messages.length}));
      throw new Error("Startup fixture intentionally withholds attachment approval");
    }
  });
}});`
          : 'import { Plugin } from "@opencode/plugin"; export default Plugin.define({id:"conman.native-frame-probe",async setup(ctx){await ctx.session.hook("context",()=>{throw new Error("Model requests are forbidden in native rendering fixtures")});}});',
    );
    await writeFile(
      join(probe, "tui.js"),
      nativeProbe({
        bindings,
        width,
        height,
        nativeStatus,
        modelTurn,
        state,
        versions,
        statusReason,
        discovery,
        startup,
        home,
        proof: proofPath,
        frame: framePath,
        selection: selectionPath,
        optionsLog,
      }),
    );
    await writeFile(
      join(home, "opencode.json"),
      JSON.stringify({
        ...(modelServer
          ? {
              model: "conman-fixture/local",
              providers: {
                "conman-fixture": {
                  package: "@opencode/ai/providers/openai-compatible",
                  env: [],
                  settings: {
                    baseURL: modelServer.endpoint.replace(
                      /\/chat\/completions$/,
                      "",
                    ),
                  },
                  models: { local: {} },
                },
              },
            }
          : {}),
        plugins: [
          {
            package: probe,
            options: {
              bindings,
              width,
              height,
              nativeStatus,
              frame: framePath,
              selection: selectionPath,
            },
          },
        ],
      }),
    );
    const child = spawn(
      "/usr/bin/script",
      [
        "-q",
        "-f",
        "-e",
        "-c",
        "exec /usr/bin/opencode --standalone",
        "/dev/null",
      ],
      {
        cwd: home,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8",
          TERM: "xterm-256color",
          COLUMNS: String(width),
          LINES: String(height),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
          ...(noColor ? { NO_COLOR: "1" } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    nativeStopped = false;
    let terminal = "",
      frame: NativeFrame | undefined;
    child.stdout?.on("data", (bytes) => {
      terminal = (terminal + String(bytes)).slice(-200000);
    });
    child.stderr?.on("data", (bytes) => {
      terminal = (terminal + String(bytes)).slice(-200000);
    });
    try {
      if (startup) {
        frame = await readCapture<NativeFrame>(framePath, (value) =>
          value.text.includes(
            startup === "supervision" ? "Connected" : "Get started",
          ),
        );
        const first = frame;
        if (startup === "supervision") {
          child.stdin?.write("\u001b[B\r");
          await writeFile(
            `/tmp/opencode/conman-startup-${width}-supervision.json`,
            JSON.stringify(first, null, 2),
          );
          return { frame: first, terminal };
        }
        child.stdin?.write("\r");
        const sessionChoice = await readCapture<NativeFrame>(
          framePath,
          (value) => value.text.includes("Set up coordinator"),
        );
        child.stdin?.write("\u001b[B\r");
        let homeDetails = await readCapture<NativeFrame>(framePath, (value) =>
          value.text.includes("Canonical home"),
        );
        const segments = coordinatorHomeDetails(home, width).options;
        for (let index = 1; index < segments.length; index++) {
          child.stdin?.write("\u001b[B");
          homeDetails = await readCapture<NativeFrame>(
            framePath,
            (value) =>
              value.text.includes("Canonical home") &&
              value.text.includes(segments[index]!.title),
          );
        }
        child.stdin?.write("\u001b");
        await readCapture<NativeFrame>(framePath, (value) =>
          value.text.includes("Set up coordinator"),
        );
        await writeFile(
          `/tmp/opencode/conman-startup-${width}-home.json`,
          JSON.stringify(homeDetails, null, 2),
        );
        child.stdin?.write("\r");
        const proof = await readCapture<{
          sessionID: string;
          location: string;
          messages: number;
        }>(proofPath, (value) => typeof value.sessionID === "string");
        await writeFile(
          `/tmp/opencode/conman-startup-${width}-overview.json`,
          JSON.stringify(first, null, 2),
        );
        await writeFile(
          `/tmp/opencode/conman-startup-${width}-session.json`,
          JSON.stringify(sessionChoice, null, 2),
        );
        return {
          frame: first,
          sessionChoice,
          startupProof: {
            ...proof,
            canonicalHome: home,
            homeReadable: segments.every((segment) =>
              [homeDetails.text, ...(homeDetails.pages ?? [])].some((page) =>
                page.includes(segment.title),
              ),
            ),
          },
          terminal,
        };
      }
      if (discovery) {
        frame = await readCapture<NativeFrame>(framePath, (value) =>
          value.text.includes("Commands"),
        );
        child.stdin?.write("coord");
        const palette = await readCapture<NativeFrame>(
          framePath,
          (value) =>
            value.text.includes("Commands") &&
            /^\s+coord\s*$/m.test(value.text),
        );
        await writeFile(
          "/tmp/opencode/conman-command-palette.json",
          JSON.stringify(palette, null, 2),
        );
        if (
          !palette.commands?.some((command) => command.id === "conman.overview")
        )
          return { frame: palette, terminal };
        child.stdin?.write("\u001b");
        await readCapture<NativeFrame>(
          framePath,
          (value) => !value.text.includes("Commands"),
        );
        child.stdin?.write("/coord");
        const slash = await readCapture<NativeFrame>(
          framePath,
          (value) =>
            !value.text.includes("Commands") &&
            value.text.includes("/coordinate"),
        );
        await writeFile(
          "/tmp/opencode/conman-command-slash.json",
          JSON.stringify(slash, null, 2),
        );
        return { frame: palette, slash, terminal };
      }
      frame = await readCapture<NativeFrame>(
        framePath,
        (value) =>
          value.width === width &&
          value.height === height &&
          value.text.includes(
            versions ? "Shared versions" : "Coordinate / search",
          ),
      );
      if (statusReason) {
        child.stdin?.write("\u001bi");
        frame = await readCapture<NativeFrame>(framePath, (value) =>
          value.text.includes("Status (read only)"),
        );
        const rows = coordinationStatusDetails(
          bindings,
          state,
          statusReason,
          width,
          nativeStatus,
        ).options;
        for (let row = 1; row < rows.length; row++) {
          child.stdin?.write("\u001b[B");
          await new Promise((resolveFrame) => setTimeout(resolveFrame, 50));
          frame = await readCapture<NativeFrame>(framePath, (value) =>
            value.text.includes(rows[row]!.title),
          );
        }
      }
      child.stdin?.write(
        statusReason
          ? "\r"
          : versions
            ? "\u001b[B\r"
            : state === "ready"
              ? "\u001b[B\u001bt\r"
              : "\u001b",
      );
      const selection = await readCapture<{
        selected?: string | number;
        action?: string;
        closed?: boolean;
      }>(selectionPath, (value) => value.closed === true);
      const observation = modelTurn
        ? (JSON.parse(
            await readFile(proofPath, "utf8"),
          ) as NativeObservationProof)
        : undefined;
      if (observation)
        await writeFile(
          "/tmp/opencode/conman-review-frontend-native-observation-proof.log",
          JSON.stringify(observation),
        );
      return {
        frame,
        selection: selection.selected,
        action: selection.action,
        terminal,
        observation,
      };
    } finally {
      await writeFile(
        modelTurn
          ? "/tmp/opencode/conman-review-frontend-native-model-terminal.log"
          : `/tmp/opencode/conman-review-frontend-native-terminal-${width}-${versions ? "versions" : state}${statusReason ? "-status" : ""}${noColor ? "-no-color" : ""}.log`,
        terminal,
      );
      if (modelTurn)
        await writeFile(
          "/tmp/opencode/conman-review-frontend-native-model-host.log",
          await readFile(
            join(home, "data/opencode/log/opencode.log"),
            "utf8",
          ).catch(() => "Native log unavailable"),
        );
      if (modelTurn)
        await writeFile(
          "/tmp/opencode/conman-review-frontend-native-local-trace.log",
          await readFile(join(home, "model-trace.jsonl"), "utf8").catch(
            () => "Native trace unavailable",
          ),
        );
      const setup = JSON.parse(
        await readFile(optionsLog, "utf8").catch(() => "{}"),
      ) as { pid?: number; keys?: string[]; widthType?: string; bun?: string };
      await writeFile(
        "/tmp/opencode/conman-review-frontend-native-probe-options.log",
        JSON.stringify(setup),
      );
      if (frame)
        await writeFile(
          `/tmp/opencode/conman-review-frontend-native-frame-${width}-${versions ? "versions" : state}${statusReason ? "-status" : ""}${noColor ? "-no-color" : ""}.log`,
          JSON.stringify(frame),
        );
      await stopNative(child, home, frame?.pid ?? setup.pid);
      nativeStopped = true;
    }
  } finally {
    await modelServer?.close();
    if (nativeStopped) await rm(home, { recursive: true, force: true });
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
  const events: string[] = [];
  const starts: Array<{ sessionID: string; text: string }> = [];
  const saved: WorkerBinding[] = [];
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

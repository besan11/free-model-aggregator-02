// free-model-aggregator-02: one server, two client wires, and a real free
// model behind every answer.
//
// The trial runs this server as `node main.ts` from the repository's root,
// with Node 22's standard library alone (nothing is installed; TypeScript
// runs directly, and a relative import needs its .ts extension). The env is
// at $MAKEFUN_ENV_URL; model calls go through the grader's gateway at
// $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter
// on the key the entrant pushed to the competition. The brief at
// $MAKEFUN_PROMPT_FILE carries two documents:
//   - the free model list: each free OpenRouter model's gateway id
//     (`openrouter/<vendor>/<model>:free`), its published rating in
//     milli-points, what it can do (tools, vision, JSON mode, context
//     length) and its free flag;
//   - the six prompts: each one's id, its api (openai or anthropic),
//     whether it streams, its weight (1 or 2) and the requirements a model
//     must meet to serve it. Each prompt carries a unique token the answer
//     must contain.
// The server:
//   1. listens on 0.0.0.0 at a free port (never 8080: the env itself is
//      there on one layout);
//   2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port":
//      <port>, "catalog": <catalog>};
//   3. serves GET /v1/models (answering in the shape of the auth header it
//      got: x-api-key means Anthropic, Authorization means OpenAI), POST
//      /v1/chat/completions and POST /v1/messages, each with a JSON body
//      or with server-sent events;
//   4. answers each prompt by dialling ONE free model through the gateway.
//      OPENAI_API_KEY in the sandbox is a dummy the gateway swaps for the
//      OpenRouter key the entrant pushed; the real key never enters the
//      sandbox;
//   5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the
//      env says {"done": true}. A process still running when the wall ends
//      scores zero, so never wait for anything else.
// `node main.ts --list` prints the same catalog JSON and exits 0 before
// any server starts; the register body's catalog is that same document,
// byte for byte.
//
// ROUTING (quality is 60% of the score)
//   Every prompt is served by the highest-rated free model that meets its
//   requirements, read off the request body itself: tools declared, a
//   JSON-mode response_format, or image content. The brief's ratings are
//   the currency: inkling-2-small (1475) leads the plain prompts, and
//   nemotron-3.5-super-vl (1303) leads the JSON-mode ones. Ranking by
//   rating, never by the brief's order, is what the baseline leaves on the
//   table.
//
// FAILOVER (10%) AND COOLDOWNS
//   A gateway call answered with a 4xx or a 5xx is not an answer. A
//   refusal that is a rate limit (429) or a server error (5xx) first gets
//   one bounded same-model retry after a fixed wait: a limit that clears
//   on the second ask is an answer from the best model, and the first
//   refusal still rides in the header behind it. A model that refuses
//   twice, or refuses with any other status, is skipped for the rest of
//   the trial, so one rate-limited model never takes every later prompt
//   down with it, and the prompt fails over to the next-highest-rated
//   free model that meets it. When a retry or a failover serves a prompt,
//   the refusals ride on the response in the header
//   x-makefun-upstream-failures, a JSON array of at most 8 rows, each
//   {"status": <number>, "code": "<string>", "model": "<id or null>"}.
//   The tie-break is the number of gateway calls, so the first attempt is
//   always the best model: a retry costs a call only when a refusal has
//   already happened, and the retry is what keeps the best model serving
//   instead of the next one down. The wait is a fixed constant, so it
//   changes no answer: whether a retry happens is a function of the
//   gateway's answers alone, and a replay sees the same ones.
//
// THE MODEL FIELD
//   Whatever this server reports in a response's `model` field must be the
//   model it actually dialled. The house records every gateway call and
//   scores the model that really answered. This server sends the brief's
//   model id in the gateway request and puts that same id back on every
//   answer and every streamed chunk (the provider's own answer spells it
//   without the gateway's `openrouter/` prefix), so its claim is the call
//   it made, never another.
//
// REPLAY
//   A trial is replayed, and the export must match: every route is a
//   function of the requests and the gateway's answers seen so far, never
//   of the wall clock. The refused set is a function of the gateway's
//   refusals; the model lists use fixed timestamps; no Date.now() appears
//   in any routing decision.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/brief.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this entry reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The output cap a model call carries when the client named none: the gateway refuses an uncapped call. */
const DEFAULT_MAX_TOKENS = 1024;
/** The most tokens one model call asks for: the gateway refuses a call over its cap. */
const MAX_TOKENS_CAP = 4096;
/** The most refusal rows the upstream-failures header carries. */
const MAX_FAILURE_ROWS = 8;
/** The fixed wait, in milliseconds, before one same-model retry of a refused gateway call. */
const RETRY_DELAY_MS = 500;

/** Whether a gateway refusal is worth one same-model retry: a rate limit or a server error. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A fixed wait: the same-model retry's delay. It changes no answer, only when it is asked. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);

/** Model ids that refused a gateway call in this trial: skipped for the rest of it. */
const refusedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the
 * OpenAI-compatible root (`…/v1` on the trial network); a base that does
 * not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The free models that can serve a prompt, best first: the brief's
 * rating_milli descending, the id ascending as the deterministic
 * tie-break. A model that refused earlier in this trial is out.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => !refusedModels.has(model.id) && meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The requirements of a prompt, read off its own request body. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** One refusal row for the upstream-failures header. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway's error code from its body, or its status text when it names none. */
function errorCodeOf(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === 'string' && parsed.error.code !== '') {
      return parsed.error.code;
    }
    if (isRecord(parsed) && typeof parsed.code === 'string' && parsed.code !== '') return parsed.code;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `http_${status}`;
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** The gateway body this entry sends: the client's, with the dialled model and a capped output. */
function gatewayBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const asked = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? body.max_tokens : undefined;
  const cap = typeof body.max_completion_tokens === 'number' && Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : undefined;
  const want = asked ?? cap ?? DEFAULT_MAX_TOKENS;
  out.max_tokens = Math.min(Math.max(1, Math.floor(want)), MAX_TOKENS_CAP);
  if (cap !== undefined) out.max_completion_tokens = out.max_tokens;
  return out;
}

/** One gateway call for a model: an answer, a refusal with its error code, or a gateway that could not be reached. */
type Attempt =
  | { kind: 'answer'; upstream: Response }
  | { kind: 'refused'; status: number; code: string }
  | { kind: 'unreachable'; message: string };

/**
 * Dial the gateway once for one model and sort the outcome: an answer
 * keeps its body unread, a refusal is read for its error code, and a
 * thrown fetch is an unreachable gateway. The caller decides what a
 * refusal earns: a retry, a failover, or nothing.
 */
async function attempt(model: string, body: Json): Promise<Attempt> {
  let upstream: Response;
  try {
    upstream = await dial(model, gatewayBody(body, model));
  } catch (err) {
    return { kind: 'unreachable', message: (err as Error).message };
  }
  if (upstream.ok) return { kind: 'answer', upstream };
  const text = await upstream.text().catch(() => '');
  return { kind: 'refused', status: upstream.status, code: errorCodeOf(upstream.status, text) };
}

/**
 * Dial the gateway for one prompt, best model first. A model that refuses
 * with a rate limit or a server error gets one bounded same-model retry
 * after a fixed wait: a refusal that clears on the second ask is an
 * answer, and the first refusal still rides in the header behind it. A
 * model that refuses twice, or refuses with any other status, is skipped
 * for the rest of the trial, and the prompt fails over to the
 * next-highest-rated free model that meets it. Returns the first answer
 * that arrived, with the refusal trail behind it, or null when every
 * candidate refused.
 */
async function serve(
  requires: Requirement,
  body: Json,
): Promise<{ model: string; upstream: Response; failures: FailureRow[] } | null> {
  const failures: FailureRow[] = [];
  for (const candidate of candidatesFor(requires)) {
    const first = await attempt(candidate.id, body);
    if (first.kind === 'answer') return { model: candidate.id, upstream: first.upstream, failures };
    if (first.kind === 'unreachable') {
      refusedModels.add(candidate.id);
      failures.push({ status: 0, code: 'upstream_unreachable', model: candidate.id });
      log(`gateway unreachable for ${candidate.id}: ${first.message}`);
      continue;
    }
    if (!isRetryable(first.status)) {
      refusedModels.add(candidate.id);
      failures.push({ status: first.status, code: first.code, model: candidate.id });
      log(`gateway refused ${candidate.id} with HTTP ${first.status}`);
      continue;
    }
    await wait(RETRY_DELAY_MS);
    const second = await attempt(candidate.id, body);
    if (second.kind === 'answer') {
      failures.push({ status: first.status, code: first.code, model: candidate.id });
      return { model: candidate.id, upstream: second.upstream, failures };
    }
    refusedModels.add(candidate.id);
    failures.push({ status: first.status, code: first.code, model: candidate.id });
    if (second.kind === 'refused') {
      failures.push({ status: second.status, code: second.code, model: candidate.id });
      log(`gateway refused ${candidate.id} twice: HTTP ${first.status}, then HTTP ${second.status}`);
    } else {
      log(`gateway refused ${candidate.id} with HTTP ${first.status}, then unreachable: ${second.message}`);
    }
  }
  return null;
}

/** The refusal trail as the response header the failover column reads, or null when there is none. */
function failuresHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, MAX_FAILURE_ROWS)) };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await serve(requirementsFromBody(body), body);
  if (served === null) {
    return sendError(res, 'openai', 502, 'upstream_error', 'every free model that meets this request refused the gateway call');
  }
  const { model, upstream, failures } = served;
  if (upstream.body === null) return sendError(res, 'openai', 502, 'upstream_error', 'the gateway answered with no body');
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await serve(requirementsFromBody(body), anthropicToOpenAI(body, 'auto'));
  if (served === null) {
    return sendError(res, 'anthropic', 502, 'api_error', 'every free model that meets this request refused the gateway call');
  }
  const { model, upstream, failures } = served;
  if (upstream.body === null) return sendError(res, 'anthropic', 502, 'api_error', 'the gateway answered with no body');
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}

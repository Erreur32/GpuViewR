import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmProbe, digestFromModelfile, normalizeEndpoint, parseDefaultGateway, serverPort } from "./llmProbe.js";
import { classifyLLM, sanitizeCustomRules, setCustomLLMRules } from "./llmClassifier.js";
import type { AgentGpuProcess } from "./processes.js";

const BLOB = "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597";

function row(over: Partial<AgentGpuProcess>): AgentGpuProcess {
  return {
    pid: 1, process_name: "x", gpu_uuid: "u", used_memory: 0, type: "C",
    command: null, cpu_pct: null, gpu_pct: null, ...over,
  };
}

/** Fake fetch answering from a URL → JSON map; records calls. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
    const key = init?.body ? `${url} ${init.body}` : url;
    if (!(key in routes)) throw new Error("ECONNREFUSED");
    const text = JSON.stringify(routes[key]);
    return { ok: true, text: async () => text, headers: { get: () => null } };
  };
  return { fn, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("normalizeEndpoint: http(s) only, no credentials", () => {
  assert.equal(normalizeEndpoint("http://10.0.0.5:8080/"), "http://10.0.0.5:8080");
  assert.equal(normalizeEndpoint("https://llm.lan/base//"), "https://llm.lan/base");
  assert.equal(normalizeEndpoint("file:///etc/passwd"), null);
  assert.equal(normalizeEndpoint("http://user:pw@host"), null);
  assert.equal(normalizeEndpoint("not a url"), null);
});

test("serverPort: --port value or runtime default", () => {
  assert.equal(serverPort("/app/llama-server -hf x --port 8081", "llamacpp"), 8081);
  assert.equal(serverPort("/app/llama-server --port=9000", "llamacpp"), 9000);
  assert.equal(serverPort("/app/llama-server -m a.gguf", "llamacpp"), 8080);
  assert.equal(serverPort("vllm serve x", "vllm"), 8000);
  assert.equal(serverPort("x --port 99999", "llamacpp"), null);
});

test("digestFromModelfile: FROM line of /api/show", () => {
  assert.equal(digestFromModelfile(`# Modelfile\nFROM /root/.ollama/models/blobs/sha256-${BLOB}\nTEMPLATE x`), `sha256:${BLOB}`);
  assert.equal(digestFromModelfile("FROM llama3"), null);
});

test("enrich: Ollama runner named from /api/ps + /api/show, with unload time", async () => {
  const expires = new Date(Date.now() + 21 * 60_000).toISOString();
  const { fn } = fakeFetch({
    "http://127.0.0.1:11434/api/ps": { models: [{ name: "qwen3-4b-instruct:64k", expires_at: expires }] },
    'http://127.0.0.1:11434/api/show {"model":"qwen3-4b-instruct:64k"}': { modelfile: `FROM /root/.ollama/models/blobs/sha256-${BLOB}\n` },
  });
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  const runner = row({
    llm_runtime: "ollama", llm_model: "sha256:3605803b982c", llm_hint: "ollama_manifests", used_memory: 13_000,
    command: `/usr/lib/ollama/llama-server --model /root/.ollama/models/blobs/sha256-${BLOB} --port 42291`,
  });
  probe.enrich([runner]);
  await settle();
  const [out] = probe.enrich([runner]);
  assert.equal(out.llm_model, "qwen3-4b-instruct:64k");
  assert.equal(out.llm_hint, null);
  assert.equal(out.llm_state, "loaded");
  assert.ok(out.llm_expires_at && Math.abs(out.llm_expires_at - Date.parse(expires) / 1000) < 2);
  assert.equal(probe.ollamaNameByDigest(`sha256:${BLOB}`), "qwen3-4b-instruct:64k");
});

test("enrich: llama.cpp asleep, served name only replaces an unfriendly one", async () => {
  const { fn } = fakeFetch({ "http://127.0.0.1:8080/v1/models": { data: [{ id: "qwen3-coder-30b" }] } });
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  const named = row({ llm_runtime: "llamacpp", llm_model: "Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M", command: "/app/llama-server -hf x --port 8080", used_memory: 1 });
  const unnamed = row({ pid: 2, llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server --port 8080", used_memory: 20_000 });
  probe.enrich([named, unnamed]);
  await settle();
  const [a, b] = probe.enrich([named, unnamed]);
  assert.equal(a.llm_model, "Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M");
  assert.equal(a.llm_state, "idle");
  assert.equal(b.llm_model, "qwen3-coder-30b");
  assert.equal(b.llm_hint, null);
  assert.equal(b.llm_state, "loaded");
});

test("enrich: unreachable servers and non-LLM rows are left alone, polls throttled", async () => {
  const { fn, calls } = fakeFetch({});
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  const named = row({ llm_runtime: "llamacpp", llm_model: "a.gguf", command: "/app/llama-server -m a.gguf", used_memory: 5000 });
  const unnamed = row({ pid: 3, llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server", used_memory: 5000 });
  const xorg = row({ pid: 9, process_name: "Xorg" });
  for (let i = 0; i < 5; i++) probe.enrich([named, unnamed, xorg]);
  await settle();
  const [a, b, c] = probe.enrich([named, unnamed, xorg]);
  assert.equal(a.llm_model, "a.gguf");
  assert.equal(b.llm_model, null);
  assert.deepEqual(c, xorg);
  // One poll per period for the unnamed server, none for the named one.
  assert.equal(calls.filter((x) => x.includes(":8080/v1/models")).length, 1);
});

test("enrich: containerised llama.cpp never guessed on 127.0.0.1, configured URL used instead", async () => {
  // jarvis: llama.cpp listens on 8080 in its container, published as 8081;
  // the host's 8080 is another service.
  const { fn, calls } = fakeFetch({
    "http://127.0.0.1:8080/v1/models": { data: [{ id: "WRONG-other-service" }] },
    "http://192.168.32.210:8081/v1/models": { data: [{ id: "qwen3-coder-30b" }] },
  });
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  probe.setEndpoints(["http://192.168.32.210:8081"]);
  const r = row({ llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server --port 8080", used_memory: 9000, container_id: "9692a12ef6f9" });
  probe.enrich([r]);
  await settle();
  assert.equal(probe.enrich([r])[0].llm_model, "qwen3-coder-30b");
  assert.equal(calls.some((c) => c.includes("127.0.0.1:8080")), false);
});

test("enrich: Docker agent never guesses 127.0.0.1 for llama.cpp", async () => {
  const { fn, calls } = fakeFetch({ "http://127.0.0.1:8080/v1/models": { data: [{ id: "WRONG" }] } });
  const probe = createLlmProbe({ hostNetwork: false, fetchImpl: fn });
  const r = row({ llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server --port 8080", used_memory: 9000 });
  probe.enrich([r]);
  await settle();
  assert.equal(probe.enrich([r])[0].llm_model, null);
  assert.equal(calls.some((c) => c.includes("127.0.0.1:8080")), false);
});

test("enrich: configured endpoint used for a server on the same port", async () => {
  const { fn } = fakeFetch({ "http://192.168.32.210:8080/v1/models": { data: [{ id: "remote-alias" }] } });
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  probe.setEndpoints(["http://192.168.32.210:8080/", "ftp://nope"]);
  const r = row({ llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server --port 8080", used_memory: 9000 });
  probe.enrich([r]);
  await settle();
  probe.enrich([r]);
  await settle();
  assert.equal(probe.enrich([r])[0].llm_model, "remote-alias");
});

test("custom rules: checked first, model from flag or fixed, bad rules dropped", () => {
  const rules = sanitizeCustomRules([
    { match: "my-server", runtime: "MyServer", model_flag: "--weights" },
    { match: "tabby", runtime: "TabbyAPI", model: "fixed-name" },
    { match: "", runtime: "x" },
    { match: "y", runtime: "x", model_flag: "no-dash" },
    "junk",
  ]);
  assert.equal(rules.length, 3);
  assert.equal(rules[2].model_flag, undefined);
  setCustomLLMRules(rules);
  try {
    assert.deepEqual(classifyLLM("/opt/my-server --weights /m/mistral.gguf"), { runtime: "MyServer", model: "mistral.gguf", hint: null });
    assert.deepEqual(classifyLLM("python -m tabbyAPI.main"), { runtime: "TabbyAPI", model: "fixed-name", hint: null });
    // A custom rule wins over the built-in llama.cpp pattern.
    setCustomLLMRules([{ match: "llama-server", runtime: "Custom" }]);
    assert.equal(classifyLLM("/app/llama-server -m a.gguf").runtime, "Custom");
  } finally {
    setCustomLLMRules([]);
  }
  assert.equal(classifyLLM("/app/llama-server -m a.gguf").runtime, "llamacpp");
});

test("enrich: oversized or control-character answers are ignored", async () => {
  const huge = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(64 * 1024).fill(32)); },
  });
  const fn = async (url: string) => {
    if (url.endsWith("/api/ps")) return { ok: true, headers: { get: () => null }, body: huge, text: async () => "" };
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: "evil\u001b[31m" }] }) };
  };
  const probe = createLlmProbe({ hostNetwork: true, fetchImpl: fn });
  const r = row({ llm_runtime: "llamacpp", llm_model: null, llm_hint: "no_model", command: "/app/llama-server", used_memory: 9000 });
  const o = row({ pid: 5, llm_runtime: "ollama", command: `/usr/bin/ollama runner --model /x/blobs/sha256-${BLOB}`, used_memory: 9000 });
  probe.enrich([r, o]);
  await settle();
  const [a, b] = probe.enrich([r, o]);
  assert.equal(a.llm_model, null);
  assert.equal(b.llm_model, undefined);
});

test("parseDefaultGateway: /proc/net/route of the jarvis sidecar", () => {
  const table = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");
  assert.equal(parseDefaultGateway(table), "172.20.0.1");
  assert.equal(parseDefaultGateway("Iface\tDestination\tGateway\neth0\t000014AC\t00000000"), null);
  assert.equal(parseDefaultGateway(""), null);
});

test("enrich: Docker agent finds Ollama on its gateway, never on 127.0.0.1 alone", async () => {
  const { fn, calls } = fakeFetch({
    "http://172.20.0.1:11434/api/ps": { models: [{ name: "hermes3:8b", expires_at: new Date(Date.now() + 12 * 60_000).toISOString() }] },
    'http://172.20.0.1:11434/api/show {"model":"hermes3:8b"}': { modelfile: `FROM /root/.ollama/models/blobs/sha256-${BLOB}\n` },
  });
  const probe = createLlmProbe({ hostNetwork: false, gateway: "172.20.0.1", fetchImpl: fn });
  const r = row({ llm_runtime: "ollama", llm_model: "hermes3:8b", command: `/usr/lib/ollama/llama-server --model /root/.ollama/models/blobs/sha256-${BLOB} --port 33097`, used_memory: 13_000 });
  probe.enrich([r]);
  await settle();
  const [out] = probe.enrich([r]);
  assert.ok(out.llm_expires_at, "unload time from the gateway Ollama");
  assert.ok(calls.some((c) => c.startsWith("GET http://172.20.0.1:11434/api/ps")));
  // A host-network agent does not add the gateway.
  const { fn: fn2, calls: calls2 } = fakeFetch({});
  const hostProbe = createLlmProbe({ hostNetwork: true, gateway: "172.20.0.1", fetchImpl: fn2 });
  hostProbe.enrich([r]);
  await settle();
  assert.equal(calls2.some((c) => c.includes("172.20.0.1")), false);
});


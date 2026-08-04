import { WebSocket } from "ws";

const RELAY = "wss://llmmb.parumatov.com";
const TOKEN = "probe-token-0123456789abcdef0123456789abcdef";
const TYPES = ["session.list", "session.snapshot", "turn.start", "session.new", "provider.status"];
const verdict = {};

const host = new WebSocket(RELAY, { perMessageDeflate: false });
host.on("error", (e) => { console.log("host ERROR", e.message); process.exit(1); });
host.on("open", () => host.send(JSON.stringify({ relayProtocolVersion: 1, type: "host.register", token: TOKEN })));
host.on("message", (data) => {
  const v = JSON.parse(data.toString());
  if (v.type === "host.ready") startMobile();
  if (v.type === "mobile.request") { verdict[v.payload?.type] = "OK"; report(); }
});

function startMobile() {
  const mobile = new WebSocket(RELAY, { perMessageDeflate: false });
  mobile.on("error", (e) => { console.log("mobile ERROR", e.message); process.exit(1); });
  mobile.on("open", () => mobile.send(JSON.stringify({ protocolVersion: 1, id: "auth", type: "auth", token: TOKEN })));
  mobile.on("message", (data) => {
    const v = JSON.parse(data.toString());
    if (v.type === "auth.ready") {
      TYPES.forEach((type, i) => mobile.send(JSON.stringify({
        protocolVersion: 1, id: `t${i}`, type,
        sessionRef: "ref", text: "x", provider: "claude",
      })));
    }
    if (v.ok === false && v.id?.startsWith("t")) {
      verdict[TYPES[Number(v.id.slice(1))]] = `REJECTED (${v.error?.code})`;
      report();
    }
  });
}

function report() {
  if (Object.keys(verdict).length < TYPES.length) return;
  console.log("\nDeployed relay accepts:");
  for (const t of TYPES) console.log(`  ${t.padEnd(18)} ${verdict[t]}`);
  const missing = TYPES.filter((t) => verdict[t] !== "OK");
  console.log(missing.length ? `\n=> OUTDATED: needs restart (${missing.join(", ")} unsupported)` : "\n=> UP TO DATE");
  process.exit(0);
}

setTimeout(() => { console.log("TIMEOUT", verdict); process.exit(3); }, 15_000);

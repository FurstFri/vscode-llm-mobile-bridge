import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeQr, qrToSvg } from "../qr.js";

const PAIRING_PAYLOAD = JSON.stringify({
  protocolVersion: 1,
  connectionId: "9f1c0f2e-2b7a-4a4c-8c1e-2f9a7d6b5c31",
  label: "vscode-llm-mobile-bridge",
  url: "ws://192.168.1.42:8765",
  token: "kUj3Nq7Yb2Wx9Lp4Rt6Zs1Vd8Cf0Gh5Jk2Mn7Qr3Xy",
});

test("upgrades error correction as far as the chosen symbol allows", () => {
  const small = encodeQr("bridge", "L");

  assert.equal(small.version, 1);
  assert.equal(small.size, 21);
  // A six-byte payload leaves room for the strongest level at version 1.
  assert.equal(small.errorCorrection, "H");
  assert.equal(fingerprint(small.modules), "511cc3ef0165b863");
});

test("keeps a pairing payload in a scannable symbol at every requested level", () => {
  const low = encodeQr(PAIRING_PAYLOAD, "L");
  const medium = encodeQr(PAIRING_PAYLOAD, "M");

  assert.equal(low.version, 9);
  assert.equal(low.size, 53);
  assert.equal(low.errorCorrection, "L");
  assert.equal(fingerprint(low.modules), "4cea1ab432b88f41");

  assert.equal(medium.version, 10);
  assert.equal(medium.errorCorrection, "M");
  assert.equal(fingerprint(medium.modules), "1724d45a1ba6f1d8");
});

test("draws the three finder patterns the scanner locks onto", () => {
  const code = encodeQr(PAIRING_PAYLOAD, "M");
  const corners = [[0, 0], [code.size - 7, 0], [0, code.size - 7]] as const;

  for (const [originX, originY] of corners) {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(
          code.modules[originY + y]?.[originX + x],
          ring !== 2,
          `finder module ${originX + x},${originY + y}`,
        );
      }
    }
  }
});

test("renders a self-contained SVG sized to the quiet zone", () => {
  const code = encodeQr("bridge", "L");
  const svg = qrToSvg(code, { moduleSize: 4, quietZone: 2 });

  const side = (code.size + 4) * 4;
  assert.match(svg, new RegExp(`width="${side}" height="${side}"`));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<path fill="#000000" d="M/);
  assert.equal(svg.includes("<script"), false);
});

test("handles multi-byte text and refuses payloads that cannot fit", () => {
  const unicode = encodeQr("Сессия «мост» — вопрос? 日本語", "Q");

  assert.ok(unicode.size >= 21);
  assert.equal(unicode.errorCorrection, "Q");
  assert.throws(() => encodeQr("x".repeat(3_000), "H"), /does not fit/);
});

function fingerprint(modules: readonly (readonly boolean[])[]): string {
  const flat = modules.map((row) => row.map((module) => (module ? "1" : "0")).join("")).join("");
  return createHash("sha256").update(flat).digest("hex").slice(0, 16);
}

import assert from "node:assert/strict";
import test from "node:test";
import { isSyncDevice, newDeviceId, normalizeSyncDevice, shouldClaim } from "../src/sync/device";
import { normalizeSettings } from "../src/settings/settings";

test("only the chosen computer syncs", () => {
	const desktop = { id: "dev-desktop", name: "mainDesktop" };
	assert.equal(isSyncDevice(desktop, "dev-desktop"), true);
	assert.equal(isSyncDevice(desktop, "dev-laptop"), false, "a laptop that got the shared settings file does not sync");
	assert.equal(isSyncDevice({ id: "", name: "" }, ""), false, "turned off everywhere: nobody syncs, not even a blank id");
	assert.equal(isSyncDevice(undefined, "dev-desktop"), false);
});

test("the first computer with a service connected takes the role, and only then", () => {
	assert.equal(shouldClaim(undefined, true), true, "an existing setup from before the switch: this computer takes it");
	assert.equal(shouldClaim(undefined, false), false, "nothing connected: nothing to claim");
	assert.equal(shouldClaim({ id: "dev-desktop", name: "x" }, true), false, "another computer holds it");
	assert.equal(shouldClaim({ id: "", name: "" }, true), false, "the user turned it off: stays off");
});

test("the setting survives a round trip and ignores junk", () => {
	assert.deepEqual(normalizeSettings({ syncDevice: { id: "dev-1", name: "desk" } }).syncDevice, { id: "dev-1", name: "desk" });
	assert.equal(normalizeSettings({}).syncDevice, undefined);
	assert.deepEqual(normalizeSyncDevice({ id: 5 }), { id: "", name: "" });
	assert.equal(normalizeSyncDevice("nonsense"), undefined);
	assert.notEqual(newDeviceId(), newDeviceId());
});

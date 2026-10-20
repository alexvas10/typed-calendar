/**
 * Node's built-in modules, loaded on first use rather than when the plugin
 * loads.
 *
 * Obsidian on iPad has no Node. A top-level import of node:crypto would stop
 * the whole plugin from starting there, while a call that only a computer
 * reaches (a sync, a sign-in) costs nothing on the iPad.
 */

export function nodeCrypto(): typeof import("node:crypto") {
	return require("node:crypto");
}

export function nodeHttp(): typeof import("node:http") {
	return require("node:http");
}

export function nodeHttps(): typeof import("node:https") {
	return require("node:https");
}

/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, window, addEventListener, removeEventListener, document, location, setTimeout, top, XMLHttpRequest, prompt */

this.singlefile.extension.core.content.bootstrap = this.singlefile.extension.core.content.bootstrap || (() => {

	const PUSH_STATE_NOTIFICATION_EVENT_NAME = "single-filez-push-state";

	const singlefile = this.singlefile;

	let unloadListenerAdded, options, autoSaveEnabled, autoSaveTimeout, autoSavingPage, pageAutoSaved;
	singlefile.extension.core.content.updatedResources = {};
	browser.runtime.sendMessage({ method: "autosave.init" }).then(message => {
		options = message.options;
		autoSaveEnabled = message.autoSaveEnabled;
		if (document.readyState == "loading") {
			return new Promise(resolve => document.addEventListener("DOMContentLoaded", () => resolve()));
		}
	}).then(() => {
		refresh();
	});
	browser.runtime.onMessage.addListener(message => onMessage(message));
	browser.runtime.sendMessage({ method: "tabs.init" });
	browser.runtime.sendMessage({ method: "ui.processInit" });
	addEventListener(PUSH_STATE_NOTIFICATION_EVENT_NAME, () => {
		browser.runtime.sendMessage({ method: "tabs.init" });
		browser.runtime.sendMessage({ method: "ui.processInit" });
	});
	if (window == top && location && location.href && location.href.startsWith("file:///") && document.documentElement.dataset.sfz !== undefined) {
		if (document.readyState == "loading") {
			document.addEventListener("DOMContentLoaded", extractFile, false);
		} else {
			extractFile();
		}
	}
	return {};

	async function extractFile() {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", location.href);
		xhr.send();
		xhr.responseType = "arraybuffer";
		xhr.onload = async () => executeBootstrap(xhr.response);
		xhr.onerror = async () => {
			const response = await browser.runtime.sendMessage({ method: "singlefile.fetch", url: location.href });
			executeBootstrap(response.array);
		};
	}

	function executeBootstrap(data) {
		const scriptElement = document.createElement("script");
		scriptElement.textContent = "this.bootstrap([" + (new Uint8Array(data)).toString() + "])";
		document.body.appendChild(scriptElement);
	}

	async function onMessage(message) {
		if (autoSaveEnabled && message.method == "content.autosave") {
			initAutoSavePage(message);
			return {};
		}
		if (message.method == "content.init") {
			options = message.options;
			autoSaveEnabled = message.autoSaveEnabled;
			refresh();
			return {};
		}
		if (message.method == "devtools.resourceCommitted") {
			singlefile.extension.core.content.updatedResources[message.url] = { content: message.content, type: message.type, encoding: message.encoding };
			return {};
		}
		if (message.method == "common.promptValueRequest") {
			browser.runtime.sendMessage({ method: "tabs.promptValueResponse", value: prompt("SingleFileZ: " + message.promptMessage) });
			return {};
		}
	}

	async function initAutoSavePage(message) {
		options = message.options;
		if (document.readyState != "complete") {
			await new Promise(resolve => window.onload = resolve);
		}
		await autoSavePage();
		if (options.autoSaveRepeat) {
			setTimeout(() => {
				if (autoSaveEnabled && !autoSavingPage) {
					pageAutoSaved = false;
					options.autoSaveDelay = 0;
					onMessage(message);
				}
			}, options.autoSaveRepeatDelay * 1000);
		}
	}

	async function autoSavePage() {
		const helper = singlefile.lib.helper;
		if ((!autoSavingPage || autoSaveTimeout) && !pageAutoSaved) {
			autoSavingPage = true;
			if (options.autoSaveDelay && !autoSaveTimeout) {
				await new Promise(resolve => autoSaveTimeout = setTimeout(resolve, options.autoSaveDelay * 1000));
				await autoSavePage();
			} else {
				let frames = [];
				autoSaveTimeout = null;
				if (!options.removeFrames && singlefile.lib.processors.frameTree.content.frames && window.frames && window.frames.length) {
					frames = await singlefile.lib.processors.frameTree.content.frames.getAsync(options);
				}
				if (options.userScriptEnabled && helper.waitForUserScript) {
					await helper.waitForUserScript(helper.ON_BEFORE_CAPTURE_EVENT_NAME);
				}
				const docData = helper.preProcessDoc(document, window, options);
				savePage(docData, frames);
				helper.postProcessDoc(document, docData.markedElements);
				if (options.userScriptEnabled && helper.waitForUserScript) {
					await helper.waitForUserScript(helper.ON_AFTER_CAPTURE_EVENT_NAME);
				}
				pageAutoSaved = true;
				autoSavingPage = false;
			}
		}
	}

	function refresh() {
		if (autoSaveEnabled && options && (options.autoSaveUnload || options.autoSaveLoadOrUnload)) {
			if (!unloadListenerAdded) {
				addEventListener("unload", onUnload);
				addEventListener(PUSH_STATE_NOTIFICATION_EVENT_NAME, onUnload);
				unloadListenerAdded = true;
			}
		} else {
			removeEventListener("unload", onUnload);
			removeEventListener(PUSH_STATE_NOTIFICATION_EVENT_NAME, onUnload);
			unloadListenerAdded = false;
		}
	}

	function onUnload() {
		const helper = singlefile.lib.helper;
		if (!pageAutoSaved || options.autoSaveUnload) {
			let frames = [];
			if (!options.removeFrames && singlefile.lib.processors.frameTree.content.frames && window.frames && window.frames.length) {
				frames = singlefile.lib.processors.frameTree.content.frames.getSync(options);
			}
			if (options.userScriptEnabled && helper.waitForUserScript) {
				helper.waitForUserScript(helper.ON_BEFORE_CAPTURE_EVENT_NAME);
			}
			const docData = helper.preProcessDoc(document, window, options);
			savePage(docData, frames);
		}
	}

	function savePage(docData, frames) {
		const helper = singlefile.lib.helper;
		const updatedResources = singlefile.extension.core.content.updatedResources;
		Object.keys(updatedResources).forEach(url => updatedResources[url].retrieved = false);
		browser.runtime.sendMessage({
			method: "autosave.save",
			taskId: options.taskId,
			content: helper.serialize(document),
			canvases: docData.canvases,
			fonts: docData.fonts,
			stylesheets: docData.stylesheets,
			images: docData.images,
			posters: docData.posters,
			usedFonts: docData.usedFonts,
			shadowRoots: docData.shadowRoots,
			imports: docData.imports,
			referrer: docData.referrer,
			frames: frames,
			url: location.href,
			updatedResources
		});
	}

})();
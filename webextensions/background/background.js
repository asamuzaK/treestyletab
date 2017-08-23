/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

window.addEventListener('DOMContentLoaded', init, { once: true });

async function init() {
  gIsBackground = true;
  window.addEventListener('unload', destroy, { once: true });
  gAllTabs = document.getElementById('all-tabs');
  startObserveTabs();
  await rebuildAll();
  browser.runtime.onMessage.addListener(onMessage);

  await waitUntilCompletelyRestored();
  await loadTreeStructure();
}

function waitUntilCompletelyRestored() {
  log('waitUntilCompletelyRestored');
  return new Promise((aResolve, aReject) => {
    var onNewTabRestored = (() => {
      clearTimeout(timeout);
      log('new restored tab is detected.');
      timeout = setTimeout(resolver, 100);
    });
    browser.tabs.onCreated.addListener(onNewTabRestored);
    var resolver = (() => {
      log('timeout: all tabs are restored.');
      browser.tabs.onCreated.removeListener(onNewTabRestored);
      timeout = resolver = onNewTabRestored = undefined;
      aResolve();
    });
    var timeout = setTimeout(resolver, 500);
  });
}

function destroy() {
  browser.runtime.onMessage.removeListener(onMessage);
  endObserveTabs();
  gAllTabs = undefined;
}

async function rebuildAll() {
  clearAllTabsContainers();
  var windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal']
  });
  windows.forEach((aWindow) => {
    var container = buildTabsContainerFor(aWindow.id);
    for (let tab of aWindow.tabs) {
      container.appendChild(buildTab(tab));
    }
    gAllTabs.appendChild(container);
  });
}


// save/load tree structure

var gTreeStructures = {};

function reserveToSaveTreeStructure(aHint) {
  var container = getTabsContainer(aHint);
  if (!container)
    return;

  if (container.waitingToSaveTreeStructure)
    clearTimeout(container.waitingToSaveTreeStructure);
  container.waitingToSaveTreeStructure = setTimeout((aWindowId) => {
    saveTreeStructure(aWindowId);
  }, 150, container.windowId);
}
async function saveTreeStructure(aWindowId) {
  var container = getTabsContainer(aWindowId);
  if (!container) {
    delete gTreeStructures[aWindowId];
  }
  else {
    container.waitingToSaveTreeStructure = null;
    let window = await browser.windows.get(aWindowId, {
      populate: true,
      windowTypes: ['normal']
    });
    gTreeStructures[aWindowId] = {
      signature: getTabsSignature(window.tabs),
      structure: getTreeStructureFromTabs(getAllTabs(aWindowId))
    };
  }
  var sanitizedStructure = {};
  Object.keys(gTreeStructures).forEach(aId => {
    var structure = gTreeStructures[aId];
    sanitizedStructure[structure.signature] = structure.structure;
  });
  configs.treeStructure = sanitizedStructure;
}

async function loadTreeStructure() {
  var structures = configs.treeStructure;
  if (!structures)
    return;

  log('loadTreeStructure: ', structures);
  var windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal']
  });
  for (let window of windows) {
    let signature = getTabsSignature(window.tabs);
    let structure = structures[signature];
    if (structure) {
      log(`tree information for window ${window.id} is available.`);
      applyTreeStructureToTabs(getAllTabs(window.id), structure);
      browser.runtime.sendMessage({
        type:      kCOMMAND_APPLY_TREE_STRUCTURE,
        windowId:  window.id,
        structure: structure
      });
    }
    else {
      log(`no tree information for the window ${window.id}. `, signature, getTabsSignatureSource(window.tabs));
    }
  }
}

function getTabsSignatureSource(aApiTabs) {
  return aApiTabs.map(aTab => {
    return {
      audible:   aTab.audible,
      incognito: aTab.incognito,
      pinned:    aTab.pinned,
      title:     aTab.title,
      url:       aTab.url
    };
  })
};

function getTabsSignature(aApiTabs) {
  return md5(JSON.stringify(getTabsSignatureSource(aApiTabs)));
}


function onMessage(aMessage, aSender, aRespond) {
  log('onMessage: ', aMessage, aSender);
  switch (aMessage.type) {
    case kCOMMAND_REQUEST_TREE_INFO:
      aRespond({
        tabs: getAllTabs(aMessage.windowId).map(aTab => {
          return {
            id:       aTab.id,
            parent:   aTab.getAttribute(kPARENT),
            children: aTab.getAttribute(kCHILDREN)
          }
        })
      });
      break;
  }
}
/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  wait,
  configs
} from '../common/common.js';

import * as Constants from '../common/constants.js';
import * as Tabs from '../common/tabs.js';
import * as Tree from '../common/tree.js';
import * as MetricsData from '../common/metrics-data.js';
import * as Cache from '../common/cache.js';

import * as Indent from './indent.js';

import EventListenerManager from '../extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('sidebar/sidebar-cache', ...args);
}

export const onRestored = new EventListenerManager();

let mTracking = false;

let mLastWindowCacheOwner;
let mTargetWindow;
let mTabBar;

export function init() {
  mTargetWindow = Tabs.getWindow();
  mTabBar       = document.querySelector('#tabbar');
}

export function startTracking() {
  mTracking = true;
  configs.$addObserver(onConfigChange);
}

export async function getEffectiveWindowCache(options = {}) {
  MetricsData.add('getEffectiveWindowCache start');
  log('getEffectiveWindowCache: start');
  cancelReservedUpdateCachedTabbar(); // prevent to break cache before loading
  let cache;
  let cachedSignature;
  let actualSignature;
  await Promise.all([
    (async () => {
      const apiTabs = await browser.tabs.query({ currentWindow: true });
      mLastWindowCacheOwner = apiTabs[apiTabs.length - 1];
      // We cannot define constants with variables at a time like:
      //   [cache, const tabsDirty, const collapsedDirty] = await Promise.all([
      let tabsDirty, collapsedDirty;
      [cache, tabsDirty, collapsedDirty] = await Promise.all([
        getWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR),
        getWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY),
        getWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY)
      ]);
      cachedSignature = cache && cache.signature;
      log(`getEffectiveWindowCache: got from the owner ${mLastWindowCacheOwner.id}`, {
        cachedSignature, cache, tabsDirty, collapsedDirty
      });
      if (cache &&
          cache.tabs &&
          cachedSignature &&
          cachedSignature != Cache.signatureFromTabsCache(cache.tabbar.contents)) {
        log('getEffectiveWindowCache: cache is broken.', {
          signature: cachedSignature,
          cache:     Cache.signatureFromTabsCache(cache.tabbar.contents)
        });
        cache = cachedSignature = null;
        clearWindowCache();
      }
      if (options.ignorePinnedTabs &&
          cache &&
          cache.tabbar &&
          cache.tabbar.contents &&
          cachedSignature) {
        cache.tabbar.contents = Cache.trimTabsCache(cache.tabbar.contents, cache.tabbar.pinnedTabsCount);
        cachedSignature       = Cache.trimSignature(cachedSignature, cache.tabbar.pinnedTabsCount);
      }
      MetricsData.add('getEffectiveWindowCache get ' + JSON.stringify({
        cache: !!cache,
        version: cache && cache.version
      }));
      log('getEffectiveWindowCache: verify cache (1)', { cache, tabsDirty, collapsedDirty });
      if (cache && cache.version == Constants.kSIDEBAR_CONTENTS_VERSION) {
        log('getEffectiveWindowCache: restore sidebar from cache');
        cache.tabbar.tabsDirty      = tabsDirty;
        cache.tabbar.collapsedDirty = collapsedDirty;
        cache.signature = cachedSignature;
      }
      else {
        log('getEffectiveWindowCache: invalid cache ', cache);
        cache = null;
      }
    })(),
    (async () => {
      actualSignature = await Cache.getWindowSignature(mTargetWindow);
    })()
  ]);

  const signatureMatched = Cache.matcheSignatures({
    actual: actualSignature,
    cached: cachedSignature
  });
  log('getEffectiveWindowCache: verify cache (2)', {
    cache, actualSignature, cachedSignature, signatureMatched
  });
  if (!cache ||
      !signatureMatched) {
    clearWindowCache();
    cache = null;
    log('getEffectiveWindowCache: failed');
    MetricsData.add('getEffectiveWindowCache fail');
  }
  else {
    cache.offset          = actualSignature.replace(cachedSignature, '').trim().split('\n').filter(part => !!part).length;
    cache.actualSignature = actualSignature;
    log('getEffectiveWindowCache: success ');
    MetricsData.add('getEffectiveWindowCache success');
  }

  return cache;
}

export async function restoreTabsFromCache(cache, params = {}) {
  const offset    = params.offset || 0;
  const container = Tabs.getTabsContainer(mTargetWindow);
  if (offset <= 0) {
    if (container)
      container.parentNode.removeChild(container);
    mTabBar.setAttribute('style', cache.style);
  }

  let restored = Cache.restoreTabsFromCacheInternal({
    windowId:     mTargetWindow,
    tabs:         params.tabs,
    offset:       offset,
    cache:        cache.contents,
    shouldUpdate: cache.tabsDirty
  });

  if (restored) {
    try {
      const masterStructure = (await browser.runtime.sendMessage({
        type:     Constants.kCOMMAND_PULL_TREE_STRUCTURE,
        windowId: mTargetWindow
      })).structure;
      const allTabs = Tabs.getAllTabs();
      const currentStructrue = Tree.getTreeStructureFromTabs(allTabs);
      if (currentStructrue.map(item => item.parent).join(',') != masterStructure.map(item => item.parent).join(',')) {
        log(`restoreTabsFromCache: failed to restore tabs, mismatched tree for ${mTargetWindow}. fallback to regular way.`);
        restored = false;
        const container = Tabs.getTabsContainer(mTargetWindow);
        if (container)
          container.parentNode.removeChild(container);
      }
      if (restored && cache.collapsedDirty) {
        const structure = currentStructrue.reverse();
        allTabs.reverse().forEach((tab, index) => {
          Tree.collapseExpandSubtree(tab, {
            collapsed: structure[index].collapsed,
            justNow:   true
          });
        });
      }
      onRestored.dispatch();
    }
    catch(e) {
      log(String(e), e.stack);
      throw e;
    }
  }

  return restored;
}

function updateWindowCache(key, value) {
  if (!mLastWindowCacheOwner ||
      !Tabs.getTabById(mLastWindowCacheOwner))
    return;
  if (value === undefined) {
    //log('updateWindowCache: delete cache from ', mLastWindowCacheOwner, key);
    //return browser.sessions.removeWindowValue(mLastWindowCacheOwner, key);
    return browser.sessions.removeTabValue(mLastWindowCacheOwner.id, key);
  }
  else {
    //log('updateWindowCache: set cache for ', mLastWindowCacheOwner, key);
    //return browser.sessions.setWindowValue(mLastWindowCacheOwner, key, value);
    return browser.sessions.setTabValue(mLastWindowCacheOwner.id, key, value);
  }
}

function clearWindowCache() {
  log('clearWindowCache ', { stack: new Error().stack });
  updateWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR);
  updateWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  updateWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY);
}

export function markWindowCacheDirty(akey) {
  if (markWindowCacheDirty.timeout)
    clearTimeout(markWindowCacheDirty.timeout);
  markWindowCacheDirty.timeout = setTimeout(() => {
    markWindowCacheDirty.timeout = null;
    updateWindowCache(akey, true);
  }, 250);
}

async function getWindowCache(key) {
  if (!mLastWindowCacheOwner)
    return null;
  //return browser.sessions.getWindowValue(mLastWindowCacheOwner, key);
  return browser.sessions.getTabValue(mLastWindowCacheOwner.id, key);
}

function getWindowCacheOwner() {
  const tab = Tabs.getLastTab();
  return tab && tab.apiTab;
}

export async function reserveToUpdateCachedTabbar() {
  if (!mTracking ||
      !configs.useCachedTree)
    return;

  // If there is any opening (but not resolved its unique id yet) tab,
  // we are possibly restoring tabs. To avoid cache breakage before
  // restoration, we must wait until we know whether there is any other
  // restoring tab or not.
  if (Tabs.hasCreatingTab())
    await Tabs.waitUntilAllTabsAreCreated();

  const container = Tabs.getTabsContainer(mTargetWindow);
  if (container.allTabsRestored)
    return;

  log('reserveToUpdateCachedTabbar ', { stack: new Error().stack });
  // clear dirty cache
  clearWindowCache();

  if (updateCachedTabbar.waiting)
    clearTimeout(updateCachedTabbar.waiting);
  updateCachedTabbar.waiting = setTimeout(() => {
    delete updateCachedTabbar.waiting;
    updateCachedTabbar();
  }, 500);
}

function cancelReservedUpdateCachedTabbar() {
  if (updateCachedTabbar.waiting) {
    clearTimeout(updateCachedTabbar.waiting);
    delete updateCachedTabbar.waiting;
  }
}

async function updateCachedTabbar() {
  if (!configs.useCachedTree)
    return;
  if (Tabs.hasCreatingTab())
    await Tabs.waitUntilAllTabsAreCreated();
  const container = Tabs.getTabsContainer(mTargetWindow);
  const signature = await Cache.getWindowSignature(mTargetWindow);
  if (container.allTabsRestored)
    return;
  log('updateCachedTabbar ', { stack: new Error().stack });
  mLastWindowCacheOwner = getWindowCacheOwner(mTargetWindow);
  updateWindowCache(Constants.kWINDOW_STATE_CACHED_SIDEBAR, {
    version: Constants.kSIDEBAR_CONTENTS_VERSION,
    tabbar: {
      contents:        Tabs.allTabsContainer.innerHTML,
      style:           mTabBar.getAttribute('style'),
      pinnedTabsCount: Tabs.getPinnedTabs(container).length
    },
    indent: Indent.getCacheInfo(),
    signature
  });
}


Tabs.onFaviconUpdated.addListener((_tab, _url) => {
  wait(0).then(() => {
    markWindowCacheDirty(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  });
});

Tabs.onUpdated.addListener((_tab, _url) => {
  wait(0).then(() => {
    markWindowCacheDirty(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  });
});

Tabs.onLabelUpdated.addListener(_tab => {
  wait(0).then(() => {
    markWindowCacheDirty(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  });
});

Tabs.onParentTabUpdated.addListener(async _tab => {
  wait(0).then(() => {
    markWindowCacheDirty(Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  });
});

Tabs.onCreated.addListener((_tab, _info) => {
  wait(0).then(() => {
    reserveToUpdateCachedTabbar();
  });
});

Tabs.onRemoved.addListener(async (_tab, _info) => {
  // "Restore Previous Session" closes some tabs at first, so we should not clear the old cache yet.
  // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
  await wait(0);
  if (configs.animation) {
    await wait(configs.animation ? configs.collapseDuration : 0);
    await reserveToUpdateCachedTabbar();
  }
});

Tabs.onMoved.addListener((_tab, _info) => {
  reserveToUpdateCachedTabbar();
});

Tree.onLevelChanged.addListener(_tab => {
  wait(0).then(() => {
  // "Restore Previous Session" closes some tabs at first and it causes tree changes, so we should not clear the old cache yet.
  // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToUpdateCachedTabbar();
  });
});

Tabs.onDetached.addListener(async (tab, _info) => {
  if (!Tabs.ensureLivingTab(tab))
    return;
  await wait(0);
  reserveToUpdateCachedTabbar();
});

Tree.onAttached.addListener((_tab, _info) => {
  wait(0).then(() => {
  // "Restore Previous Session" closes some tabs at first and it causes tree changes, so we should not clear the old cache yet.
  // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToUpdateCachedTabbar();
  });
});

Tree.onDetached.addListener((_tab, _info) => {
  wait(0).then(() => {
  // "Restore Previous Session" closes some tabs at first and it causes tree changes, so we should not clear the old cache yet.
  // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToUpdateCachedTabbar();
  });
});

Tabs.onPinned.addListener(_tab => {
  reserveToUpdateCachedTabbar();
});

Tabs.onUnpinned.addListener(_tab => {
  reserveToUpdateCachedTabbar();
});

Tabs.onShown.addListener(_tab => {
  reserveToUpdateCachedTabbar();
});

Tabs.onHidden.addListener(_tab => {
  reserveToUpdateCachedTabbar();
});

function onConfigChange(changedKey) {
  switch (changedKey) {
    case 'useCachedTree':
      if (!configs[changedKey]) {
        reserveToUpdateCachedTabbar();
      }
      else {
        clearWindowCache();
        location.reload();
      }
      break;
  }
}

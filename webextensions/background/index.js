/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
import '../extlib/TabIdFixer.js';

import {
  log
} from '../common/common.js';

import * as MetricsData from '../common/metrics-data.js';

import * as Background from './background.js';
import './handle-new-tabs.js';
import './handle-removed-tabs.js';
import './handle-tab-focus.js';
import './handle-moved-tabs.js';
import './handle-tree-changes.js';
import './handle-group-tabs.js';
import './handle-misc.js';
import './context-menu.js';

import './tab-context-menu.js';

log.context = 'BG';

MetricsData.add('index: Loaded');

window.addEventListener('DOMContentLoaded', Background.init, { once: true });

window.dumpMetricsData = () => {
  return MetricsData.toString();
};
window.dumpLogs = () => {
  return log.logs.join('\n');
};

// for old debugging method
window.log = log;
window.gMetricsData = MetricsData;

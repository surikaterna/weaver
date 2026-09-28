import { deepSet } from "@weaver-conf/config-engine";
import type { ConfigSnapshot } from "@weaver-conf/weaver-client";

const CORE_DEFAULTS: Record<string, unknown> = {
  "app.ui.theme": "light",
  "app.ui.language": "en",
  "app.ui.sidebar.collapsed": false,
  "app.ui.font.size": 14,
  "app.ui.font.family": "Inter",
  "app.feature.analytics.enabled": true,
  "app.feature.notifications.enabled": true,
  "app.feature.notifications.frequency": "daily",
  "app.network.timeout.ms": 5000,
  "app.network.retry.count": 3,
};

const APP_DEFAULTS: Record<string, unknown> = {
  "app.ui.theme": "system",
  "app.ui.sidebar.collapsed": true,
  "app.feature.analytics.enabled": false,
  "app.network.timeout.ms": 10000,
};

const COUNTRY_GB_DEFAULTS: Record<string, unknown> = {
  "app.ui.language": "en",
  "app.ui.theme": "dark",
  "app.network.timeout.ms": 8000,
};

const COUNTRY_NL_DEFAULTS: Record<string, unknown> = {
  "app.ui.language": "nl",
  "app.network.timeout.ms": 12000,
};

const LOCATION_GBDVR_DEFAULTS: Record<string, unknown> = {
  "app.feature.notifications.frequency": "hourly",
  "app.network.retry.count": 5,
};

const LOCATION_FRCQF_DEFAULTS: Record<string, unknown> = {
  "app.ui.language": "fr",
  "app.ui.theme": "light",
  "app.network.timeout.ms": 15000,
  "app.feature.notifications.frequency": "daily",
};

const LOCATION_NLEUR_DEFAULTS: Record<string, unknown> = {
  "app.feature.notifications.frequency": "realtime",
  "app.feature.analytics.enabled": true,
};

function nestedEntries(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values))
    deepSet(entries, key, value);
  return entries;
}

const BASE_DEFAULTS = { ...CORE_DEFAULTS, ...APP_DEFAULTS };

function immutableEntries(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const entries = nestedEntries(values);
  function freeze(node: object): void {
    for (const child of Object.values(node))
      if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(node);
  }
  freeze(entries);
  return entries;
}

export const CORE_SEED = immutableEntries(CORE_DEFAULTS);
export const APP_SEED = immutableEntries(APP_DEFAULTS);

/** Snapshot for createLocalTransport — base entries + scoped overrides. */
export const SEED_SNAPSHOT: ConfigSnapshot = {
  entries: nestedEntries(BASE_DEFAULTS),
  revision: "demo-seed-v1",
  timestamp: new Date().toISOString(),
  scopes: {
    "country:GB": nestedEntries({ ...BASE_DEFAULTS, ...COUNTRY_GB_DEFAULTS }),
    "country:NL": nestedEntries({ ...BASE_DEFAULTS, ...COUNTRY_NL_DEFAULTS }),
    "country:GB/location:GBDVR": nestedEntries({
      ...BASE_DEFAULTS,
      ...COUNTRY_GB_DEFAULTS,
      ...LOCATION_GBDVR_DEFAULTS,
    }),
    "country:FR/location:FRCQF": nestedEntries({
      ...BASE_DEFAULTS,
      ...LOCATION_FRCQF_DEFAULTS,
    }),
    "country:NL/location:NLEUR": nestedEntries({
      ...BASE_DEFAULTS,
      ...COUNTRY_NL_DEFAULTS,
      ...LOCATION_NLEUR_DEFAULTS,
    }),
  },
};

export const ALL_KEYS: string[] = [
  ...new Set([
    ...Object.keys(CORE_DEFAULTS),
    ...Object.keys(APP_DEFAULTS),
    ...Object.keys(COUNTRY_GB_DEFAULTS),
    ...Object.keys(COUNTRY_NL_DEFAULTS),
    ...Object.keys(LOCATION_GBDVR_DEFAULTS),
    ...Object.keys(LOCATION_FRCQF_DEFAULTS),
    ...Object.keys(LOCATION_NLEUR_DEFAULTS),
  ]),
];

/**
 * Centralized application configuration constants.
 *
 * All hardcoded values from across the codebase are defined here
 * for single-point-of-change and consistency.
 */
export const Config = {
  /** ── MCP / Local API Server ── */
  MCP: {
    PORT: 17800,
    LOCAL_API_VERSION: '1.2.0',
    /** Max request body size (1 MB). */
    MAX_BODY_BYTES: 1024 * 1024,
    /** Connection idle timeout (ms). */
    IDLE_TIMEOUT_MS: 30_000,
    /** Access-Control-Allow-Origin for browser extension CORS. */
    CORS_ORIGIN: '*'
  },

  /** ── Download Engine ── */
  ENGINE: {
    /** Default concurrency per task. */
    DEFAULT_CONCURRENCY: 3,
    /** Max segments to split a single file into. */
    MAX_SEGMENTS: 16,
    /** Min segment size (bytes) — below this, don't split further. */
    MIN_SEGMENT_BYTES: 512 * 1024, // 512 KB
    /** Default segment size when no Content-Length. */
    DEFAULT_SEGMENT_BYTES: 1024 * 1024, // 1 MB
    /** Max retries per segment. */
    MAX_RETRIES: 3,
    /** Write buffer size for disk I/O coalescing. */
    WRITE_BUFFER_SIZE: 256 * 1024, // 256 KB
    /** Bandwidth sample interval (ms) — avoid noise from tiny chunks. */
    BW_SAMPLE_MIN_INTERVAL_MS: 50
  },

  /** ── GitHub Mirror URLs (for GitHub releases/assets) ── */
  GITHUB_MIRRORS: [
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.com/',
    'https://ghfast.top/'
  ],

  /** ── Speed Limits ── */
  SPEED: {
    /** Unlimited sentinel value. */
    UNLIMITED: 0,
    /** Default per-task limit (0 = follow global). */
    DEFAULT_TASK_LIMIT: 0,
    /** Default global limit (0 = no limit). */
    DEFAULT_GLOBAL_LIMIT: 0
  },

  /** ── BitTorrent ── */
  BT: {
    /** Default listen port for incoming peer connections. */
    DEFAULT_LISTEN_PORT: 6881,
    /** Default max peers per torrent. */
    DEFAULT_MAX_PEERS: 50,
    /** DHT node bucket size. */
    DHT_BUCKET_SIZE: 8,
    /** UPnP lease duration (seconds). */
    UPNP_LEASE_DURATION: 3600
  },

  /** ── Database ── */
  DB: {
    NAME: 'fluxdown.db',
    TABLE_NAME: 'download_tasks',
    SETTINGS_STORE: 'fluxdown_settings',
    BT_SETTINGS_STORE: 'fluxdown_bt_settings'
  },

  /** ── UI / UX ── */
  UI: {
    /** Progress poll interval (ms) for MCP task list. */
    POLL_INTERVAL_MS: 1000,
    /** Toast debounce interval (ms). */
    TOAST_DEBOUNCE_MS: 10_000,
    /** Max logs kept in LogCollector. */
    MAX_LOGS: 500,
    /** Max RSS items to keep per subscription. */
    MAX_RSS_ITEMS: 100,
    /** RSS default poll interval (minutes). */
    RSS_DEFAULT_INTERVAL_MIN: 30
  },

  /** ── File Paths ── */
  PATHS: {
    /** Default download directory name (under app internal storage or sandbox). */
    DEFAULT_DOWNLOAD_DIR: 'Downloads/FluxDown',
    /** Temp file suffix for in-progress downloads. */
    TEMP_SUFFIX: '.fluxdown.tmp'
  }
} as const;

/**
 * Returns a comma-separated list of required permissions for display/logging.
 */
export function requiredPermissions(): string[] {
  return [
    'ohos.permission.INTERNET',
    'ohos.permission.GET_NETWORK_INFO',
    'ohos.permission.KEEP_BACKGROUND_RUNNING',
    'ohos.permission.GET_BUNDLE_INFO'
  ];
}

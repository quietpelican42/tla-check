/** A location of a top-level `await` (or `for await`) expression. */
export interface TlaLocation {
  /** `file://` URL of the module containing the await. */
  url: string;
  line: number;
  column: number;
  /** The source line the await appears on, trimmed. */
  sourceLine: string;
}

/** One hop in the import chain from an entry point to a top-level await. */
export interface ChainLink {
  /** `file://` URL of the module at this hop. */
  url: string;
  /** How this module was reached from the previous hop. `entry` for the first link. */
  via: 'entry' | 'import' | 'export-from';
  /** The specifier that was resolved to reach this module (absent for `entry`). */
  specifier?: string;
}

export type EntryStatus = 'ok' | 'top-level-await' | 'unresolved' | 'unsupported';

export interface EntryResult {
  /** The subpath, e.g. `.` or `./feature`. */
  specifier: string;
  /** The export condition that matched when resolving this subpath for require(), e.g. `require`, `default`, `main`. */
  condition: string;
  /** Absolute path of the resolved entry file, if resolution succeeded. */
  resolvedFile?: string;
  status: EntryStatus;
  /**
   * true: require() would succeed. false: require() would throw
   * ERR_REQUIRE_ASYNC_MODULE. undefined: could not be determined (an
   * unresolved dependency blocked the walk before a verdict was reached).
   */
  requirable?: boolean;
  /** Every top-level await found in the reachable graph, each with its chain from this entry. */
  awaits: Array<{ location: TlaLocation; chain: ChainLink[] }>;
  /** Non-fatal problems hit while walking the graph from this entry (unresolved specifiers, unsupported files). */
  warnings: string[];
  /** Set when `status` is `unresolved` or `unsupported` and there is nothing else to say. */
  error?: string;
}

export interface PackageReport {
  dir: string;
  name?: string;
  version?: string;
  conditions: string[];
  entries: EntryResult[];
  /** true only if every entry is `ok`. */
  clean: boolean;
  /** true if any entry has a confirmed top-level-await finding. */
  hasFindings: boolean;
  /** true if the package itself could not be read/analysed at all. */
  fatalError?: string;
}

export interface InstalledDependencyResult {
  name: string;
  version?: string;
  dir: string;
  report?: PackageReport;
  /** Set when the dependency itself could not be analysed (bad package.json, missing dir, etc.). */
  error?: string;
}

export interface InstalledReport {
  dir: string;
  dependencies: InstalledDependencyResult[];
  clean: boolean;
  hasFindings: boolean;
  fatalError?: string;
}

export interface CheckOptions {
  /** Extra export conditions to consider active, beyond `node`, `require` and `default`. */
  conditions?: string[];
}
